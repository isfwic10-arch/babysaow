// child-worker.js — v3.11 (با حالت سکوت در صورت رد شدن توسط مادر)
import { connect } from 'cloudflare:sockets';

const VERSION = 'saow-node-3.14';
let MOTHER_URL = null;
const API_SECRET = 'saow-pan2';


const HEARTBEAT_MIN_INTERVAL_MS = 60 * 1000; // حداقل ۱ دقیقه
const REPORT_MIN_INTERVAL_MS = 1000;         // سقف کلی: حداکثر ~۱ report/sec (قابل تنظیم)
let lastHeartbeatAt = 0;
let lastReportAt = 0;
let reportQueueTail = Promise.resolve();

const REPORT_THRESHOLD = 30 * 1024 * 1024;   // ۳۰ مگابایت
const USER_CACHE_TTL = 8 * 60 * 1000;        // ۸ دقیقه
const NEGATIVE_CACHE_TTL = 60 * 1000;        // کش منفی ۶۰ ثانیه
const ATTEMPT_COOLDOWN_MS = 8 * 1000;        // حداقل ۸ ثانیه بین تلاش‌های یک UUID
const SILENCE_TTL_MS = 30 * 60 * 1000;       // ۳۰ دقیقه سکوت بعد از رد شدن توسط مادر

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

// ---- حالت سکوت سراسری ----
let silenceUntil = 0; // timestamp

function isSilenced() {
  return Date.now() < silenceUntil;
}

function enterSilence(reason = '') {
  silenceUntil = Date.now() + SILENCE_TTL_MS;
  console.log('SILENCE ON:', reason, 'until', new Date(silenceUntil).toISOString());
}

function clearSilence() {
  silenceUntil = 0;
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

function createRateLimiter(kbps) {
  const bytesPerSec = (kbps > 0) ? kbps * 1024 : 0;
  if (!bytesPerSec) return { enabled: false, async take() {} };
  const burst = Math.max(bytesPerSec, 32 * 1024);
  let tokens = burst;
  let last = Date.now();
  let tail = Promise.resolve();
  const doTake = async (n) => {
    n = Math.max(0, n | 0);
    if (!n) return;
    for (;;) {
      const now = Date.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * bytesPerSec);
      last = now;
      if (tokens >= n) { tokens -= n; return; }
      const need = n - tokens;
      const waitMs = Math.min(200, Math.max(8, Math.ceil((need / bytesPerSec) * 1000)));
      await new Promise(r => setTimeout(r, waitMs));
    }
  };
  return {
    enabled: true,
    take(n) {
      const run = tail.then(() => doTake(n));
      tail = run.catch(() => {});
      return run;
    },
  };
}

const limiters = new Map();
function getLimiter(uuid, kbps) {
  if (!kbps || kbps <= 0) return { enabled: false, async take() {} };
  let entry = limiters.get(uuid);
  if (!entry || entry.kbps !== kbps) {
    entry = { kbps, limiter: createRateLimiter(kbps) };
    limiters.set(uuid, entry);
  }
  return entry.limiter;
}

const userCache = new Map();
const activeConns = new Map();
const recentAttempts = new Map();

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_SECRET}`,
    'X-API-Key': API_SECRET,
  };
}

/** تشخیص اینکه مادر این نود را رد کرده */
function isNodeRejection(status, data) {
  if (status === 401 || status === 403) return true;
  if (!data) return false;
  const reason = String(data.reason || data.err || '').toLowerCase();
  if (reason.includes('unknown node')) return true;
  if (reason.includes('not registered')) return true;
  if (reason.includes('node is not registered')) return true;
  if (reason.includes('unauthorized')) return true;
  return false;
}

async function reportToMother(payload) {
  if (!MOTHER_URL) return null;
  if (isSilenced()) return null;

  // throttle سخت برای heartbeat
  if (payload?.type === 'heartbeat') {
    const now = Date.now();
    if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return null;
    lastHeartbeatAt = now;
  }

  // throttle نرم برای همه reportها (جلوگیری از burst)
  const now = Date.now();
  const wait = Math.max(0, REPORT_MIN_INTERVAL_MS - (now - lastReportAt));
  lastReportAt = now + wait;

  const run = async () => {
    if (wait) await new Promise(r => setTimeout(r, wait));
    if (isSilenced()) return null;

    try {
      const res = await fetch(`${MOTHER_URL}/api/node/report`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });

      let data = null;
      try { data = await res.json(); } catch {}

      if (isNodeRejection(res.status, data)) {
        enterSilence(`report ${payload.type} → ${res.status}`);
        return null;
      }
      if (!res.ok) return null;
      return data;
    } catch (e) {
      console.log('reportToMother failed', e?.message);
      return null;
    }
  };

  // serialize کردن reportها تا هم‌زمان شلیک نشوند
  const p = reportQueueTail.then(run, run);
  reportQueueTail = p.catch(() => null);
  return p;
}


// جایگزین userCache محلی
async function getUserConfig(uuid) {
  if (isSilenced()) return null;

  const cacheKey = new Request(`https://cache.saow/user/${uuid}`);
  const cache = caches.default;

  // 1. اول از Cache API بخوان
  let cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    if (Date.now() - data.ts < (data.negative ? NEGATIVE_CACHE_TTL : USER_CACHE_TTL)) {
      return data.cfg;
    }
  }

  // 2. اگر نبود، از مادر بگیر
  try {
    const res = await fetch(`${MOTHER_URL}/api/users?uuid=${encodeURIComponent(uuid)}`, {
      headers: authHeaders(),
    });
    let data = null;
    try { data = await res.json(); } catch {}

    if (isNodeRejection(res.status, data)) {
      enterSilence(`getUserConfig → ${res.status}`);
      return null;
    }

    let cfg = null;
    let negative = true;

    if (res.ok && data?.ok && data.user) {
      const u = data.user;
      cfg = {
        enabled:         u.enabled !== false,
        speedLimitKBps:  u.speedLimitKBps || 0,
        blockAds:        u.blockAds !== false,
        ipLimit:         u.ipLimit || 1,
        quotaBytes:      u.quotaBytes || 0,
        dailyQuotaBytes: u.dailyQuotaBytes || 0,
      };
      if (cfg.enabled === false) cfg = null;
      else negative = false;
    }

    // 3. در Cache API بنویس (بین همه Isolateها مشترک)
    const body = JSON.stringify({ cfg, ts: Date.now(), negative });
    const response = new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${negative ? 120 : 900}`, // 2 یا 15 دقیقه
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone())); // اگر ctx در دسترس نباشد، بدون waitUntil هم کار می‌کند

    return cfg;
  } catch (e) {
    console.log('getUserConfig failed', e?.message);
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

  // اگر در حالت سکوت هستیم، اصلاً به مادر وصل نشو
  if (isSilenced()) {
    return new Response('Node silenced', { status: 503 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let remoteSocket = null;
  let remoteWriter = null;
  let headerParsed = false;
  let closed = false;
  let joined = false;
  let bytesUp = 0;
  let bytesDown = 0;
  let sessionBytes = 0;
  let lastReported = 0;
  let userUuid = null;
  let clientIP = getClientIP(request);
  let limiter = { enabled: false, async take() {} };
  let currentConfig = null;
  let childId = generateChildId(request.url);

  const safeClose = (reason = '') => {
    if (closed) return;
    closed = true;

    if (userUuid && joined) {
      activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
      ctx.waitUntil(reportToMother({
        type: 'disconnect',
        child_id: childId,
        uuid: userUuid,
        ip: clientIP,
        up: bytesUp,
        down: bytesDown,
      }));
    }

    try { server.close(1000, reason); } catch {}
    try { remoteWriter?.close(); } catch {}
    try { remoteSocket?.close(); } catch {}
  };

  const sendResponse = () => {
    try { server.send(new Uint8Array([0x00, 0x00])); } catch {}
  };

  const maybeReportUsage = async () => {
    if (isSilenced()) return false;
    if (sessionBytes - lastReported < REPORT_THRESHOLD) return true;
    lastReported = sessionBytes;
    const res = await reportToMother({
      type: 'usage',
      child_id: childId,
      uuid: userUuid,
      ip: clientIP,
      up: bytesUp,
      down: bytesDown,
    });
    if (!res || !res.ok) return true;
    if (res.action === 'close' || res.enabled === false) return false;
    if (res.config) {
      currentConfig = { ...currentConfig, ...res.config };
      limiter = getLimiter(userUuid, currentConfig.speedLimitKBps || 0);
      userCache.set(userUuid, { data: currentConfig, ts: Date.now(), negative: false });
    }
    return true;
  };

  server.addEventListener('message', async (event) => {
    try {
      let data = event.data;
      if (data instanceof Blob) data = await data.arrayBuffer();
      if (typeof data === 'string') data = new TextEncoder().encode(data).buffer;
      if (!(data instanceof ArrayBuffer)) data = new Uint8Array(data).buffer;

      if (!headerParsed) {
        const parsed = parseVlessHeader(data);
        if (!parsed.ok) return safeClose('bad header');
        headerParsed = true;
        userUuid = parsed.uuid;

        if (isSilenced()) return safeClose('silenced');

        const lastAttempt = recentAttempts.get(userUuid) || 0;
        if (Date.now() - lastAttempt < ATTEMPT_COOLDOWN_MS) {
          return safeClose('rate limited');
        }
        recentAttempts.set(userUuid, Date.now());

        currentConfig = await getUserConfig(userUuid);
        if (!currentConfig || currentConfig.enabled === false) {
          return safeClose('disabled');
        }

        const joinRes = await reportToMother({
          type: 'connect',
          child_id: childId,
          uuid: userUuid,
          ip: clientIP,
        });

        if (joinRes && (joinRes.action === 'close' || joinRes.enabled === false)) {
          userCache.set(userUuid, { data: null, ts: Date.now(), negative: true });
          return safeClose(joinRes?.reason || 'mother rejected');
        }

        joined = true;

        if (joinRes?.config) currentConfig = { ...currentConfig, ...joinRes.config };
        activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
        limiter = getLimiter(userUuid, currentConfig.speedLimitKBps || 0);

        if (parsed.cmd !== 1) return safeClose('only TCP');

        let dstHost = parsed.address;
        let dstPort = parsed.port;

        if (currentConfig.blockAds && await isAdHost(dstHost)) {
          sendResponse();
          return safeClose('ad blocked');
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
            await limiter.take(parsed.rest.byteLength);
            bytesUp += parsed.rest.byteLength;
            sessionBytes += parsed.rest.byteLength;
            await remoteWriter.write(new Uint8Array(parsed.rest));
          }

          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength) {
                  if (!(await maybeReportUsage())) return safeClose('quota');
                  await limiter.take(value.byteLength);
                  bytesDown += value.byteLength;
                  sessionBytes += value.byteLength;
                  try {
                    server.send(value);
                  } catch {
                    return safeClose('ws send fail');
                  }
                }
              }
            } catch {}
            safeClose();
          })();
        } catch (e) {
          safeClose('connect fail');
        }
        return;
      }

      if (remoteWriter && data.byteLength > 0) {
        if (!(await maybeReportUsage())) return safeClose('quota');
        await limiter.take(data.byteLength);
        bytesUp += data.byteLength;
        sessionBytes += data.byteLength;
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

async function serveStatusPage(request, childId) {
  try {
    const res = await fetch(STATUS_HTML_URL, {
      headers: { 'User-Agent': 'cf-child/3.2' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error('fetch status html failed');

    let html = await res.text();
    const inject = `<script>window.__SAOW_VERSION__=${JSON.stringify(VERSION)};window.__SAOW_CHILD_ID__=${JSON.stringify(childId)};</script>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', inject + '</head>');
    } else {
      html = inject + html;
    }

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (e) {
    return new Response(
      `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>Saow Node</title></head>
       <body style="background:#05060f;color:#e2e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
         <div style="text-align:center">
           <h1 style="font-size:2.5rem;letter-spacing:.15em">SAOW</h1>
           <p>Edge Node</p>
           <p style="opacity:.7">Version: <b>${VERSION}</b></p>
           <p style="opacity:.5;font-size:0.85rem">${childId}</p>
         </div>
       </body></html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  }
}

function sendHeartbeat(ctx, childId, hostname) {
  if (isSilenced()) return; // سکوت → هیچ heartbeat نزن
  ctx.waitUntil(reportToMother({
    type: 'heartbeat',
    child_id: childId,
    url: `https://${hostname}`,
    version: VERSION,
    active: activeConns.size,
  }));
}

export default {
  async fetch(request, env, ctx) {
    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";
    const url = new URL(request.url);
    const path = url.pathname;
    const childId = generateChildId(request.url);
    const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

    if (path === '/health' || path === '/' || path === '/version') {
      sendHeartbeat(ctx, childId, url.hostname);
    }

    if (path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        id: childId,
        version: VERSION,
        activeUsers: activeConns.size,
        silenced: isSilenced(),
        silenceUntil: silenceUntil || null,
      }), { headers: { 'content-type': 'application/json' } });
    }

    if (isWs) {
      if (isSilenced()) {
        return new Response('Node temporarily unavailable', { status: 503 });
      }
      ctx.waitUntil(ensureBlocklist());
      return handleVlessWebSocket(request, ctx);
    }

    if (path === '/') {
      return serveStatusPage(request, childId);
    }

    if (path === '/version') {
      return new Response(JSON.stringify({
        version: VERSION,
        role: 'node',
        id: childId,
        silenced: isSilenced(),
      }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";
    if (isSilenced()) return; // سکوت → cron هم چیزی نفرستد

    const hostname = env.CHILD_HOSTNAME || env.WORKER_NAME || 'unknown';
    const childId = 'child-' + String(hostname).toLowerCase().replace(/[^a-z0-9.-]/g, '').replace(/\./g, '-');

    ctx.waitUntil(reportToMother({
      type: 'heartbeat',
      child_id: childId,
      url: env.CHILD_URL || `https://${hostname}`,
      version: VERSION,
      active: activeConns.size,
    }));

    ctx.waitUntil(ensureBlocklist());
  },
};
