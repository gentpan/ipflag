const API_BASE = 'https://api.ipflag.io/';
const CACHE_TTL = 10 * 60 * 1000;
const SSL_CACHE_TTL = 6 * 60 * 60 * 1000;
const memCache = new Map();   // ip → { data, ts }  内存缓存，最快
const sslMemCache = new Map(); // hostname → { data, ts }
const ipMemCache = new Map(); // hostname → ip      内存缓存，最快
const ipSourceMemCache = new Map(); // hostname → connection | dns
const statusMemCache = new Map(); // hostname → { statusCode, statusLine }
const requestStartMemCache = new Map(); // requestId → start timestamp
const geoInflight = new Map(); // ip → Promise，避免同一页面多个事件重复请求
const sslInflight = new Map(); // hostname → Promise
const tabNavigationState = new Map(); // tabId → { url, generation }

const I18N = {
  en: {
    title: 'IP Flag',
    ipLocation: 'IP Location',
    hostname: 'Host Name',
    serverIp: 'Server IP',
    statusLine: 'Status Line',
    resolveMethod: 'Resolution',
    latency: 'Response Time',
    methodConnection: 'Connection IP',
    methodDns: 'DNS A record',
    sslExpiry: 'SSL Expiry',
    sslDaysLeft: '{days} days left',
    sslExpired: 'Expired',
  },
  zh: {
    title: 'IP Flag',
    ipLocation: 'IP 所属',
    hostname: '主机名称',
    serverIp: '服务器 IP',
    statusLine: 'Status Line',
    resolveMethod: '解析方式',
    latency: '响应耗时',
    methodConnection: '连接 IP',
    methodDns: 'DNS A 记录',
    sslExpiry: 'SSL 到期',
    sslDaysLeft: '剩余 {days} 天',
    sslExpired: '已过期',
  },
};

function isChinese() {
  return /^zh/i.test(navigator.language || '');
}

function t(key) {
  const locale = isChinese() ? 'zh' : 'en';
  return I18N[locale][key] || I18N.en[key] || key;
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

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function isIPv4(ip) {
  return typeof ip === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

function cacheMainFrameDetails(details) {
  if (details.type !== 'main_frame' || !details.ip) return null;
  try {
    const hostname = new URL(details.url).hostname;
    const startedAt = requestStartMemCache.get(details.requestId);
    const status = {
      statusCode: details.statusCode,
      statusLine: details.statusLine || `HTTP ${details.statusCode}`,
      latencyMs: startedAt ? Math.max(0, Math.round(details.timeStamp - startedAt)) : null,
    };
    const existing = ipMemCache.get(hostname);
    const store = {};
    if (isIPv4(details.ip)) {
      ipMemCache.set(hostname, details.ip);
      ipSourceMemCache.set(hostname, 'connection');
      store[`ip_${hostname}`] = details.ip;
      store[`ip_source_${hostname}`] = 'connection';
    } else if (!isIPv4(existing)) {
      ipMemCache.set(hostname, details.ip);
      ipSourceMemCache.set(hostname, 'connection');
      store[`ip_${hostname}`] = details.ip;
      store[`ip_source_${hostname}`] = 'connection';
    }
    statusMemCache.set(hostname, status);
    store[`status_${hostname}`] = status;
    chrome.storage.session.set(store).catch(() => {});
    return hostname;
  } catch {
    return null;
  }
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.type === 'main_frame') {
      requestStartMemCache.set(details.requestId, details.timeStamp);
    }
  },
  { urls: ['<all_urls>'] }
);

// 页面响应头到达时就能拿到真实连接 IP，比 onCompleted 更早。
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const hostname = cacheMainFrameDetails(details);
    if (hostname && details.tabId >= 0) {
      handleTab(details.tabId, details.url, { fastOnly: true });
    }
  },
  { urls: ['<all_urls>'] }
);

// 页面完成时再补一次状态，确保最终 tooltip 信息完整。
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const hostname = cacheMainFrameDetails(details);
    requestStartMemCache.delete(details.requestId);
    if (hostname && details.tabId >= 0) {
      handleTab(details.tabId, details.url);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    requestStartMemCache.delete(details.requestId);
  },
  { urls: ['<all_urls>'] }
);

async function getIpForHostname(hostname) {
  if (ipMemCache.has(hostname)) {
    return { ip: ipMemCache.get(hostname), source: ipSourceMemCache.get(hostname) || 'connection' };
  }
  const key = `ip_${hostname}`;
  const sourceKey = `ip_source_${hostname}`;
  const store = await chrome.storage.session.get([key, sourceKey]);
  if (store[key]) {
    ipMemCache.set(hostname, store[key]);
    ipSourceMemCache.set(hostname, store[sourceKey] || 'connection');
    return { ip: store[key], source: store[sourceKey] || 'connection' };
  }
  return null;
}

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
  if (cachedIp && isIPv4(cachedIp)) return { ip: cachedIp, source: cachedSource || 'connection' };

  const v4 = await resolveIpDoH(hostname);
  if (v4) {
    ipMemCache.set(hostname, v4);
    ipSourceMemCache.set(hostname, 'dns');
    await chrome.storage.session.set({
      [`ip_${hostname}`]: v4,
      [`ip_source_${hostname}`]: 'dns',
    });
    return { ip: v4, source: 'dns' };
  }

  return cachedIp ? { ip: cachedIp, source: cachedSource || 'connection' } : null;
}

async function getStatusForHostname(hostname) {
  if (statusMemCache.has(hostname)) return statusMemCache.get(hostname);
  const key = `status_${hostname}`;
  const store = await chrome.storage.session.get(key);
  if (store[key]) {
    statusMemCache.set(hostname, store[key]);
    return store[key];
  }
  return null;
}

async function fetchAndCache(ip) {
  // 1. 内存缓存
  const mem = memCache.get(ip);
  if (mem && Date.now() - mem.ts < CACHE_TTL) return mem.data;

  // 2. session storage
  const key = `geo_${ip}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < CACHE_TTL) {
    memCache.set(ip, store[key]);
    return store[key].data;
  }

  // 3. API 请求：同一 IP 的并发事件共用一个请求
  if (geoInflight.has(ip)) return geoInflight.get(ip);

  const request = (async () => {
    const raw = await fetchGeoJson(ip);
    if (!raw) return null;
    const data = normalizeData(raw, ip);
    const entry = { data, ts: Date.now() };
    memCache.set(ip, entry);
    await chrome.storage.session.set({ [key]: entry });
    return data;
  })();

  geoInflight.set(ip, request);
  try {
    return await request;
  } finally {
    geoInflight.delete(ip);
  }
}

async function fetchSslInfo(hostname) {
  const mem = sslMemCache.get(hostname);
  if (mem && Date.now() - mem.ts < SSL_CACHE_TTL) return mem.data;

  const key = `ssl_${hostname}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < SSL_CACHE_TTL) {
    sslMemCache.set(hostname, store[key]);
    return store[key].data;
  }

  if (sslInflight.has(hostname)) return sslInflight.get(hostname);

  const request = (async () => {
    const data = await fetchSslJson(hostname);
    if (!data) return null;
    const entry = { data, ts: Date.now() };
    sslMemCache.set(hostname, entry);
    await chrome.storage.session.set({ [key]: entry });
    return data;
  })();

  sslInflight.set(hostname, request);
  try {
    return await request;
  } finally {
    sslInflight.delete(hostname);
  }
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

async function setFlagIcon(tabId, flagCode) {
  if (!flagCode) {
    await chrome.action.setIcon({ tabId, path: { '16': 'icons/icon16.png', '48': 'icons/icon48.png' } });
    return;
  }
  const path = `flags/1x1/${flagCode}.png`;
  try {
    await chrome.action.setIcon({ tabId, path: { '16': path, '32': path, '48': path, '128': path } });
    chrome.storage.session.set({
      last_icon_debug: { tabId, flagCode, path, method: 'png-path', ok: true, ts: Date.now() },
    }).catch(() => {});
  } catch (error) {
    chrome.storage.session.set({
      last_icon_debug: {
        tabId,
        flagCode,
        path,
        method: 'png-path',
        ok: false,
        error: error?.message || String(error),
        ts: Date.now(),
      },
    }).catch(() => {});
    await chrome.action.setIcon({ tabId, path: { '16': 'icons/icon16.png', '48': 'icons/icon48.png' } });
  }
}

function formatSslLine(sslInfo) {
  const daysLeft = Number(sslInfo?.days_remaining ?? sslInfo?.days_left);
  if (!Number.isFinite(daysLeft)) return '';
  const value = daysLeft < 0 || sslInfo?.status === 'expired' || sslInfo?.valid === false
    ? t('sslExpired')
    : t('sslDaysLeft').replace('{days}', String(daysLeft));
  return `${t('sslExpiry')}: ${value}`;
}

function setHoverTitle(tabId, data, hostname, status, sslInfo, ipSource) {
  const flagCode = getFlagCode(data);
  const location =
    flagCode === 'hk' || flagCode === 'mo' || flagCode === 'tw'
      ? data.region || data.province || data.city || data.country || data.country_code || ''
      : data.country || data.country_code || '';
  const statusLine = status?.statusLine || '';
  const latencyLine = Number.isFinite(status?.latencyMs)
    ? `${t('latency')}: ${status.latencyMs} ms`
    : '';

  return chrome.action.setTitle({
    tabId,
    title: [
      t('title'),
      '',
      `${t('ipLocation')}: ${location || '--'}`,
      `${t('hostname')}: ${hostname || '--'}`,
      `${t('serverIp')}: ${data.ip || '--'}`,
      statusLine ? `${t('statusLine')}: ${statusLine}` : '',
      formatSslLine(sslInfo),
      '',
      `${t('resolveMethod')}: ${ipSource === 'dns' ? t('methodDns') : t('methodConnection')}`,
      latencyLine,
    ].filter(line => line !== '').join('\n'),
  });
}

function beginTabNavigation(tabId, url) {
  const current = tabNavigationState.get(tabId);
  if (current?.url === url) return current.generation;

  const generation = (current?.generation || 0) + 1;
  tabNavigationState.set(tabId, { url, generation });
  return generation;
}

function isCurrentNavigation(tabId, url, generation) {
  const current = tabNavigationState.get(tabId);
  return current?.url === url && current.generation === generation;
}

async function resetTabAction(tabId) {
  await Promise.all([
    chrome.action.setIcon({ tabId, path: { '16': 'icons/icon16.png', '48': 'icons/icon48.png' } }),
    chrome.action.setTitle({ tabId, title: t('title') }),
  ]);
}

async function handleTab(tabId, url, options = {}) {
  const generation = beginTabNavigation(tabId, url);

  if (isSpecialPage(url)) {
    try {
      await resetTabAction(tabId);
    } catch {}
    return null;
  }

  const hostname = extractHostname(url);
  if (!hostname) return null;

  try {
    const cached = await getIpForHostname(hostname);
    const preferred = await getPreferredIp(hostname, cached?.ip, cached?.source);
    const ip = preferred?.ip;
    if (!ip) {
      const raw = await fetchDomainJson(hostname);
      if (!raw || !isCurrentNavigation(tabId, url, generation)) return null;
      const data = normalizeData(raw, raw.ip);
      const flagCode = getFlagCode(data) || getFallbackFlagCode(hostname);
      await setFlagIcon(tabId, flagCode);
      await setHoverTitle(tabId, data, hostname, null, data.ssl, 'dns');
      return { ip: data.ip, source: 'dns', data };
    }

    const data = await fetchAndCache(ip);
    if (!data || !isCurrentNavigation(tabId, url, generation)) return null;

    const flagCode = getFlagCode(data) || getFallbackFlagCode(hostname);

    // 国旗是核心功能：地理数据一到就立即更新，不再等待较慢的 SSL 接口。
    await setFlagIcon(tabId, flagCode);
    const status = await getStatusForHostname(hostname);
    if (!isCurrentNavigation(tabId, url, generation)) return null;
    await setHoverTitle(tabId, data, hostname, status, null, preferred.source);

    const result = { ip, source: preferred.source, data };
    if (options.fastOnly) return result;

    // SSL 信息只用来丰富 tooltip，失败不影响国旗。
    let sslInfo = null;
    try {
      sslInfo = await fetchSslInfo(hostname);
    } catch {}

    if (isCurrentNavigation(tabId, url, generation)) {
      await setHoverTitle(tabId, data, hostname, status, sslInfo, preferred.source);
    }
    return result;
  } catch (error) {
    try {
      await chrome.storage.session.set({
        last_background_error: {
          tabId,
          url,
          error: error?.message || String(error),
          ts: Date.now(),
        },
      });
    } catch {}
    return null;
  }
}

// popup 可以请求后台立即解析当前页，并等到明确的成功/失败应答。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'preheat' && Number.isInteger(msg.tabId) && msg.url) {
    (async () => {
      try {
        const result = await handleTab(msg.tabId, msg.url, { fastOnly: true });
        sendResponse(result ? { ok: true, ...result } : { ok: false });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url) return;

  if (isSpecialPage(tab.url)) {
    beginTabNavigation(tabId, tab.url);
    resetTabAction(tabId).catch(() => {});
    return;
  }

  if (changeInfo.url || changeInfo.status === 'loading') {
    handleTab(tabId, tab.url, { fastOnly: true });
  }

  // 不依赖内存 pending 状态：SW 重启后即使错过 loading 事件，
  // 仍能在 complete 时可靠地恢复国旗。
  if (changeInfo.status === 'complete') {
    handleTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) handleTab(activeInfo.tabId, tab.url);
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabNavigationState.delete(tabId);
});

async function refreshExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !isSpecialPage(tab.url)) {
        handleTab(tab.id, tab.url, { fastOnly: true });
      }
    }
  } catch {}
}

// 覆盖浏览器启动恢复的标签页，以及扩展更新/重载时已经打开的页面。
chrome.runtime.onStartup.addListener(refreshExistingTabs);
chrome.runtime.onInstalled.addListener(refreshExistingTabs);
