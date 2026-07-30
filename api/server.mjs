import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import maxmind from "maxmind";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4320);
const host = process.env.HOST || "127.0.0.1";
const cacheTtl = Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000);
const requestWindowMs = 60_000;
const requestLimit = Number(process.env.RATE_LIMIT || 120);
const cache = new Map();
const rate = new Map();

const dbIpPath = process.env.DBIP_MMDB_PATH || path.join(root, "data", "dbip-city-lite.mmdb");
const dbIpAsnPath = process.env.DBIP_ASN_MMDB_PATH || path.join(root, "data", "dbip-asn-lite.mmdb");
const ip2LocationPath = process.env.IP2LOCATION_DB_PATH || path.join(root, "data", "IP2LOCATION.BIN");
let dbIpLookup;
let dbIpAsnLookup;
let ip2Location;

const countryNames = {
  AF: "Afghanistan", AL: "Albania", DZ: "Algeria", AR: "Argentina", AU: "Australia", AT: "Austria",
  BE: "Belgium", BR: "Brazil", BG: "Bulgaria", CA: "Canada", CL: "Chile", CN: "China", CO: "Colombia",
  HR: "Croatia", CY: "Cyprus", CZ: "Czechia", DK: "Denmark", EG: "Egypt", EE: "Estonia", FI: "Finland",
  FR: "France", GE: "Georgia", DE: "Germany", GR: "Greece", HK: "Hong Kong", HU: "Hungary", IS: "Iceland",
  IN: "India", ID: "Indonesia", IE: "Ireland", IL: "Israel", IT: "Italy", JP: "Japan", KZ: "Kazakhstan",
  KR: "South Korea", LV: "Latvia", LT: "Lithuania", LU: "Luxembourg", MY: "Malaysia", MX: "Mexico",
  MD: "Moldova", MC: "Monaco", MN: "Mongolia", ME: "Montenegro", MA: "Morocco", NL: "Netherlands",
  NZ: "New Zealand", NG: "Nigeria", NO: "Norway", PK: "Pakistan", PE: "Peru", PH: "Philippines",
  PL: "Poland", PT: "Portugal", RO: "Romania", RU: "Russia", SA: "Saudi Arabia", RS: "Serbia",
  SG: "Singapore", SK: "Slovakia", SI: "Slovenia", ZA: "South Africa", ES: "Spain", SE: "Sweden",
  CH: "Switzerland", TW: "Taiwan", TJ: "Tajikistan", TH: "Thailand", TR: "Türkiye", TM: "Turkmenistan",
  UA: "Ukraine", AE: "United Arab Emirates", GB: "United Kingdom", US: "United States", UZ: "Uzbekistan",
  VN: "Vietnam",
};

function log(message) {
  process.stdout.write(`[ipflag-api] ${message}${os.EOL}`);
}

async function loadSources() {
  try {
    dbIpLookup = await maxmind.open(dbIpPath);
    log(`DB-IP source loaded: ${dbIpPath}`);
  } catch (error) {
    log(`DB-IP source unavailable at ${dbIpPath}: ${error.message}`);
  }
  try {
    dbIpAsnLookup = await maxmind.open(dbIpAsnPath);
    log(`DB-IP ASN source loaded: ${dbIpAsnPath}`);
  } catch (error) {
    log(`DB-IP ASN source unavailable at ${dbIpAsnPath}: ${error.message}`);
  }

  if (process.env.IP2LOCATION_DB_PATH) {
    try {
      const module = await import("ip2location-nodejs");
      ip2Location = new module.default();
      await ip2Location.openAsync(ip2LocationPath);
      log(`IP2Location source loaded: ${ip2LocationPath}`);
    } catch (error) {
      log(`IP2Location source unavailable at ${ip2LocationPath}: ${error.message}`);
    }
  }
}

function normalizeIp(value) {
  const ip = value.trim().replace(/^\[|\]$/g, "");
  return net.isIP(ip) ? ip : null;
}

function cleanDomain(value) {
  const domain = decodeURIComponent(value).trim().replace(/\.$/, "").toLowerCase();
  if (domain.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    return null;
  }
  return domain;
}

function asText(value) {
  return value === undefined || value === null ? "" : String(value);
}

function fromDbIp(ip) {
  if (!dbIpLookup) return null;
  const record = dbIpLookup.get(ip);
  if (!record) return null;
  const country = record.country || {};
  const location = record.location || {};
  const code = asText(country.iso_code).toUpperCase();
  return {
    ip,
    continent: asText(record.continent?.code),
    country_code: code,
    country: asText(country.names?.en) || countryNames[code] || code,
    region: asText(record.subdivisions?.[0]?.names?.en),
    city: asText(record.city?.names?.en),
    latitude: location.latitude ?? null,
    longitude: location.longitude ?? null,
    source: "db-ip-lite",
  };
}

function fromDbIpAsn(ip) {
  const record = dbIpAsnLookup?.get(ip);
  if (!record) return null;
  return {
    ip,
    asn: record.autonomous_system_number ? `AS${record.autonomous_system_number}` : "",
    isp: asText(record.autonomous_system_organization),
    source: "db-ip-lite-asn",
  };
}

function fromIp2Location(ip) {
  if (!ip2Location) return null;
  const result = ip2Location.getAll(ip);
  if (!result || !result.countryShort) return null;
  return {
    ip,
    continent: asText(result.continent),
    country_code: asText(result.countryShort).toUpperCase(),
    country: asText(result.countryLong),
    region: asText(result.region),
    city: asText(result.city),
    postal_code: asText(result.zipCode),
    latitude: result.latitude ?? null,
    longitude: result.longitude ?? null,
    timezone: asText(result.timeZone),
    asn: asText(result.asn),
    isp: asText(result.isp),
    source: "ip2location",
  };
}

function merge(primary, secondary) {
  if (!primary && !secondary) return null;
  const result = { ...(secondary || {}) };
  for (const [key, value] of Object.entries(primary || {})) {
    if (value !== undefined && value !== null && value !== "") result[key] = value;
  }
  for (const key of ["continent", "country_code", "country", "region", "city", "postal_code", "latitude", "longitude", "timezone", "asn", "isp"]) {
    if (result[key] === "" || result[key] === undefined || result[key] === null) delete result[key];
  }
  return result;
}

async function lookupIp(ip) {
  const cached = cache.get(ip);
  if (cached && cached.expires > Date.now()) return cached.value;
  const result = merge(fromIp2Location(ip), merge(fromDbIp(ip), fromDbIpAsn(ip)));
  if (!result) return null;
  result.ip = ip;
  result.country_code = asText(result.country_code).toUpperCase();
  result.country = result.country || countryNames[result.country_code] || result.country_code;
  result.flag = result.country_code ? `https://flagcdn.io/${result.country_code.toLowerCase()}.svg` : null;
  result.db_updated = process.env.DBIP_RELEASE || "monthly";
  cache.set(ip, { value: result, expires: Date.now() + cacheTtl });
  return result;
}

async function resolveDomain(domain) {
  const addresses = await dns.lookup(domain, { all: true, verbatim: true });
  const preferred = addresses.find((entry) => entry.family === 4) || addresses[0];
  return preferred?.address || null;
}

function rateLimit(request) {
  const key = request.headers["cf-connecting-ip"] || request.headers["x-forwarded-for"]?.split(",")[0].trim() || request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rate.get(key);
  if (!entry || now - entry.started > requestWindowMs) {
    rate.set(key, { started: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= requestLimit;
}

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

async function handle(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    response.end();
    return;
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "method_not_allowed" });
  if (!rateLimit(request)) return sendJson(response, 429, { error: "rate_limited", message: "Too many requests. Try again shortly." }, { "Retry-After": "60" });
  if (url.pathname === "/" || url.pathname === "/health") {
    return sendJson(response, 200, { ok: true, service: "IP Flag Geo API", sources: { ip2location: Boolean(ip2Location), db_ip: Boolean(dbIpLookup), db_ip_asn: Boolean(dbIpAsnLookup) } });
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const endpoint = parts[0];
  const value = parts.length > 1 ? parts.slice(1).join("/") : url.searchParams.get(endpoint);
  if (!value || parts.length > 2 || !["ip", "domain"].includes(endpoint)) {
    return sendJson(response, 404, { error: "not_found", endpoints: ["/ip/:ip", "/domain/:domain"] });
  }

  let ip;
  let query;
  try {
    if (endpoint === "ip") {
      ip = normalizeIp(value);
      query = ip;
      if (!ip) return sendJson(response, 400, { error: "invalid_ip" });
    } else {
      query = cleanDomain(value);
      if (!query) return sendJson(response, 400, { error: "invalid_domain" });
      ip = await resolveDomain(query);
      if (!ip) return sendJson(response, 404, { error: "domain_not_resolved", domain: query });
    }
    const result = await lookupIp(ip);
    if (!result) return sendJson(response, 404, { error: "ip_not_found", ip, query });
    return sendJson(response, 200, { ...result, query, query_type: endpoint });
  } catch (error) {
    log(`${endpoint} lookup failed for ${value}: ${error.message}`);
    return sendJson(response, 502, { error: "lookup_failed", message: "The lookup service could not resolve this request." });
  }
}

await loadSources();
http.createServer((request, response) => handle(request, response)).listen(port, host, () => log(`listening on http://${host}:${port}`));
