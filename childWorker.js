// child-worker.js — v3.2
import { connect } from 'cloudflare:sockets';

const VERSION = 'child-3.8';
let MOTHER_URL = null;
const API_SECRET = 'saow-pan';
const REPORT_THRESHOLD = 5 * 1024 * 1024;
const USER_CACHE_TTL = 30 * 1000;

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

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_SECRET}`,
    'X-API-Key': API_SECRET,
  };
}

async function reportToMother(payload) {
  if (!MOTHER_URL) return null;
  try {
    const res = await fetch(`${MOTHER_URL}/api/node/report`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.log('reportToMother failed', e?.message);
    return null;
  }
}

async function getUserConfig(uuid) {
  const cached = userCache.get(uuid);
  if (cached && Date.now() - cached.ts < USER_CACHE_TTL) return cached.data;
  try {
    const res = await fetch(`${MOTHER_URL}/api/users?uuid=${encodeURIComponent(uuid)}`, {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.user) {
        const u = data.user;
        const cfg = {
          enabled: u.enabled !== false,
          speedLimitKBps: u.speedLimitKBps || 0,
          blockAds: u.blockAds !== false,
          ipLimit: u.ipLimit || 1,
          quotaBytes: u.quotaBytes || 0,
          dailyQuotaBytes: u.dailyQuotaBytes || 0,
        };
        userCache.set(uuid, { data: cfg, ts: Date.now() });
        return cfg;
      }
    }
  } catch (e) {
    console.log('getUserConfig failed', e?.message);
  }
  return null;
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

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  let remoteSocket = null;
  let remoteWriter = null;
  let headerParsed = false;
  let closed = false;
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
    if (userUuid) {
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
      userCache.set(userUuid, { data: currentConfig, ts: Date.now() });
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

        currentConfig = await getUserConfig(userUuid);
        if (!currentConfig || currentConfig.enabled === false) {
          return safeClose('disabled');
        }

        // const LOCAL_MAX_CONNS = 32;
        // if ((activeConns.get(userUuid) || 0) >= LOCAL_MAX_CONNS) {
        //   return safeClose('local conn limit');
        // }

        const joinRes = await reportToMother({
          type: 'connect',
          child_id: childId,
          uuid: userUuid,
          ip: clientIP,
        });

        // fail-open: فقط اگر مادر صراحتاً بگوید ببند
        if (joinRes && (joinRes.action === 'close' || joinRes.enabled === false)) {
          return safeClose(joinRes?.reason || 'mother rejected');
        }

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

/** صفحه وضعیت از گیت‌هاب + تزریق نسخه */
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

    // Heartbeat روی مسیرهای معمولی + هر اتصال WebSocket
    if (path === '/health' || path === '/' || path === '/version' || isWs) {
      sendHeartbeat(ctx, childId, url.hostname);
    }

    if (path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        id: childId,
        version: VERSION,
        activeUsers: activeConns.size,
      }), { headers: { 'content-type': 'application/json' } });
    }

    if (isWs) {
      ctx.waitUntil(ensureBlocklist());
      return handleVlessWebSocket(request, ctx);
    }

    // صفحه HTML وضعیت
    if (path === '/') {
      return serveStatusPage(request, childId);
    }

    if (path === '/version') {
      return new Response(JSON.stringify({
        version: VERSION,
        role: 'node',
        id: childId,
      }), { headers: { 'content-type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  },

  // Cron Trigger (اگر ست شده باشد)
  async scheduled(event, env, ctx) {
    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";

    // اگر CHILD_HOSTNAME در binding وجود دارد از آن استفاده کن
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
