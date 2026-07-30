const $ = (id) => document.getElementById(id);
const API_BASE = 'https://api.ipflag.io/';
const CACHE_TTL = 10 * 60 * 1000;
const SSL_CACHE_TTL = 6 * 60 * 60 * 1000;
const TILE_HOST = 'https://map.bluecdn.com/raster';
const TILE_ZOOM = 4; // 国家级视野，2x2 拼接后接近 zoom 5 城市级
const FLAG_STYLE_KEY = 'flagStyle';
const DEFAULT_FLAG_STYLE = 'rect';

const COUNTRY_ZH = {
  US: '美国', CN: '中国', SG: '新加坡', JP: '日本', KR: '韩国',
  HK: '中国香港', MO: '中国澳门', TW: '中国台湾', GB: '英国',
  DE: '德国', FR: '法国', RU: '俄罗斯', ES: '西班牙', IN: '印度',
  AU: '澳大利亚', CA: '加拿大', NL: '荷兰', TR: '土耳其',
};

const I18N = {
  en: {
    retry: 'Retry',
    domain: 'Domain',
    timezone: 'Time zone',
    checkIpReputation: 'Check IP reputation',
    flagSource: 'Flag icon source',
    openInMaps: 'Open in Maps',
    copy: 'Copy',
    unsupportedPage: 'This page cannot be checked',
    resolveFailed: 'Unable to resolve server IP. Check your network and try again.',
    fetchFailed: 'Unable to fetch IP information',
    sslDaysLeft: 'Expires in {days}d',
    sslExpired: 'Expired',
    sslUnknown: 'Unavailable',
    sslIssuer: 'Issuer',
    sslValidTo: 'Valid to',
    sslHost: 'Host',
    sourceConnection: 'Conn',
    sourceDns: 'DNS',
    locationSeparator: ', ',
  },
  zh: {
    retry: '重试',
    domain: '域名',
    timezone: '时区',
    checkIpReputation: '检测 IP 纯净度',
    flagSource: '国旗图标来源',
    openInMaps: '从地图打开',
    copy: '复制',
    unsupportedPage: '当前页面不支持查询',
    resolveFailed: '无法解析服务器 IP，请检查网络后重试',
    fetchFailed: '无法获取 IP 信息',
    sslDaysLeft: '{days} 天后到期',
    sslExpired: '已过期',
    sslUnknown: '无法获取',
    sslIssuer: '签发者',
    sslValidTo: '有效期至',
    sslHost: '域名',
    sourceConnection: '连接',
    sourceDns: 'DNS',
    locationSeparator: '，',
  },
};

const LOCALE = /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
let currentMapCoords = null;
let lastRenderData = null;
let currentCopyValues = {};
let lastSslData = null;

function t(key) {
  return I18N[LOCALE][key] || I18N.en[key] || key;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function applyI18n() {
  document.documentElement.lang = LOCALE === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const value = t(el.dataset.i18nTitle);
    el.title = value;
    el.setAttribute('aria-label', value);
  });
}

// 跟随系统深浅色：浅色 light，深色 dark。
function isDarkMode() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getTileStyle() {
  return isDarkMode() ? 'dark' : 'light';
}

function isSpecialPage(url) {
  return !url || /^(chrome|chrome-extension|edge|about|file|devtools|browser):/.test(url);
}

function getApiUrl(ip) {
  return `${API_BASE}ip/${encodeURIComponent(ip)}`;
}

function getDomainApiUrl(hostname) {
  return `${API_BASE}domain/${encodeURIComponent(hostname)}`;
}

// 把 IP Flag API 字段统一到 popup 内部 schema。
function normalizeData(raw, ip) {
  const asn = raw.asn ? String(raw.asn) : '';
  return {
    ip: raw.ip || ip,
    country: raw.country,
    country_code: raw.country_code,
    city: raw.city,
    region: raw.region,
    province: raw.province || raw.region,
    latitude: raw.latitude,
    longitude: raw.longitude,
    timezone: raw.timezone,
    isp: raw.isp,
    asn: asn ? (asn.toUpperCase().startsWith('AS') ? asn.toUpperCase() : `AS${asn}`) : undefined,
    ssl: raw.ssl || null,
  };
}

async function fetchGeoJson(ip) {
  const res = await fetch(getApiUrl(ip));
  if (!res.ok) return null;
  const raw = await res.json();
  return raw.ip ? raw : null;
}

async function fetchDomainJson(hostname) {
  const res = await fetch(getDomainApiUrl(hostname));
  if (!res.ok) return null;
  const raw = await res.json();
  return raw && raw.ip ? raw : null;
}

async function fetchSslJson(hostname) {
  const res = await fetch(getDomainApiUrl(hostname));
  if (!res.ok) return null;
  const raw = await res.json();
  return raw && typeof raw === 'object' ? raw.ssl || null : null;
}

async function fetchSslInfo(hostname) {
  const key = `ssl_${hostname}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < SSL_CACHE_TTL) {
    return store[key].data;
  }

  const data = await fetchSslJson(hostname);
  if (data) {
    await chrome.storage.session.set({ [key]: { data, ts: Date.now() } });
  }
  return data;
}

// 从 ASN 字段提取 ASN 编号
// "AS37963 Hangzhou Alibaba Advertising Co.,Ltd." → "AS37963"
// "AS15169" → "AS15169"
function extractAsn(asString) {
  if (!asString) return '--';
  const m = asString.match(/^(AS\s*\d+)/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, '') : asString;
}

function isIPv4(ip) {
  return typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

// 用 Cloudflare 公共 DoH 解析 hostname → IPv4（仅 A 记录）
async function resolveIpDoH(hostname) {
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { 'Accept': 'application/dns-json' } }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const a = data.Answer?.find(x => x.type === 1);
    return a?.data || null;
  } catch {
    return null;
  }
}

// 优先 IPv4：已有 v4 直接用，否则 DoH 查 A 记录，最后才回退 v6
async function getPreferredIp(hostname, cachedIp, cachedSource) {
  if (cachedIp && isIPv4(cachedIp)) {
    return { ip: cachedIp, source: cachedSource || 'connection' };
  }

  const v4 = await resolveIpDoH(hostname);
  if (v4) {
    await chrome.storage.session.set({
      [`ip_${hostname}`]: v4,
      [`ip_source_${hostname}`]: 'dns',
    });
    return { ip: v4, source: 'dns' };
  }

  return cachedIp ? { ip: cachedIp, source: cachedSource || 'connection' } : null;
}

function lonToWorldX(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z) * 256;
}
function latToWorldY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z) * 256;
}

function getMapTiles(lat, lon, width, height) {
  const style = getTileStyle();
  const worldX = lonToWorldX(lon, TILE_ZOOM);
  const worldY = latToWorldY(lat, TILE_ZOOM);
  const centerTileX = Math.floor(worldX / 256);
  const centerTileY = Math.floor(worldY / 256);
  const startX = centerTileX - 1;
  const startY = centerTileY - 1;
  const offsetX = Math.round(width / 2 - (worldX - startX * 256));
  const offsetY = Math.round(height / 2 - (worldY - startY * 256));
  const tiles = [];
  const maxTile = Math.pow(2, TILE_ZOOM);

  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const x = (startX + dx + maxTile) % maxTile;
      const y = startY + dy;
      if (y < 0 || y >= maxTile) continue;
      const url = `${TILE_HOST}/${style}/${TILE_ZOOM}/${x}/${y}.png`;
      tiles.push({
        url,
        left: offsetX + dx * 256,
        top: offsetY + dy * 256,
      });
    }
  }
  return tiles;
}

function getFlagCode(data) {
  const code = (data.country_code || '').toUpperCase();
  if (code === 'CN') {
    const place = [data.country, data.region, data.province, data.city].filter(Boolean).join(' ');
    if (/香港|Hong\s*Kong/i.test(place)) return 'hk';
    if (/澳门|澳門|Macau|Macao/i.test(place)) return 'mo';
    if (/台湾|台灣|Taiwan/i.test(place)) return 'tw';
  }
  return code.toLowerCase();
}

function getFallbackFlagCode(hostname) {
  if (/^(www\.)?x\.com$/i.test(hostname || '')) return 'us';
  return '';
}

function getDisplayName(data, flagCode) {
  if (flagCode === 'hk') return LOCALE === 'zh' ? '中国香港' : (data.region || data.province || data.city || 'Hong Kong');
  if (flagCode === 'mo') return LOCALE === 'zh' ? '中国澳门' : (data.region || data.province || data.city || 'Macau');
  if (flagCode === 'tw') return LOCALE === 'zh' ? '中国台湾' : (data.region || data.province || data.city || 'Taiwan');
  if (LOCALE === 'zh') return COUNTRY_ZH[(data.country_code || '').toUpperCase()] || data.country || data.country_code || '--';
  return data.country || data.country_code || '--';
}

function setFlagImage(flagCode) {
  const img = $('flag-img');
  if (!img) return;
  img.style.display = 'block';
  img.alt = flagCode ? flagCode.toUpperCase() : '';

  if (!flagCode) {
    img.onerror = null;
    img.src = chrome.runtime.getURL('icons/icon48.png');
    return;
  }

  const style = $('flag-img').dataset.style === 'square' ? 'square' : DEFAULT_FLAG_STYLE;
  const localSvgSrc = chrome.runtime.getURL(style === 'square' ? `flags/1x1/${flagCode}.png` : `flags/4x3/${flagCode}.svg`);
  img.onerror = () => {
    img.onerror = null;
    img.src = chrome.runtime.getURL('icons/icon48.png');
  };
  img.src = localSvgSrc;
}

function setFlagStyle(style) {
  const normalized = style === 'square' ? 'square' : DEFAULT_FLAG_STYLE;
  const flag = $('flag-img');
  if (flag) {
    flag.dataset.style = normalized;
    flag.classList.toggle('flag-square', normalized === 'square');
  }
  return normalized;
}

async function toggleFlagStyle() {
  const flag = $('flag-img');
  if (!flag) return;
  const style = setFlagStyle(flag.dataset.style === 'square' ? 'rect' : 'square');
  await chrome.storage.sync.set({ [FLAG_STYLE_KEY]: style });
  if (flag.dataset.flagCode) setFlagImage(flag.dataset.flagCode);
}

function setWhoisLink(id, value) {
  const el = $(id);
  if (!el) return;
  const text = value || '--';
  el.textContent = text;
  if (value) {
    el.href = `https://who.ga/whois/${encodeURIComponent(value)}`;
    el.classList.remove('disabled');
  } else {
    el.removeAttribute('href');
    el.classList.add('disabled');
  }
}

function setCopyValue(id, value) {
  currentCopyValues[id] = value || '';
}

function formatDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(LOCALE === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function renderIpSource(source) {
  const el = $('ip-source');
  if (!el) return;
  const isDns = source === 'dns';
  el.textContent = isDns ? t('sourceDns') : t('sourceConnection');
  el.title = isDns ? 'DNS A' : 'webRequest';
}

function getSslClass(daysLeft, status) {
  if (!Number.isFinite(daysLeft) || status === 'error' || status === 'expired' || status === false) return 'muted';
  if (daysLeft < 7) return 'danger';
  if (daysLeft < 30) return 'warning';
  return '';
}

function getSslText(data) {
  const daysLeft = Number(data?.days_remaining ?? data?.days_left);
  if (!Number.isFinite(daysLeft)) return t('sslUnknown');
  if (daysLeft < 0 || data?.status === 'expired' || data?.valid === false) return t('sslExpired');
  return t('sslDaysLeft').replace('{days}', String(daysLeft));
}

function renderSsl(data) {
  lastSslData = data;
  const el = $('ssl-toggle');
  if (!el) return;
  const daysLeft = Number(data?.days_remaining ?? data?.days_left);
  el.textContent = data ? getSslText(data) : t('sslUnknown');
  el.className = `value-main ssl-value ${getSslClass(daysLeft, data?.status || (data?.valid === false ? 'expired' : 'ok'))}`.trim();
  const expiresAt = data?.expires_at || data?.valid_to;
  if (expiresAt) {
    const issuer = data.issuer ? ` · ${data.issuer}` : '';
    el.title = `${expiresAt}${issuer}`;
  } else {
    el.removeAttribute('title');
  }
  setText('ssl-issuer', data?.issuer || '--');
  setText('ssl-valid-to', formatDateTime(expiresAt));
  setText('ssl-host', data?.host || data?.subject || '--');
  setCopyValue('ssl', expiresAt || '');
}

async function loadSslInfo(hostname, embeddedSsl) {
  renderSsl(embeddedSsl || null);
  if (embeddedSsl) return;
  try {
    renderSsl(await fetchSslInfo(hostname));
  } catch {
    renderSsl(null);
  }
}

function hideMapContextMenu() {
  const menu = $('map-context-menu');
  if (menu) menu.hidden = true;
}

function showMapContextMenu(event) {
  if (!currentMapCoords) return;
  event.preventDefault();
  event.stopPropagation();

  const menu = $('map-context-menu');
  if (!menu) return;
  const menuWidth = 132;
  const menuHeight = 36;
  const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
  const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.hidden = false;
}

function openCurrentCoordsInMaps() {
  if (!currentMapCoords) return;
  const { lat, lon } = currentMapCoords;
  const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
  chrome.tabs.create({ url }).catch(() => {});
  window.close();
}

function bindMapContextMenu() {
  const map = $('map-container');
  const open = $('map-open');
  if (map) {
    map.addEventListener('contextmenu', showMapContextMenu);
  }
  if (open) {
    open.addEventListener('click', openCurrentCoordsInMaps);
  }
  document.addEventListener('click', hideMapContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMapContextMenu();
  });
}

function toggleSslDetails() {
  const details = $('ssl-details');
  const button = $('ssl-toggle');
  if (!details || !button || !lastSslData) return;
  const isHidden = details.hidden;
  details.hidden = !isHidden;
  button.setAttribute('aria-expanded', String(isHidden));
}

async function copyValue(id, button) {
  const value = currentCopyValues[id];
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    button.classList.add('copied');
    window.setTimeout(() => button.classList.remove('copied'), 800);
  } catch {}
}

function bindActions() {
  const sslToggle = $('ssl-toggle');
  if (sslToggle && !sslToggle._bound) {
    sslToggle.addEventListener('click', toggleSslDetails);
    sslToggle._bound = true;
  }

  document.querySelectorAll('[data-copy-target]').forEach((button) => {
    if (button._bound) return;
    button.addEventListener('click', () => copyValue(button.dataset.copyTarget, button));
    button._bound = true;
  });
}

function renderMap(data) {
  if (!data.latitude || !data.longitude) {
    currentMapCoords = null;
    $('map-container').style.display = 'none';
    hideMapContextMenu();
    return;
  }

  const lat = parseFloat(data.latitude);
  const lon = parseFloat(data.longitude);
  currentMapCoords = { lat, lon };
  $('map-container').style.display = 'block';
  $('map-loading').style.display = 'flex';
  $('map-grid').innerHTML = '';

  const mapGrid = $('map-grid');
  const tiles = getMapTiles(lat, lon, $('map-container').clientWidth || 320, $('map-container').clientHeight || 130);
  let loaded = 0;
  tiles.forEach((tile) => {
    const img = new Image();
    img.className = 'map-tile';
    img.draggable = false;
    img.style.left = `${tile.left}px`;
    img.style.top = `${tile.top}px`;
    img.onload = img.onerror = () => {
      loaded++;
      if (loaded === tiles.length) $('map-loading').style.display = 'none';
    };
    img.src = tile.url;
    mapGrid.appendChild(img);
  });
}

function render(data, hostname, ipSource, flagStyle) {
  lastRenderData = data;
  $('loading').style.display = 'none';
  $('content').style.display = 'block';
  const details = $('ssl-details');
  const sslToggle = $('ssl-toggle');
  if (details) details.hidden = true;
  if (sslToggle) sslToggle.setAttribute('aria-expanded', 'false');

  const flagCode = getFlagCode(data) || getFallbackFlagCode(hostname);
  setFlagStyle(flagStyle);
  $('flag-img').dataset.flagCode = flagCode;
  setFlagImage(flagCode);
  setText('country', getDisplayName(data, flagCode));
  setText('country-code', flagCode.toUpperCase());
  setText('city-region', [data.city, data.province].filter(Boolean).join(t('locationSeparator')) || '--');

  renderMap(data);

  const asn = extractAsn(data.asn);
  setWhoisLink('ip', data.ip);
  setWhoisLink('domain', hostname);
  setWhoisLink('asn', asn === '--' ? '' : asn);
  setText('isp', data.isp || '--');
  setText('timezone', data.timezone || '--');
  renderIpSource(ipSource);
  setCopyValue('ip', data.ip);
  setCopyValue('domain', hostname);
  setCopyValue('asn', asn === '--' ? '' : asn);
  loadSslInfo(hostname, data.ssl);

  $('promo-link').href = 'https://cleanip.io';
}

function showError(msg) {
  $('loading').style.display = 'none';
  $('error').style.display = 'block';
  setText('error-msg', msg);
}

function bindRetry() {
  const btn = $('error-retry');
  if (btn && !btn._bound) {
    btn.addEventListener('click', () => {
      $('error').style.display = 'none';
      $('loading').style.display = 'flex';
      init();
    });
    btn._bound = true;
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || isSpecialPage(tab.url)) { showError(t('unsupportedPage')); return; }

  const hostname = new URL(tab.url).hostname;
  const settings = await chrome.storage.sync.get({ [FLAG_STYLE_KEY]: DEFAULT_FLAG_STYLE });
  const flagStyle = setFlagStyle(settings[FLAG_STYLE_KEY]);
  const flagImage = $('flag-img');
  if (flagImage && !flagImage._bound) {
    flagImage.title = LOCALE === 'zh' ? '点击切换国旗比例' : 'Click to switch flag ratio';
    flagImage.addEventListener('click', toggleFlagStyle);
    flagImage._bound = true;
  }

  // 0. 让后台立即解析当前页并等待应答。必须 await Promise，
  //    否则“没有接收端”会成为 Uncaught (in promise)。
  let preheated = null;
  try {
    preheated = await chrome.runtime.sendMessage({
      type: 'preheat',
      tabId: tab.id,
      url: tab.url,
      hostname,
    });
  } catch {}

  if (preheated?.ok && preheated.data) {
    render(preheated.data, hostname, preheated.source, flagStyle);
    return;
  }

  // 1. 读 webRequest 缓存的连接 IP，优先 IPv4，v6 时通过 DoH 查 A 记录
  const ipKey = `ip_${hostname}`;
  const sourceKey = `ip_source_${hostname}`;
  const ipStore = await chrome.storage.session.get([ipKey, sourceKey]);
  const preferred = await getPreferredIp(hostname, ipStore[ipKey], ipStore[sourceKey]);
  const ip = preferred?.ip;

  if (!ip) {
    // webRequest 在部分 VPN/隐私模式下可能拿不到连接 IP，直接让 API 按域名解析。
    try {
      const raw = await fetchDomainJson(hostname);
      if (!raw) throw new Error('domain lookup failed');
      const data = normalizeData(raw, raw.ip);
      await chrome.storage.session.set({ [`geo_${hostname}`]: { data, ts: Date.now() } });
      render(data, hostname, 'dns', flagStyle);
      return;
    } catch {
      showError(t('resolveFailed'));
      return;
    }
  }

  // 3. 查 geo 缓存（以 IP 为 key，多域名共享 CDN IP 时复用）
  const key = `geo_${ip}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < CACHE_TTL) {
    render(store[key].data, hostname, preferred.source, flagStyle);
    return;
  }

  // 4. 调 IP Flag API
  try {
    const raw = await fetchGeoJson(ip);
    if (!raw) throw new Error('API error');
    const data = normalizeData(raw, ip);
    await chrome.storage.session.set({ [key]: { data, ts: Date.now() } });
    render(data, hostname, preferred.source, flagStyle);
  } catch {
    showError(t('fetchFailed'));
  }
}

function bindSystemThemeListener() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (lastRenderData) renderMap(lastRenderData);
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else mq.addListener(onChange);
}

document.addEventListener('DOMContentLoaded', () => {
  applyI18n();
  bindRetry();
  bindMapContextMenu();
  bindActions();
  bindSystemThemeListener();
  init();
});
