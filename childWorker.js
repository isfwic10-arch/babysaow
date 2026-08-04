// child-worker.js — v4.0-push (Push + State Exchange)
// فرزند هرگز درخواست آغاز نمی‌کند. فقط به POST /sync از مادر پاسخ می‌دهد.
import { connect } from 'cloudflare:sockets';

const VERSION = 'saow-node-4.0-push';
const API_SECRET = 'saow-pan2';

const REPORT_THRESHOLD = 30 * 1024 * 1024; // برای ردیابی محلی (دلتا)
const USER_CACHE_TTL = 20 * 60 * 1000;     // اگر sync نیاید، کش قدیمی تا ۲۰ دقیقه معتبر بماند
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

// ====================== State (محلی) ======================
/** @type {Map<string, UserConfig>} uuid -> config */
let usersByUuid = new Map();
/** @type {Map<string, string>} uuid -> user_id */
let uuidToId = new Map();
/** @type {Map<string, UsageDelta>} user_id -> {up, down} */
let usageDelta = new Map();
/** @type {Map<string, Set<string>>} user_id -> Set of active IPs */
let activeIpsByUser = new Map();
/** @type {Map<string, number>} uuid -> concurrent WS count */
const activeConns = new Map();

let nodeDisabled = false;
let lastSyncAt = 0;
let childId = 'child-unknown';

let blockSet = null;
let blockSetAt = 0;
let blockSetLoading = null;

// ====================== Types (JSDoc) ======================
/**
 * @typedef {Object} UserConfig
 * @property {string} id
 * @property {string} uuid
 * @property {string} [name]
 * @property {boolean} enabled
 * @property {string|null} expiry
 * @property {number} quotaBytes
 * @property {number} dailyQuotaBytes
 * @property {number} speedLimitKBps
 * @property {number} ipLimit
 * @property {boolean} blockAds
 */

/**
 * @typedef {Object} UsageDelta
 * @property {number} up
 * @property {number} down
 */

// ====================== Helpers ======================
function generateChildId(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return 'child-' + hostname.replace(/[^a-z0-9.-]/g, '').replace(/\./g, '-');
  } catch {
    return 'child-unknown';
  }
}

function getClientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

function extractSecret(request) {
  const h = request.headers;
  const auth = h.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (h.get('x-mother-secret') || h.get('x-api-key') || h.get('x-secret') || '').trim();
}

function requireMotherAuth(request) {
  const secret = extractSecret(request);
  return secret && secret === API_SECRET;
}

function isExpired(expiry) {
  if (!expiry) return false;
  const t = Date.parse(expiry);
  return Number.isFinite(t) && Date.now() > t;
}

function getUserByUuid(uuid) {
  if (!uuid) return null;
  const cfg = usersByUuid.get(String(uuid).toLowerCase());
  if (!cfg) return null;
  if (!cfg.enabled) return null;
  if (isExpired(cfg.expiry)) return null;
  return cfg;
}

function addUsageDelta(userId, up, down) {
  if (!userId || (up + down) <= 0) return;
  const cur = usageDelta.get(userId) || { up: 0, down: 0 };
  cur.up += up;
  cur.down += down;
  usageDelta.set(userId, cur);
}

function touchActiveIp(userId, ip) {
  if (!userId || !ip) return;
  let set = activeIpsByUser.get(userId);
  if (!set) {
    set = new Set();
    activeIpsByUser.set(userId, set);
  }
  set.add(ip);
}

function clearActiveIp(userId, ip) {
  if (!userId || !ip) return;
  const set = activeIpsByUser.get(userId);
  if (set) {
    set.delete(ip);
    if (set.size === 0) activeIpsByUser.delete(userId);
  }
}

function countActiveIps(userId) {
  const set = activeIpsByUser.get(userId);
  return set ? set.size : 0;
}

// ====================== Rate Limiter ======================
function createRateLimiter(kbps) {
  const bytesPerSec = kbps > 0 ? kbps * 1024 : 0;
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
      if (tokens >= n) {
        tokens -= n;
        return;
      }
      const need = n - tokens;
      const waitMs = Math.min(200, Math.max(8, Math.ceil((need / bytesPerSec) * 1000)));
      await new Promise((r) => setTimeout(r, waitMs));
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

// ====================== Ad Block ======================
function isAdHostLocal(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (/(^|\.)ads?\d*\./.test(h) || /(^|\.)adserver\./.test(h) || /(^|\.)tracking\./.test(h)) return true;
  return AD_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
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
          headers: { 'User-Agent': 'cf-child/4.0-push' },
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
  try {
    return await blockSetLoading;
  } finally {
    blockSetLoading = null;
  }
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

// ====================== VLESS Header ======================
function parseVlessHeader(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 19 || view.getUint8(0) !== 0) return { ok: false };
  const uuidBytes = new Uint8Array(buffer, 1, 16);
  let offset = 17;
  const addonLen = view.getUint8(offset);
  offset += 1 + addonLen;
  if (offset + 4 > buffer.byteLength) return { ok: false };
  const cmd = view.getUint8(offset);
  offset += 1;
  if (cmd !== 1 && cmd !== 2) return { ok: false };
  const port = view.getUint16(offset);
  offset += 2;
  const atype = view.getUint8(offset);
  offset += 1;
  let address = '';
  if (atype === 1) {
    if (offset + 4 > buffer.byteLength) return { ok: false };
    address = Array.from(new Uint8Array(buffer, offset, 4)).join('.');
    offset += 4;
  } else if (atype === 2) {
    const dlen = view.getUint8(offset);
    offset += 1;
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

  const uuidHex = Array.from(uuidBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const uuid = [
    uuidHex.slice(0, 8),
    uuidHex.slice(8, 12),
    uuidHex.slice(12, 16),
    uuidHex.slice(16, 20),
    uuidHex.slice(20),
  ].join('-');

  return {
    ok: true,
    cmd,
    address,
    port,
    uuid,
    rest: buffer.byteLength > offset ? buffer.slice(offset) : null,
  };
}

// ====================== Sync Handler (تنها نقطه ارتباط با مادر) ======================
async function handleSync(request) {
  if (!requireMotherAuth(request)) {
    return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid json' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (body?.type !== 'full_sync') {
    return new Response(JSON.stringify({ ok: false, reason: 'unknown type' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // ---- اعمال وضعیت نود ----
  nodeDisabled = !!(body.node && body.node.disabled);

  // ---- جایگزینی کامل لیست کاربران ----
  const newMap = new Map();
  const newUuidToId = new Map();
  const users = Array.isArray(body.users) ? body.users : [];

  for (const u of users) {
    if (!u || !u.uuid || !u.id) continue;
    const uuid = String(u.uuid).toLowerCase();
    const cfg = {
      id: String(u.id),
      uuid,
      name: u.name || '',
      enabled: u.enabled !== false,
      expiry: u.expiry || null,
      quotaBytes: Number(u.quotaBytes) || 0,
      dailyQuotaBytes: Number(u.dailyQuotaBytes) || 0,
      speedLimitKBps: Number(u.speedLimitKBps) || 0,
      ipLimit: Number(u.ipLimit) > 0 ? Number(u.ipLimit) : 1,
      blockAds: u.blockAds !== false,
    };
    newMap.set(uuid, cfg);
    newUuidToId.set(uuid, cfg.id);
  }

  usersByUuid = newMap;
  uuidToId = newUuidToId;
  lastSyncAt = Date.now();

  // ---- ساخت گزارش پاسخ (دلتا + وضعیت فعلی) ----
  const usageReport = [];
  for (const [userId, delta] of usageDelta.entries()) {
    if (delta.up + delta.down > 0) {
      usageReport.push({
        user_id: userId,
        up: delta.up,
        down: delta.down,
      });
    }
  }
  // بعد از ارسال، دلتاها را صفر می‌کنیم
  usageDelta = new Map();

  const activeIpsReport = [];
  for (const [userId, ipSet] of activeIpsByUser.entries()) {
    if (ipSet.size > 0) {
      activeIpsReport.push({
        user_id: userId,
        ips: Array.from(ipSet),
      });
    }
  }

  let activeUsersCount = 0;
  for (const c of activeConns.values()) {
    if (c > 0) activeUsersCount++;
  }

  const report = {
    ok: true,
    child_id: childId,
    version: VERSION,
    capacity: 64,
    active_users: activeUsersCount,
    healthy: !nodeDisabled,
    last_sync_received: lastSyncAt,
    usage: usageReport,
    active_ips: activeIpsReport,
    meta: {
      users_loaded: usersByUuid.size,
      node_disabled: nodeDisabled,
    },
  };

  return new Response(JSON.stringify(report), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// ====================== VLESS WebSocket Handler ======================
async function handleVlessWebSocket(request, ctx) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  if (nodeDisabled) {
    return new Response('Node disabled by mother', { status: 503 });
  }

  // اگر خیلی وقت است sync نیامده، می‌توانی fail-open یا fail-closed باشی.
  // اینجا fail-open کوتاه‌مدت می‌کنیم (تا USER_CACHE_TTL).
  if (lastSyncAt && Date.now() - lastSyncAt > USER_CACHE_TTL) {
    // هنوز از آخرین config استفاده می‌کنیم (fail-open)
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
  let lastReportedLocal = 0;
  let userUuid = null;
  let userId = null;
  let clientIP = getClientIP(request);
  let limiter = { enabled: false, async take() {} };
  let currentConfig = null;

  const safeClose = (reason = '') => {
    if (closed) return;
    closed = true;

    if (userUuid && joined) {
      activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
      if (userId) {
        // باقی‌مانده مصرف را به دلتا اضافه کن
        if (bytesUp + bytesDown > 0) {
          addUsageDelta(userId, bytesUp, bytesDown);
        }
        clearActiveIp(userId, clientIP);
      }
    }

    try {
      server.close(1000, reason);
    } catch {}
    try {
      remoteWriter?.close();
    } catch {}
    try {
      remoteSocket?.close();
    } catch {}
  };

  const sendResponse = () => {
    try {
      server.send(new Uint8Array([0x00, 0x00]));
    } catch {}
  };

  // مصرف را محلی جمع می‌کنیم؛ در sync بعدی به مادر گزارش می‌شود
  const maybeAccumulate = () => {
    if (sessionBytes - lastReportedLocal < REPORT_THRESHOLD) return true;
    if (userId) {
      addUsageDelta(userId, bytesUp, bytesDown);
      bytesUp = 0;
      bytesDown = 0;
    }
    lastReportedLocal = sessionBytes;
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
        userUuid = parsed.uuid.toLowerCase();

        if (nodeDisabled) return safeClose('node disabled');

        currentConfig = getUserByUuid(userUuid);
        if (!currentConfig) {
          return safeClose('user not found or disabled');
        }

        userId = currentConfig.id;

        // محدودیت IP همزمان (محلی)
        const currentIps = countActiveIps(userId);
        // اگر این IP قبلاً ثبت شده باشد، مشکلی نیست
        const already = activeIpsByUser.get(userId)?.has(clientIP);
        if (!already && currentIps >= (currentConfig.ipLimit || 1)) {
          return safeClose('ip limit');
        }

        joined = true;
        touchActiveIp(userId, clientIP);
        activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
        limiter = getLimiter(userUuid, currentConfig.speedLimitKBps || 0);

        if (parsed.cmd !== 1) return safeClose('only TCP');

        let dstHost = parsed.address;
        let dstPort = parsed.port;

        if (currentConfig.blockAds && (await isAdHost(dstHost))) {
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
                  maybeAccumulate();
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
        maybeAccumulate();
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

// ====================== Status Page ======================
async function serveStatusPage(request, id) {
  try {
    const res = await fetch(STATUS_HTML_URL, {
      headers: { 'User-Agent': 'cf-child/4.0-push' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error('fetch status html failed');

    let html = await res.text();
    const inject = `<script>window.__SAOW_VERSION__=${JSON.stringify(VERSION)};window.__SAOW_CHILD_ID__=${JSON.stringify(id)};</script>`;
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
           <p>Edge Node (Push Mode)</p>
           <p style="opacity:.7">Version: <b>${VERSION}</b></p>
           <p style="opacity:.5;font-size:0.85rem">${id}</p>
           <p style="opacity:.5;font-size:0.8rem">Last sync: ${lastSyncAt ? new Date(lastSyncAt).toISOString() : 'never'}</p>
         </div>
       </body></html>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }
    );
  }
}

// ====================== Main Entry ======================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    childId = generateChildId(request.url);
    const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

    // ---- تنها نقطه ورود مادر ----
    if (request.method === 'POST' && (path === '/sync' || path === '/sync/')) {
      return handleSync(request);
    }

    if (path === '/health') {
      let activeUsersCount = 0;
      for (const c of activeConns.values()) if (c > 0) activeUsersCount++;
      return new Response(
        JSON.stringify({
          ok: true,
          id: childId,
          version: VERSION,
          mode: 'push',
          activeUsers: activeUsersCount,
          usersLoaded: usersByUuid.size,
          nodeDisabled,
          lastSyncAt: lastSyncAt || null,
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    if (isWs) {
      if (nodeDisabled) {
        return new Response('Node disabled', { status: 503 });
      }
      ctx.waitUntil(ensureBlocklist());
      return handleVlessWebSocket(request, ctx);
    }

    if (path === '/') {
      return serveStatusPage(request, childId);
    }

    if (path === '/version') {
      return new Response(
        JSON.stringify({
          version: VERSION,
          role: 'node',
          mode: 'push',
          id: childId,
          nodeDisabled,
          lastSyncAt: lastSyncAt || null,
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  },

  // دیگر نیازی به scheduled نیست (فرزند ساکت است)
  // اگر Cron روی این Worker تنظیم شده باشد، کاری انجام نمی‌دهد.
  async scheduled(event, env, ctx) {
    // no-op in push mode
  },
};
