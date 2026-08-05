// child-worker.js — v4.9.4-proxyip (D1 + speed limit + revoke + ProxyIP for CF-blocked sites)
import { connect } from 'cloudflare:sockets';

const VERSION = 'node-4.9.5';
const API_SECRET = 'saow-pan2';
let MOTHER_URL = null;

const REPORT_THRESHOLD = 8 * 1024 * 1024; // هر ۸ مگ یک‌بار usage → کمتر D1
const STATUS_HTML_URL = 'https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/node-status.html';
const IP_IDLE_MS = 10 * 60 * 1000;
const SOFT_REJECT_DELAY_MS = 50;
const IP_CACHE_TTL_MS = 60 * 1000; // داخل isolate تا ۶۰ثانیه دوباره D1 نزن
const IP_CLEANUP_PROB = 0.08; // فقط ~۸٪ درخواست‌ها cleanup idle

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

// ====================== ProxyIP (for CF-blocked targets) ======================
// Public community ProxyIPs — no personal VPS required.
// These act as relays so Worker can reach sites behind Cloudflare (ChatGPT, Grok, etc.)
const DEFAULT_PROXY_IPS = [
  'proxyip.cmliussss.net',
  'proxyip.us.fxxk.dedyn.io',
  'proxyip.sg.fxxk.dedyn.io',
  'proxyip.jp.fxxk.dedyn.io',
  'proxyip.hk.fxxk.dedyn.io',
];

// Domains that usually fail with direct connect from Workers → force ProxyIP
const PROXY_FORCE_SUFFIXES = [
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
  'x.ai', 'grok.x.ai', 'grok.com',
  'anthropic.com', 'claude.ai',
  'gemini.google.com', 'bard.google.com',
  'perplexity.ai',
];

function getProxyIpList(env) {
  if (env?.PROXYIP) {
    const list = String(env.PROXYIP)
      .split(/[,|\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (list.length) return list;
  }
  return DEFAULT_PROXY_IPS;
}

function pickProxyIp(env) {
  const list = getProxyIpList(env);
  return list[Math.floor(Math.random() * list.length)];
}

function needsProxyIp(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return PROXY_FORCE_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

// ====================== In-memory ======================
let usersByUuid = new Map();
const activeConns = new Map();
/** uuid -> Set<{ close: Function }> */
const activeSessions = new Map();
const limiters = new Map();
const ipCache = new Map(); // `${userId}|${ip}` -> { at, ok }

let nodeDisabled = false;
let lastSyncAt = 0;
let childId = 'child-unknown';
let dbReady = false;
let _env = null;

let blockSet = null;
let blockSetAt = 0;
let blockSetLoading = null;

// ====================== D1 ======================
async function ensureDb(env) {
  if (!env?.DB) return false;
  if (dbReady) return true;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_state (
        key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_users (
        uuid TEXT PRIMARY KEY, id TEXT, name TEXT, enabled INTEGER DEFAULT 1,
        expiry TEXT, quota_bytes INTEGER DEFAULT 0, daily_quota_bytes INTEGER DEFAULT 0,
        speed_limit_kbps INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 1, block_ads INTEGER DEFAULT 1
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_active_ips (
        user_id TEXT NOT NULL, ip TEXT NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY (user_id, ip)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS node_usage_delta (
        user_id TEXT PRIMARY KEY, up INTEGER DEFAULT 0, down INTEGER DEFAULT 0
      )`),
    ]);
    dbReady = true;
    return true;
  } catch (e) {
    console.log('ensureDb:', e?.message);
    return false;
  }
}

async function saveUsersToDb(env, users, disabled) {
  if (!(await ensureDb(env))) return;
  try {
    const stmts = [
      env.DB.prepare('DELETE FROM node_users'),
      env.DB.prepare(
        `INSERT INTO node_state (key, value, updated_at) VALUES ('node_disabled', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).bind(disabled ? '1' : '0', Date.now()),
      env.DB.prepare(
        `INSERT INTO node_state (key, value, updated_at) VALUES ('last_sync', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).bind(String(Date.now()), Date.now()),
    ];
    for (const u of users) {
      if (!u?.uuid || !u?.id) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO node_users
           (uuid, id, name, enabled, expiry, quota_bytes, daily_quota_bytes, speed_limit_kbps, ip_limit, block_ads)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          String(u.uuid).toLowerCase(), String(u.id), u.name || '',
          u.enabled === false ? 0 : 1, u.expiry || null,
          Number(u.quotaBytes) || 0, Number(u.dailyQuotaBytes) || 0,
          Number(u.speedLimitKBps) || 0,
          Number(u.ipLimit) > 0 ? Number(u.ipLimit) : 1,
          u.blockAds === false ? 0 : 1
        )
      );
    }
    await env.DB.batch(stmts);
  } catch (e) {
    console.log('saveUsersToDb:', e?.message);
  }
}

async function loadUsersFromDb(env) {
  if (!(await ensureDb(env))) return false;
  try {
    const rows = await env.DB.prepare('SELECT * FROM node_users').all();
    const list = rows.results || [];
    if (!list.length) return false;
    const newMap = new Map();
    for (const r of list) {
      const uuid = String(r.uuid).toLowerCase();
      newMap.set(uuid, {
        id: String(r.id), uuid, name: r.name || '',
        enabled: !!r.enabled, expiry: r.expiry || null,
        quotaBytes: r.quota_bytes || 0, dailyQuotaBytes: r.daily_quota_bytes || 0,
        speedLimitKBps: r.speed_limit_kbps || 0, ipLimit: r.ip_limit || 1,
        blockAds: !!r.block_ads,
      });
    }
    usersByUuid = newMap;
    const dis = await env.DB.prepare(`SELECT value FROM node_state WHERE key='node_disabled'`).first();
    nodeDisabled = dis?.value === '1';
    const ls = await env.DB.prepare(`SELECT value FROM node_state WHERE key='last_sync'`).first();
    lastSyncAt = ls?.value ? Number(ls.value) : Date.now();
    return true;
  } catch (e) {
    console.log('loadUsersFromDb:', e?.message);
    return false;
  }
}

async function ensureUsersLoaded(env) {
  if (usersByUuid.size > 0 && lastSyncAt > 0) return;
  await loadUsersFromDb(env || _env);
}

async function dbAddUsage(env, userId, up, down) {
  if (!env?.DB || !userId || up + down <= 0) return;
  try {
    await ensureDb(env);
    await env.DB.prepare(`
      INSERT INTO node_usage_delta (user_id, up, down) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        up = up + excluded.up, down = down + excluded.down
    `).bind(userId, up, down).run();
  } catch (e) {
    console.log('dbAddUsage:', e?.message);
  }
}

async function dbLoadActiveIps(env) {
  if (!env?.DB) return [];
  try {
    await ensureDb(env);
    const cutoff = Date.now() - IP_IDLE_MS;
    await env.DB.prepare(`DELETE FROM node_active_ips WHERE last_seen < ?`).bind(cutoff).run();
    const rows = await env.DB.prepare(`SELECT user_id, ip FROM node_active_ips`).all();
    const map = new Map();
    for (const r of rows.results || []) {
      if (!map.has(r.user_id)) map.set(r.user_id, []);
      map.get(r.user_id).push(r.ip);
    }
    return Array.from(map.entries()).map(([user_id, ips]) => ({ user_id, ips }));
  } catch {
    return [];
  }
}

async function dbLoadAndClearUsage(env) {
  if (!env?.DB) return [];
  try {
    await ensureDb(env);
    const rows = await env.DB.prepare(
      `SELECT user_id, up, down FROM node_usage_delta WHERE up + down > 0`
    ).all();
    const list = (rows.results || []).map((r) => ({
      user_id: r.user_id, up: Number(r.up) || 0, down: Number(r.down) || 0,
    }));
    if (list.length) await env.DB.prepare(`DELETE FROM node_usage_delta`).run();
    return list;
  } catch {
    return [];
  }
}

/** IP limit با کش حافظه + cleanup کم‌هزینه */
async function tryAcquireIp(env, userId, ip, limit) {
  if (!env?.DB || !userId || !ip) return { ok: true, fallback: true };

  const ipStr = String(ip);
  const key = userId + '|' + ipStr;
  const now = Date.now();
  const cached = ipCache.get(key);
  if (cached && cached.ok && now - cached.at < IP_CACHE_TTL_MS) {
    return { ok: true, cached: true };
  }

  try {
    await ensureDb(env);

    await env.DB.prepare(`
      INSERT INTO node_active_ips (user_id, ip, last_seen) VALUES (?, ?, ?)
      ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen
    `).bind(userId, ipStr, now).run();

    if (Math.random() < IP_CLEANUP_PROB) {
      await env.DB.prepare(
        `DELETE FROM node_active_ips WHERE user_id = ? AND last_seen < ?`
      ).bind(userId, now - IP_IDLE_MS).run();
    }

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM node_active_ips WHERE user_id = ?`
    ).bind(userId).first();

    const current = Number(row?.c) || 0;
    if (current > limit) {
      await env.DB.prepare(
        `DELETE FROM node_active_ips WHERE user_id = ? AND ip = ?`
      ).bind(userId, ipStr).run();
      ipCache.delete(key);
      return { ok: false, reason: 'ip limit' };
    }

    ipCache.set(key, { at: now, ok: true });
    if (ipCache.size > 500) {
      const first = ipCache.keys().next().value;
      ipCache.delete(first);
    }
    return { ok: true };
  } catch (e) {
    const msg = e?.message || '';
    if (msg.includes('UNIQUE') || msg.includes('CONSTRAINT')) {
      ipCache.set(key, { at: now, ok: true });
      return { ok: true, already: true };
    }
    console.log('tryAcquireIp:', msg);
    return { ok: true, fallback: true };
  }
}

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
  return !!(secret && secret === API_SECRET);
}

function isExpired(expiry) {
  if (!expiry) return false;
  const t = Date.parse(expiry);
  return Number.isFinite(t) && Date.now() > t;
}

function getUserByUuid(uuid) {
  if (!uuid) return null;
  const cfg = usersByUuid.get(String(uuid).toLowerCase());
  if (!cfg || !cfg.enabled || isExpired(cfg.expiry)) return null;
  return cfg;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// ====================== Rate Limiter ======================
function createRateLimiter(kbps) {
  const bytesPerSec = kbps > 0 ? kbps * 1024 : 0;
  if (!bytesPerSec) return { enabled: false, async take() {} };

  const burst = Math.max(bytesPerSec * 2, 64 * 1024);
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
      const waitMs = Math.min(150, Math.max(5, Math.ceil((need / bytesPerSec) * 1000)));
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
          headers: { 'User-Agent': 'cf-child/4.9' },
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
    return hostInBlockset(host, await ensureBlocklist());
  } catch {
    return isAdHostLocal(host);
  }
}

// ====================== VLESS ======================
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

  const uuidHex = Array.from(uuidBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const uuid = [
    uuidHex.slice(0, 8), uuidHex.slice(8, 12), uuidHex.slice(12, 16),
    uuidHex.slice(16, 20), uuidHex.slice(20),
  ].join('-');

  return {
    ok: true, cmd, address, port, uuid,
    rest: buffer.byteLength > offset ? buffer.slice(offset) : null,
  };
}

// ====================== Sync ======================
async function handleSync(request, env) {
  if (!requireMotherAuth(request)) {
    return new Response(JSON.stringify({ ok: false, reason: 'unauthorized' }), {
      status: 403, headers: { 'content-type': 'application/json' },
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, reason: 'invalid json' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  if (body?.type !== 'full_sync') {
    return new Response(JSON.stringify({ ok: false, reason: 'unknown type' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }

  nodeDisabled = !!(body.node && body.node.disabled);
  const users = Array.isArray(body.users) ? body.users : [];
  const newMap = new Map();
  for (const u of users) {
    if (!u?.uuid || !u?.id) continue;
    const uuid = String(u.uuid).toLowerCase();
    newMap.set(uuid, {
      id: String(u.id), uuid, name: u.name || '',
      enabled: u.enabled !== false, expiry: u.expiry || null,
      quotaBytes: Number(u.quotaBytes) || 0,
      dailyQuotaBytes: Number(u.dailyQuotaBytes) || 0,
      speedLimitKBps: Number(u.speedLimitKBps) || 0,
      ipLimit: Number(u.ipLimit) > 0 ? Number(u.ipLimit) : 1,
      blockAds: u.blockAds !== false,
    });
  }

  usersByUuid = newMap;
  lastSyncAt = Date.now();
  ipCache.clear();

  // قطع اجباری کاربرانی که دیگر در لیست نیستند / غیرفعال / منقضی
  for (const [uuid, sessions] of [...activeSessions.entries()]) {
    const cfg = usersByUuid.get(uuid);
    const shouldDrop = !cfg || !cfg.enabled || isExpired(cfg.expiry);
    if (shouldDrop) {
      for (const s of sessions) {
        try { s.close(); } catch {}
      }
      activeSessions.delete(uuid);
      activeConns.delete(uuid);
    }
  }

  // اگر کل نود قفل شده، همه سشن‌ها را ببند
  if (nodeDisabled) {
    for (const [uuid, sessions] of [...activeSessions.entries()]) {
      for (const s of sessions) {
        try { s.close(); } catch {}
      }
      activeSessions.delete(uuid);
      activeConns.delete(uuid);
    }
  }

  await saveUsersToDb(env, users, nodeDisabled);

  const usageReport = await dbLoadAndClearUsage(env);
  const activeIpsReport = await dbLoadActiveIps(env);
  let activeUsersCount = 0;
  for (const c of activeConns.values()) if (c > 0) activeUsersCount++;
  if (activeIpsReport.length > activeUsersCount) activeUsersCount = activeIpsReport.length;

  return new Response(JSON.stringify({
    ok: true, child_id: childId, version: VERSION, capacity: 64,
    active_users: activeUsersCount, healthy: !nodeDisabled,
    last_sync_received: lastSyncAt, usage: usageReport, active_ips: activeIpsReport,
    meta: {
      users_loaded: usersByUuid.size, node_disabled: nodeDisabled,
      usage_entries: usageReport.length, ip_entries: activeIpsReport.length,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ====================== VLESS WebSocket ======================
async function handleVlessWebSocket(request, env, ctx) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  await ensureUsersLoaded(env);
  if (nodeDisabled) return new Response('Node disabled', { status: 503 });

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.binaryType = 'arraybuffer';
  server.accept({ allowHalfOpen: true });

  const envRef = env;
  const clientIP = getClientIP(request);

  let closed = false;
  let joined = false;
  let userUuid = null;
  let userId = null;
  let bytesUp = 0;
  let bytesDown = 0;
  let sessionBytes = 0;
  let lastReported = 0;
  let remoteSocket = null;
  let remoteWriter = null;
  let limiter = { enabled: false, async take() {} };
  let sessionRef = null;

  const flushUsage = () => {
    if (!userId || bytesUp + bytesDown === 0) return;
    const u = bytesUp, d = bytesDown;
    bytesUp = 0;
    bytesDown = 0;
    ctx.waitUntil(dbAddUsage(envRef, userId, u, d).catch(() => {}));
  };

  const maybeReport = () => {
    if (sessionBytes - lastReported >= REPORT_THRESHOLD) {
      flushUsage();
      lastReported = sessionBytes;
    }
  };

  const safeClose = (reason = '') => {
    if (closed) return;
    closed = true;
    if (userUuid && joined) {
      activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
      if (userId) flushUsage();
      if (sessionRef && activeSessions.has(userUuid)) {
        const set = activeSessions.get(userUuid);
        set.delete(sessionRef);
        if (set.size === 0) activeSessions.delete(userUuid);
      }
    }
    try { remoteWriter?.releaseLock(); } catch {}
    try { remoteSocket?.close(); } catch {}
    try {
      if (server.readyState === 1 || server.readyState === 2) server.close(1000, reason);
    } catch {}
  };

  const sendOk = () => {
    try { server.send(new Uint8Array([0, 0])); } catch {}
  };

  // early data
  let earlyData = null;
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  if (earlyHeader) {
    try {
      const b64 = earlyHeader.replace(/-/g, '+').replace(/_/g, '/');
      earlyData = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {}
  }

  const processChunk = async (chunk) => {
    if (closed || !(chunk instanceof Uint8Array) || chunk.byteLength === 0) return;

    // بعد از اتصال — ترافیک عادی
    if (remoteWriter) {
      // اگر در همین isolate کاربر revoke شده، قطع کن
      if (userUuid && !getUserByUuid(userUuid)) {
        return safeClose('revoked');
      }
      try {
        if (limiter.enabled) await limiter.take(chunk.byteLength);
        bytesUp += chunk.byteLength;
        sessionBytes += chunk.byteLength;
        maybeReport();
        await remoteWriter.write(chunk);
      } catch {
        safeClose('write fail');
      }
      return;
    }

    // هدر VLESS
    const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    const parsed = parseVlessHeader(buf);
    if (!parsed.ok) return safeClose('bad header');

    userUuid = parsed.uuid.toLowerCase();
    const cfg = getUserByUuid(userUuid);
    if (!cfg) return safeClose('user not found');
    userId = cfg.id;

    // فقط TCP (UDP غیر DNS رد)
    if (parsed.cmd === 2) {
      const isDns =
        parsed.port === 53 ||
        ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', 'dns.google', 'dns.google.com'].includes(parsed.address);
      if (!isDns) {
        sendOk();
        return safeClose('udp not supported');
      }
    } else if (parsed.cmd !== 1) {
      sendOk();
      return safeClose('only TCP');
    }

    const acq = await tryAcquireIp(envRef, userId, clientIP, cfg.ipLimit || 1);
    if (!acq.ok) {
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('ip limit');
    }

    joined = true;
    activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
    limiter = getLimiter(userUuid, cfg.speedLimitKBps || 0);

    // ثبت سشن برای قطع بعد از sync
    sessionRef = { close: () => safeClose('revoked') };
    if (!activeSessions.has(userUuid)) activeSessions.set(userUuid, new Set());
    activeSessions.get(userUuid).add(sessionRef);

    let host = parsed.address;
    let port = parsed.port;

    if (cfg.blockAds && (await isAdHost(host))) {
      joined = false;
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('ad blocked');
    }

    if (port === 53 || parsed.cmd === 2) {
      host = ADGUARD_DNS_HOST;
      port = ADGUARD_DNS_PORT;
    }

    // ProxyIP for domains that Cloudflare Workers cannot reach directly
    // (ChatGPT, Grok, Claude, etc.) — uses public community relays, no personal VPS
    let connectHost = host;
    const forceProxy = needsProxyIp(host) || !!envRef?.PROXYIP;
    if (forceProxy && port !== 53) {
      connectHost = pickProxyIp(envRef);
    }

    try {
      remoteSocket = connect({ hostname: connectHost, port });
      remoteWriter = remoteSocket.writable.getWriter();
      sendOk();

      if (parsed.rest && parsed.rest.byteLength > 0) {
        const first = new Uint8Array(parsed.rest);
        if (limiter.enabled) await limiter.take(first.byteLength);
        bytesUp += first.byteLength;
        sessionBytes += first.byteLength;
        await remoteWriter.write(first);
      }

      remoteSocket.readable
        .pipeTo(new WritableStream({
          async write(remoteChunk) {
            if (server.readyState !== 1) return;
            if (userUuid && !getUserByUuid(userUuid)) {
              safeClose('revoked');
              return;
            }
            if (limiter.enabled) await limiter.take(remoteChunk.byteLength);
            bytesDown += remoteChunk.byteLength;
            sessionBytes += remoteChunk.byteLength;
            maybeReport();
            try { server.send(remoteChunk); } catch { safeClose('ws send fail'); }
          },
          close() { safeClose('remote closed'); },
          abort() { safeClose('remote abort'); },
        }))
        .catch(() => safeClose('remote pipe'));
    } catch {
      safeClose('connect fail');
    }
  };

  server.addEventListener('message', (ev) => {
    const data = ev.data;
    if (data instanceof ArrayBuffer) {
      processChunk(new Uint8Array(data)).catch(() => safeClose());
    } else if (data instanceof Blob) {
      data.arrayBuffer().then((b) => processChunk(new Uint8Array(b))).catch(() => safeClose());
    } else if (typeof data === 'string') {
      processChunk(new TextEncoder().encode(data)).catch(() => safeClose());
    }
  });
  server.addEventListener('close', () => safeClose());
  server.addEventListener('error', () => safeClose());

  if (earlyData && earlyData.byteLength > 0) {
    ctx.waitUntil(processChunk(earlyData).catch(() => {}));
  }

  return new Response(null, { status: 101, webSocket: client });
}

// ====================== Status ======================
async function serveStatusPage(id) {
  try {
    const res = await fetch(STATUS_HTML_URL, {
      headers: { 'User-Agent': 'cf-child/4.9' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error('fetch failed');
    let html = await res.text();
    const inject = `<script>window.__SAOW_VERSION__=${JSON.stringify(VERSION)};window.__SAOW_CHILD_ID__=${JSON.stringify(id)};</script>`;
    html = html.includes('</head>') ? html.replace('</head>', inject + '</head>') : inject + html;
    return new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
    });
  } catch {
    return new Response(
      `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>Saow Node</title></head>
       <body style="background:#05060f;color:#e2e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
         <div style="text-align:center">
           <h1>SAOW</h1><p>Edge Node (Push + D1)</p>
           <p>Version: <b>${VERSION}</b></p>
           <p style="opacity:.5">${id}</p>
         </div></body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

// ====================== Main ======================
export default {
  async fetch(request, env, ctx) {
    try {
      _env = env;
      if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || '';

      const url = new URL(request.url);
      const path = url.pathname;
      childId = generateChildId(request.url);
      const isWs = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

      if (request.method === 'POST' && (path === '/sync' || path === '/sync/')) {
        return handleSync(request, env);
      }

      if (path === '/health') {
        await ensureUsersLoaded(env);
        const ips = await dbLoadActiveIps(env);
        let activeUsersCount = 0;
        for (const c of activeConns.values()) if (c > 0) activeUsersCount++;
        return new Response(JSON.stringify({
          ok: true, id: childId, version: VERSION, mode: 'push-d1',
          activeUsers: Math.max(activeUsersCount, ips.length),
          usersLoaded: usersByUuid.size, activeIpEntries: ips.length,
          nodeDisabled, lastSyncAt: lastSyncAt || null, hasDB: !!env.DB,
        }), { headers: { 'content-type': 'application/json' } });
      }

      if (isWs) {
        ctx.waitUntil(ensureBlocklist());
        return handleVlessWebSocket(request, env, ctx);
      }

      if (path === '/') return serveStatusPage(childId);

      if (path === '/version') {
        await ensureUsersLoaded(env);
        return new Response(JSON.stringify({
          version: VERSION, role: 'node', mode: 'push-d1', id: childId,
          usersLoaded: usersByUuid.size, nodeDisabled,
          lastSyncAt: lastSyncAt || null, hasDB: !!env.DB,
        }), { headers: { 'content-type': 'application/json' } });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      console.log('fetch fatal:', e?.message || e);
      return new Response('error', { status: 500 });
    }
  },
  async scheduled() {},
};
