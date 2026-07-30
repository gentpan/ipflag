const API_BASE = 'https://api.cnip.io/geoip/';
const CACHE_TTL = 10 * 60 * 1000;
const memCache = new Map(); // 内存缓存，最快

function isSpecialPage(url) {
  return !url || /^(chrome|chrome-extension|edge|about|file|devtools|browser):/.test(url);
}

function extractHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function fetchAndCache(hostname) {
  // 1. 内存缓存（瞬间）
  const mem = memCache.get(hostname);
  if (mem && Date.now() - mem.ts < CACHE_TTL) return mem.data;

  // 2. session storage
  const key = `geo_${hostname}`;
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < CACHE_TTL) {
    memCache.set(hostname, store[key]);
    return store[key].data;
  }

  // 3. API 请求
  const res = await fetch(`${API_BASE}${hostname}`);
  if (!res.ok) return null;
  const data = await res.json();
  const entry = { data, ts: Date.now() };
  memCache.set(hostname, entry);
  chrome.storage.session.set({ [key]: entry }); // 不 await，异步写入
  return data;
}

// 根据 city/region 修正特别行政区的国家码
function getFlagCode(data) {
  const code = (data.country_code || '').toUpperCase();
  const city = data.city || '';
  const region = data.region || '';
  const loc = city + region;

  if (code === 'CN') {
    if (/香港|Hong\s*Kong/i.test(loc)) return 'hk';
    if (/澳门|澳門|Macau|Macao/i.test(loc)) return 'mo';
  }

  return code.toLowerCase();
}

function setFlagIcon(tabId, flagCode) {
  if (!flagCode) return;
  const path = `flags/1x1/${flagCode}.png`;
  chrome.action.setIcon({ tabId, path: { '16': path, '32': path, '48': path, '128': path } });
}

function setHoverTitle(tabId, data, hostname, flagCode) {
  let location;
  if (flagCode === 'hk') {
    location = '中国香港';
  } else if (flagCode === 'mo') {
    location = '中国澳门';
  } else {
    location = [data.country, data.region, data.city].filter(Boolean).join(' ');
  }

  chrome.action.setTitle({
    tabId,
    title: [
      location,
      hostname,
      data.ip || '',
    ].join('\n'),
  });
}

async function handleTab(tabId, url) {
  if (isSpecialPage(url)) {
    chrome.action.setIcon({ tabId, path: { '16': 'icons/icon16.png', '48': 'icons/icon48.png' } });
    return;
  }

  const hostname = extractHostname(url);
  if (!hostname) return;

  try {
    const data = await fetchAndCache(hostname);
    if (!data) return;
    const flagCode = getFlagCode(data);
    setFlagIcon(tabId, flagCode);
    setHoverTitle(tabId, data, hostname, flagCode);
  } catch {}
}

const pendingTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.url || isSpecialPage(tab.url)) return;

  if (changeInfo.url || changeInfo.status === 'loading') {
    // 标记需要处理，立即尝试
    pendingTabs.add(tabId);
    handleTab(tabId, tab.url);
  }

  if (changeInfo.status === 'complete' && pendingTabs.has(tabId)) {
    // 页面加载完如果还没显示，再试一次
    pendingTabs.delete(tabId);
    handleTab(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) handleTab(activeInfo.tabId, tab.url);
  } catch {}
});
