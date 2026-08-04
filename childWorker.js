// child-worker.js — v3.12 (بهینه‌سازی شده جهت جلوگیری از اسپم مادر)
import { connect } from 'cloudflare:sockets';

const VERSION = 'saow-node-3.13';
let MOTHER_URL = null;
const API_SECRET = 'saow-pan2';

// تنظیمات کش و بازه گزارش‌دهی
const USER_CACHE_TTL = 10 * 60 * 1000;       // ۱۰ دقیقه کش کانفیگ کاربر
const NEGATIVE_CACHE_TTL = 2 * 60 * 1000;     // ۲ دقیقه کش منفی برای کاربران نامعتبر
const SILENCE_TTL_MS = 30 * 60 * 1000;       // ۳۰ دقیقه سکوت در صورت رد شدن نود
const USAGE_FLUSH_INTERVAL = 60 * 1000;      // ارسال تجمعی حجم مصرفی هر ۱ دقیقه

const STATUS_HTML_URL = 'https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/node-status.html';

const ADGUARD_DNS_HOST = 'dns.adguard.com';
const ADGUARD_DNS_PORT = 53;
const AD_HOST_SUFFIXES = [
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'googletagmanager.com', 'googletagservices.com', 'google-analytics.com',
  'adservice.google.com', 'pagead2.googlesyndication.com',
  'facebook.net', 'scorecardresearch.com', 'adnxs.com', 'adsrvr.org',
  'taboola.com', 'outbrain.com', 'moatads.com', 'criteo.com', 'hotjar.com',
  'adform.net', 'pubmatic.com', 'openx.net',
];
const BLOCKLIST_URLS = [
  'https://small.oisd.nl/domainswild2',
  'https://raw.githubusercontent.com/sjhgvr/oisd/main/domainswild2_small.txt',
];
const BLOCKLIST_TTL_MS = 6 * 60 * 60 * 1000;

let blockSet = null;
let blockSetAt = 0;
let blockSetLoading = null;

// ذخیره تجمعی حجم مصرفی (کاهش بی‌نهایت درخواست به مادر)
// Map<uuid, { up: bytes, down: bytes, lastIp: string }>
const pendingUsage = new Map();

// حالت سکوت سراسری
let silenceUntil = 0;

function isSilenced() {
  return Date.now() < silenceUntil;
}

function enterSilence(reason = '') {
  silenceUntil = Date.now() + SILENCE_TTL_MS;
  console.log('SILENCE ON:', reason, 'until', new Date(silenceUntil).toISOString());
}

function isAdHostLocal(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (/(^|\.)ads?\d*\./.test(h) || /(^|\.)adserver\./.test(h) || /(^|\.)tracking\./.test(h)) return true;
  return AD_HOST_SUFFIXES.some(s => h === s || h.endsWith('.' + s));
}

function parseBlocklistText(text) {
  const set = new Set();
  for (let line of text.split('\n')) {
    line = line.trim().toLowerCase();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.startsWith('0.0.0.0 ') || line.startsWith('127.0.0.1 ')) {
      line = line.split(/\s+/)[1] || '';
    }
    line = line.replace(/^\|\|/, '').replace(/\^.*$/, '').replace(/^\*\./, '').replace(/^\./, '');
    if (line.length >= 3 && line.length <= 253 && !/[^a-z0-9.-]/.test(line)) set.add(line);
  }
  return set;
}

async function ensureBlocklist() {
  const now = Date.now();
  if (blockSet && now - blockSetAt < BLOCKLIST_TTL_MS) return blockSet;
  if (blockSetLoading) return blockSetLoading;
  blockSetLoading = (async () => {
    for (const url of BLOCKLIST_URLS) {
      try {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'cf-child/3.2' },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!r.ok) continue;
        const set = parseBlocklistText(await r.text());
        if (set.size > 100) {
          blockSet = set;
          blockSetAt = Date.now();
          return set;
        }
      } catch {}
    }
    if (!blockSet) {
      blockSet = new Set(AD_HOST_SUFFIXES);
      blockSetAt = Date.now();
    }
    return blockSet;
  })();
  try { return await blockSetLoading; }
  finally { blockSetLoading = null; }
}

function hostInBlockset(host, set) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || !set) return false;
  if (set.has(h)) return true;
  let i = h.indexOf('.');
  while (i !== -1) {
    if (set.has(h.slice(i + 1))) return true;
    i = h.indexOf('.', i + 1);
  }
  return false;
}

async function isAdHost(host) {
  if (isAdHostLocal(host)) return true;
  try {
    const set = await ensureBlocklist();
    return hostInBlockset(host, set);
  } catch {
    return isAdHostLocal(host);
  }
}

function generateChildId(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return 'child-' + hostname.replace(/[^a-z0-9.-]/g, '').replace(/\./g, '-');
  } catch {
    return 'child-unknown';
  }
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') ||
         request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
         '0.0.0.0';
}

const userCache = new Map();
const activeConns = new Map();

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_SECRET}`,
    'X-API-Key': API_SECRET,
  };
}

function isNodeRejection(status, data) {
  if (status === 401 || status === 403) return true;
  if (!data) return false;
  const reason = String(data.reason || data.err || '').toLowerCase();
  return reason.includes('unknown node') || reason.includes('not registered') || reason.includes('unauthorized');
}

// ارسال کلی گزارش‌ها به مادر
async function sendToMother(path, payload) {
  if (!MOTHER_URL || isSilenced()) return null;
  try {
    const res = await fetch(`${MOTHER_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await res.json(); } catch {}

    if (isNodeRejection(res.status, data)) {
      enterSilence(`mother rejected -> ${res.status}`);
      return null;
    }
    return res.ok ? data : null;
  } catch (e) {
    return null;
  }
}

// ثبت مصرف کاربر در حافظه محلی
function trackUsage(uuid, bytesUp, bytesDown, clientIP) {
  const current = pendingUsage.get(uuid) || { up: 0, down: 0, ip: clientIP };
  current.up += bytesUp;
  current.down += bytesDown;
  current.ip = clientIP;
  pendingUsage.set(uuid, current);
}

// ارسال تجمعی حجم‌های مصرف‌شده به نود مادر
async function flushUsageToMother(childId) {
  if (pendingUsage.size === 0 || isSilenced()) return;

  const usageList = [];
  for (const [uuid, data] of pendingUsage.entries()) {
    usageList.push({
      uuid,
      up: data.up,
      down: data.down,
      ip: data.ip,
    });
  }
  
  // پاک‌سازی حافظه موقت قبل از ارسال
  pendingUsage.clear();

  await sendToMother('/api/node/report', {
    type: 'batch_usage',
    child_id: childId,
    records: usageList,
  });
}

// استعلام وضعیت کاربر از نود مادر با کشینگ هوشمند
async function getUserConfig(uuid) {
  if (isSilenced()) return null;

  const cached = userCache.get(uuid);
  if (cached && (Date.now() - cached.ts < (cached.negative ? NEGATIVE_CACHE_TTL : USER_CACHE_TTL))) {
    return cached.data;
  }

  try {
    const res = await fetch(`${MOTHER_URL}/api/users?uuid=${encodeURIComponent(uuid)}`, {
      headers: authHeaders(),
    });

    let data = null;
    try { data = await res.json(); } catch {}

    if (isNodeRejection(res.status, data)) {
      enterSilence(`getUserConfig -> ${res.status}`);
      return null;
    }

    if (res.ok && data?.ok && data.user) {
      const u = data.user;
      const cfg = {
        enabled: u.enabled !== false,
        blockAds: u.blockAds !== false,
      };

      if (!cfg.enabled) {
        userCache.set(uuid, { data: null, ts: Date.now(), negative: true });
        return null;
      }

      userCache.set(uuid, { data: cfg, ts: Date.now(), negative: false });
      return cfg;
    }

    userCache.set(uuid, { data: null, ts: Date.now(), negative: true });
    return null;
  } catch (e) {
    userCache.set(uuid, { data: null, ts: Date.now(), negative: true });
    return null;
  }
}

function parseVlessHeader(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 19 || view.getUint8(0) !== 0) return { ok: false };
  const uuidBytes = new Uint8Array(buffer, 1, 16);
  let offset = 17;
  const addonLen = view.getUint8(offset);
  offset += 1 + addonLen;
  if (offset + 4 > buffer.byteLength) return { ok: false };
  const cmd = view.getUint8(offset); offset += 1;
  if (cmd !== 1 && cmd !== 2) return { ok: false };
  const port = view.getUint16(offset); offset += 2;
  const atype = view.getUint8(offset); offset += 1;
  let address = '';
  if (atype === 1) {
    if (offset + 4 > buffer.byteLength) return { ok: false };
    address = Array.from(new Uint8Array(buffer, offset, 4)).join('.');
    offset += 4;
  } else if (atype === 2) {
    const dlen = view.getUint8(offset); offset += 1;
    if (offset + dlen > buffer.byteLength) return { ok: false };
    address = new TextDecoder().decode(new Uint8Array(buffer, offset, dlen));
    offset += dlen;
  } else if (atype === 3) {
    if (offset + 16 > buffer.byteLength) return { ok: false };
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(view.getUint16(offset + i * 2).toString(16));
    address = parts.join(':');
    offset += 16;
  } else return { ok: false };

  const uuidHex = Array.from(uuidBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const uuid = [
    uuidHex.slice(0, 8), uuidHex.slice(8, 12), uuidHex.slice(12, 16),
    uuidHex.slice(16, 20), uuidHex.slice(20),
  ].join('-');

  return {
    ok: true, cmd, address, port, uuid,
    rest: buffer.byteLength > offset ? buffer.slice(offset) : null,
  };
}

async function handleVlessWebSocket(request, ctx) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  if (isSilenced()) return new Response('Node silenced', { status: 503 });

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let remoteSocket = null;
  let remoteWriter = null;
  let headerParsed = false;
  let closed = false;
  let userUuid = null;
  let clientIP = getClientIP(request);
  let childId = generateChildId(request.url);

  const safeClose = () => {
    if (closed) return;
    closed = true;

    if (userUuid) {
      activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
    }

    try { server.close(1000); } catch {}
    try { remoteWriter?.close(); } catch {}
    try { remoteSocket?.close(); } catch {}
  };

  const sendResponse = () => {
    try { server.send(new Uint8Array([0x00, 0x00])); } catch {}
  };

  server.addEventListener('message', async (event) => {
    try {
      let data = event.data;
      if (data instanceof Blob) data = await data.arrayBuffer();
      if (typeof data === 'string') data = new TextEncoder().encode(data).buffer;
      if (!(data instanceof ArrayBuffer)) data = new Uint8Array(data).buffer;

      // ۱. هدر VLESS فقط یک‌بار پردازش می‌شود
      if (!headerParsed) {
        const parsed = parseVlessHeader(data);
        if (!parsed.ok) return safeClose();
        headerParsed = true;
        userUuid = parsed.uuid;

        // دریافت کانفیگ کاربر از کش بدون درخواست غیرضروری به مادر
        const currentConfig = await getUserConfig(userUuid);
        if (!currentConfig || currentConfig.enabled === false) {
          return safeClose();
        }

        activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);

        if (parsed.cmd !== 1) return safeClose(); // فقط TCP پشتیبانی می‌شود

        let dstHost = parsed.address;
        let dstPort = parsed.port;

        if (currentConfig.blockAds && await isAdHost(dstHost)) {
          sendResponse();
          return safeClose();
        }

        if (dstPort === 53) {
          dstHost = ADGUARD_DNS_HOST;
          dstPort = ADGUARD_DNS_PORT;
        }

        try {
          remoteSocket = connect({ hostname: dstHost, port: dstPort });
          remoteWriter = remoteSocket.writable.getWriter();
          const reader = remoteSocket.readable.getReader();
          sendResponse();

          if (parsed.rest && parsed.rest.byteLength > 0) {
            trackUsage(userUuid, parsed.rest.byteLength, 0, clientIP);
            await remoteWriter.write(new Uint8Array(parsed.rest));
          }

          // دریافت دیتا از سرور مقصد و ارسال به کاربر
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength) {
                  trackUsage(userUuid, 0, value.byteLength, clientIP);
                  server.send(value);
                }
              }
            } catch {}
            safeClose();
          })();
        } catch {
          safeClose();
        }
        return;
      }

      // ۲. دیتای ترافیکی کاربر - هیچ درخواستی به مادر زده نمی‌شود!
      if (remoteWriter && data.byteLength > 0) {
        trackUsage(userUuid, data.byteLength, 0, clientIP);
        await remoteWriter.write(new Uint8Array(data));
      }
    } catch {
      safeClose();
    }
  });

  server.addEventListener('close', () => safeClose());
  server.addEventListener('error', () => safeClose());

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env, ctx) {
    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";
    const url = new URL(request.url);
    const path = url.pathname;
    const childId = generateChildId(request.url);
    const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

    if (isWs) {
      ctx.waitUntil(ensureBlocklist());
      return handleVlessWebSocket(request, ctx);
    }

    if (path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        id: childId,
        version: VERSION,
        silenced: isSilenced(),
      }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger - ارسال تجمعی گزارش مصرف به مادر
  async scheduled(event, env, ctx) {
    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";
    if (isSilenced()) return;

    const hostname = env.CHILD_HOSTNAME || env.WORKER_NAME || 'unknown';
    const childId = 'child-' + String(hostname).toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '-');

    // ۱. ارسال Heartbeat تجمعی در بازه Cron
    ctx.waitUntil(sendToMother('/api/node/report', {
      type: 'heartbeat',
      child_id: childId,
      url: env.CHILD_URL || `https://${hostname}`,
      version: VERSION,
      active: activeConns.size,
    }));

    // ۲. ارسال حجم مصرفی تجمع‌یافته کاربران به مادر
    ctx.waitUntil(flushUsageToMother(childId));
  },
};
