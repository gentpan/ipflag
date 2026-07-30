const $ = (id) => document.getElementById(id);
const API_BASE = 'https://api.ipflag.io/';
// Keep provider credentials out of the public repository. A map is shown only
// when a private build supplies IPFLAG_MAPBOX_TOKEN at runtime.
const MAPBOX_TOKEN = globalThis.IPFLAG_MAPBOX_TOKEN || '';
const CACHE_TTL = 10 * 60 * 1000;
const FLAG_STYLE_KEY = 'flagStyle';
const DEFAULT_FLAG_STYLE = 'rect';

function isSpecialPage(url) {
  return !url || /^(chrome|chrome-extension|edge|about|file|devtools|browser):/.test(url);
}

function getMapUrl(lat, lon) {
  if (!MAPBOX_TOKEN) return null;
  const lng = parseFloat(lon), la = parseFloat(lat);
  return `https://mapbox.mapcdn.io/styles/v1/mapbox/light-v11/static/pin-s+e74c3c(${lng},${la})/${lng},${la},4,0/600x260@2x?access_token=${MAPBOX_TOKEN}`;
}

function getFlagCode(data) {
  const code = (data.country_code || '').toUpperCase();
  const loc = (data.city || '') + (data.region || '');
  if (code === 'CN') {
    if (/香港|Hong\s*Kong/i.test(loc)) return 'hk';
    if (/澳门|澳門|Macau|Macao/i.test(loc)) return 'mo';
  }
  return code.toLowerCase();
}

function getDisplayName(data, flagCode) {
  if (flagCode === 'hk') return '中国香港';
  if (flagCode === 'mo') return '中国澳门';
  return data.country || data.country_code || '--';
}

function setFlagStyle(style) {
  const normalized = style === 'square' ? 'square' : DEFAULT_FLAG_STYLE;
  const select = $('flag-style');
  if (select) select.value = normalized;
  const flag = $('flag-img');
  if (flag) {
    flag.classList.toggle('flag-square', normalized === 'square');
    flag.dataset.style = normalized;
  }
  return normalized;
}

function render(data, hostname, style) {
  $('loading').style.display = 'none';
  $('content').style.display = 'block';

  const flagCode = getFlagCode(data);
  const normalizedStyle = setFlagStyle(style);
  $('flag-img').dataset.flagCode = flagCode;
  $('flag-img').src = normalizedStyle === 'square'
    ? `flags/1x1/${flagCode}.png`
    : `flags/4x3/${flagCode}.svg`;
  $('country').textContent = getDisplayName(data, flagCode);
  $('country-code').textContent = flagCode.toUpperCase();
  $('city-region').textContent = [data.city, data.region].filter(Boolean).join(', ') || '--';

  // 地图懒加载：先显示 loading 圈，图片加载完再切换
  const mapUrl = data.latitude && data.longitude
    ? getMapUrl(data.latitude, data.longitude)
    : null;
  if (mapUrl) {
    $('map-container').style.display = 'block';
    $('map-loading').style.display = 'flex';
    $('map-img').style.display = 'none';

    const mapImg = $('map-img');
    mapImg.onload = () => {
      $('map-loading').style.display = 'none';
      mapImg.style.display = 'block';
    };
    mapImg.src = mapUrl;
  } else {
    $('map-container').style.display = 'none';
  }

  $('ip').textContent = data.ip || '--';
  $('domain').textContent = hostname || '--';
  $('asn').textContent = data.asn || '--';
  $('isp').textContent = data.isp || '--';
  $('timezone').textContent = data.timezone || '--';
  $('coords').textContent = data.latitude && data.longitude
    ? `${parseFloat(data.latitude).toFixed(4)}, ${parseFloat(data.longitude).toFixed(4)}`
    : '--';

  // 推广链接带上当前 IP
  $('promo-link').href = `https://cleanip.io/?ip=${data.ip || ''}`;
}

function showError(msg) {
  $('loading').style.display = 'none';
  $('error').style.display = 'block';
  $('error-msg').textContent = msg;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || isSpecialPage(tab.url)) { showError('当前页面不支持查询'); return; }

  const hostname = new URL(tab.url).hostname;
  const key = `geo_${hostname}`;
  const settings = await chrome.storage.sync.get({ [FLAG_STYLE_KEY]: DEFAULT_FLAG_STYLE });
  let flagStyle = setFlagStyle(settings[FLAG_STYLE_KEY]);

  $('flag-style').addEventListener('change', async (event) => {
    flagStyle = setFlagStyle(event.target.value);
    await chrome.storage.sync.set({ [FLAG_STYLE_KEY]: flagStyle });
    const current = $('flag-img');
    const flagCode = current?.dataset.flagCode;
    if (flagCode) {
      current.src = flagStyle === 'square'
        ? `flags/1x1/${flagCode}.png`
        : `flags/4x3/${flagCode}.svg`;
    }
  });

  // 直接读 session storage
  const store = await chrome.storage.session.get(key);
  if (store[key] && Date.now() - store[key].ts < CACHE_TTL) {
    render(store[key].data, hostname, flagStyle);
    return;
  }

  // 没缓存，直接请求
  try {
    const res = await fetch(`${API_BASE}domain/${hostname}`);
    if (!res.ok) throw new Error('IP Flag API error');
    const data = await res.json();
    await chrome.storage.session.set({ [key]: { data, ts: Date.now() } });
    render(data, hostname, flagStyle);
  } catch {
    showError('无法获取 IP 信息');
  }
}

document.addEventListener('DOMContentLoaded', init);
