// worker.js — VLESS/WS + clean CF IPs + UUID token + D1 + limits + online ad blocklist + GitHub domains
import { connect } from 'cloudflare:sockets';
const VERSION = 'minimal-multi-1.9-oisd-domains';
const API_ROOT = '/91233447dsfY';
const SUB_PATH = '/pull';
// ===================== DEFAULT USERS (overrides in D1) =====================
const MOCK_USERS = [
  {
    id: 'u1',
    name: 'alice',
    uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    enabled: true,
    expiry: null,
    quotaBytes: 0,
    dailyQuotaBytes: 0,
    speedLimitKBps: 0,
    ipLimit: 1,
    cleanIp: '',
    blockAds: true,
    notes: 'default test user',
  },
  {
    id: 'u2',
    name: 'bob',
    uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    enabled: true,
    expiry: null,
    quotaBytes: 5 * 1024 * 1024 * 1024,
    dailyQuotaBytes: 1 * 1024 * 1024 * 1024,
    speedLimitKBps: 0,
    ipLimit: 1,
    cleanIp: '',
    blockAds: false,
    notes: 'limited user',
  },
];
const ADGUARD_DNS_HOST = 'dns.adguard.com';
const ADGUARD_DNS_PORT = 53;
// Fallback local suffixes (used before/without online list)
const AD_HOST_SUFFIXES = [
  'doubleclick.net', 'googleadservices.com', 'googlesyndication.com',
  'googletagmanager.com', 'googletagservices.com', 'google-analytics.com',
  'adservice.google.com', 'pagead2.googlesyndication.com',
  'facebook.net', 'scorecardresearch.com', 'adnxs.com', 'adsrvr.org',
  'taboola.com', 'outbrain.com', 'moatads.com', 'criteo.com', 'hotjar.com',
  'adform.net', 'pubmatic.com', 'openx.net',
];
function isAdHostLocal(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (/(^|\.)ads?\d*\./.test(h) || /(^|\.)adserver\./.test(h) || /(^|\.)tracking\./.test(h)) return true;
  for (const s of AD_HOST_SUFFIXES) {
    if (h === s || h.endsWith('.' + s)) return true;
  }
  return false;
}
// ===================== ONLINE BLOCKLIST (OISD small) =====================
const BLOCKLIST_URLS = [
  'https://small.oisd.nl/domainswild2',
  'https://raw.githubusercontent.com/sjhgvr/oisd/main/domainswild2_small.txt',
];
const BLOCKLIST_TTL_MS = 6 * 60 * 60 * 1000;
let blockSet = null;
let blockSetAt = 0;
let blockSetSize = 0;
let blockSetSource = '';
let blockSetLoading = null;
function parseBlocklistText(text) {
  const set = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim().toLowerCase();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.startsWith('0.0.0.0 ') || line.startsWith('127.0.0.1 ')) {
      const parts = line.split(/\s+/);
      line = parts[1] || '';
    }
    line = line.replace(/^\|\|/, '').replace(/\^.*$/, '').replace(/^\*\./, '').replace(/^\./, '');
    if (!line || line.length < 3 || line.length > 253) continue;
    if (/[^a-z0-9.-]/.test(line)) continue;
    set.add(line);
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
          headers: { 'User-Agent': 'cf-worker-block/1.9' },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!r.ok) continue;
        const text = await r.text();
        const set = parseBlocklistText(text);
        if (set.size > 100) {
          blockSet = set;
          blockSetAt = Date.now();
          blockSetSize = set.size;
          blockSetSource = url;
          console.log('blocklist loaded', set.size, url);
          return set;
        }
      } catch (e) {
        console.error('blocklist fetch fail', url, e && e.message);
      }
    }
    if (blockSet) return blockSet;
    blockSet = new Set(AD_HOST_SUFFIXES);
    blockSetAt = Date.now();
    blockSetSize = blockSet.size;
    blockSetSource = 'local-fallback';
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
    const suffix = h.slice(i + 1);
    if (set.has(suffix)) return true;
    i = h.indexOf('.', i + 1);
  }
  return false;
}
async function isAdHostOnline(host) {
  if (isAdHostLocal(host)) return true;
  try {
    const set = await ensureBlocklist();
    return hostInBlockset(host, set);
  } catch (_) {
    return isAdHostLocal(host);
  }
}
// ===================== GITHUB DOMAINS / IPs (for first configs) =====================
const DOMAINS_URL = 'https://raw.githubusercontent.com/isfwic10-arch/cf-domains/refs/heads/main/domains.txt';
const DOMAINS_TTL_MS = 30 * 60 * 1000; // 30 min
let domainsList = null;
let domainsListAt = 0;
let domainsListSource = '';
let domainsLoading = null;
function parseDomainsText(text) {
  const list = [];
  const seen = new Set();
  // Support comma-separated (main format) or one-per-line
  const raw = String(text || '').replace(/\r/g, '\n');
  const parts = raw.split(/[\n,;]+/);
  for (let p of parts) {
    p = p.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!p || p.length < 3 || p.length > 253) continue;
    // allow domain or IPv4 / simple IPv6
    if (/[^a-z0-9.:-]/i.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    list.push(p);
  }
  return list;
}
async function ensureDomainsList() {
  const now = Date.now();
  if (domainsList && now - domainsListAt < DOMAINS_TTL_MS) return domainsList;
  if (domainsLoading) return domainsLoading;
  domainsLoading = (async () => {
    try {
      const r = await fetch(DOMAINS_URL, {
        headers: { 'User-Agent': 'cf-worker-domains/1.9' },
        cf: { cacheTtl: 1800, cacheEverything: true },
      });
      if (r.ok) {
        const text = await r.text();
        const list = parseDomainsText(text);
        if (list.length > 0) {
          domainsList = list;
          domainsListAt = Date.now();
          domainsListSource = DOMAINS_URL;
          console.log('domains loaded', list.length, DOMAINS_URL);
          return list;
        }
      }
    } catch (e) {
      console.error('domains fetch fail', e && e.message);
    }
    // keep previous if any
    if (domainsList && domainsList.length) return domainsList;
    domainsList = [];
    domainsListAt = Date.now();
    domainsListSource = 'empty';
    return domainsList;
  })();
  try {
    return await domainsLoading;
  } finally {
    domainsLoading = null;
  }
}
// ===================== D1 INIT =====================
function todayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
async function d1Ready(env) {
  if (!env.DB) return false;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage (
        user_id TEXT PRIMARY KEY,
        up INTEGER NOT NULL DEFAULT 0,
        down INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage_daily (
        user_id TEXT NOT NULL,
        day TEXT NOT NULL,
        up INTEGER NOT NULL DEFAULT 0,
        down INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS active_ips (
        user_id TEXT NOT NULL,
        ip TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (user_id, ip)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS speed_budget (
        user_id TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        bytes INTEGER NOT NULL
      )`),
    ]);
    return true;
  } catch (e) {
    console.error('d1 init', e);
    return false;
  }
}
// ===================== USER SETTINGS =====================
async function loadUserOverrides(env) {
  if (!(await d1Ready(env))) return {};
  try {
    const rows = await env.DB.prepare('SELECT user_id, json FROM user_settings').all();
    const map = {};
    for (const r of (rows.results || [])) {
      try { map[r.user_id] = JSON.parse(r.json); } catch (_) {}
    }
    return map;
  } catch { return {}; }
}
async function saveUserOverride(env, userId, patch) {
  if (!(await d1Ready(env))) return false;
  const now = Date.now();
  let prev = {};
  try {
    const row = await env.DB.prepare('SELECT json FROM user_settings WHERE user_id = ?').bind(userId).first();
    if (row?.json) prev = JSON.parse(row.json);
  } catch (_) {}
  const next = { ...prev, ...patch };
  delete next.id;
  delete next.uuid;
  await env.DB.prepare(`
    INSERT INTO user_settings (user_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).bind(userId, JSON.stringify(next), now).run();
  return true;
}
async function fetchUsersFromApi(env) {
  const overrides = await loadUserOverrides(env);
  const users = MOCK_USERS.map(u => {
    const o = overrides[u.id] || {};
    return { ...u, ...o, id: u.id, uuid: u.uuid };
  });
  return { ok: true, users, fetchedAt: Date.now() };
}
async function pushUserUpdateToApi(env, patch) {
  const base = MOCK_USERS.find(u => u.id === patch.id);
  if (!base) return { ok: false, error: 'user not found' };
  const { id, uuid, ...rest } = patch;
  await saveUserOverride(env, patch.id, rest);
  const overrides = await loadUserOverrides(env);
  const o = overrides[patch.id] || {};
  return { ok: true, user: { ...base, ...o, id: base.id, uuid: base.uuid } };
}
let usersCache = null;
let usersCacheAt = 0;
const USERS_CACHE_MS = 5000;
async function getUsers(env) {
  const now = Date.now();
  if (usersCache && now - usersCacheAt < USERS_CACHE_MS) return usersCache;
  const res = await fetchUsersFromApi(env);
  usersCache = Array.isArray(res.users) ? res.users : [];
  usersCacheAt = now;
  return usersCache;
}
async function getUserByToken(env, token) {
  if (!token) return null;
  const t = String(token).trim().toLowerCase();
  const users = await getUsers(env);
  return users.find(u => String(u.uuid || '').toLowerCase() === t) || null;
}
async function getUserById(env, id) {
  const users = await getUsers(env);
  return users.find(u => u.id === id) || null;
}
// ===================== CONN COUNTERS =====================
const activeConns = new Map();
function connInc(userId) { activeConns.set(userId, (activeConns.get(userId) || 0) + 1); }
function connDec(userId) {
  const n = (activeConns.get(userId) || 0) - 1;
  if (n <= 0) activeConns.delete(userId);
  else activeConns.set(userId, n);
}
function connGet(userId) { return activeConns.get(userId) || 0; }
// ===================== USAGE =====================
async function usageGet(env, userId) {
  if (!(await d1Ready(env))) return { up: 0, down: 0, total: 0 };
  try {
    const row = await env.DB.prepare('SELECT up, down, total FROM usage WHERE user_id = ?').bind(userId).first();
    return row ? { up: row.up || 0, down: row.down || 0, total: row.total || 0 } : { up: 0, down: 0, total: 0 };
  } catch { return { up: 0, down: 0, total: 0 }; }
}
async function usageGetDaily(env, userId, day = todayKey()) {
  if (!(await d1Ready(env))) return { up: 0, down: 0, total: 0 };
  try {
    const row = await env.DB.prepare('SELECT up, down, total FROM usage_daily WHERE user_id = ? AND day = ?').bind(userId, day).first();
    return row ? { up: row.up || 0, down: row.down || 0, total: row.total || 0 } : { up: 0, down: 0, total: 0 };
  } catch { return { up: 0, down: 0, total: 0 }; }
}
async function usageAdd(env, userId, up, down) {
  up = up || 0; down = down || 0;
  if (up + down <= 0 || !(await d1Ready(env))) return;
  const now = Date.now();
  const day = todayKey();
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO usage (user_id, up, down, total, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          up = up + excluded.up, down = down + excluded.down,
          total = total + excluded.total, updated_at = excluded.updated_at
      `).bind(userId, up, down, up + down, now),
      env.DB.prepare(`
        INSERT INTO usage_daily (user_id, day, up, down, total) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET
          up = up + excluded.up, down = down + excluded.down, total = total + excluded.total
      `).bind(userId, day, up, down, up + down),
    ]);
  } catch (e) { console.error('usageAdd', e); }
}
const pendingUsage = new Map();
function recordUsage(env, ctx, userId, up, down) {
  if (!userId || (up + down <= 0)) return;
  const cur = pendingUsage.get(userId) || { up: 0, down: 0 };
  cur.up += up || 0;
  cur.down += down || 0;
  pendingUsage.set(userId, cur);
  const flush = async () => {
    const entries = [...pendingUsage.entries()];
    pendingUsage.clear();
    for (const [id, v] of entries) await usageAdd(env, id, v.up, v.down);
  };
  if (ctx?.waitUntil) {
    let totalPending = 0;
    for (const v of pendingUsage.values()) totalPending += v.up + v.down;
    if (totalPending > 512 * 1024) ctx.waitUntil(flush());
    else ctx.waitUntil((async () => { await new Promise(r => setTimeout(r, 3000)); await flush(); })());
  }
}
// ===================== DEVICE IP LIMIT =====================
const IP_IDLE_MS = 90_000;
async function touchAndCheckIpLimit(env, user, clientIp) {
  const limit = Number(user.ipLimit) > 0 ? Number(user.ipLimit) : 0;
  if (!limit || !clientIp) return { ok: true, online: 0 };
  if (!(await d1Ready(env))) return { ok: true, online: 0 };
  const now = Date.now();
  try {
    await env.DB.prepare(
      'DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?'
    ).bind(user.id, now - IP_IDLE_MS).run();
    const existing = await env.DB.prepare(
      'SELECT ip FROM active_ips WHERE user_id = ? AND ip = ?'
    ).bind(user.id, clientIp).first();
    if (existing) {
      await env.DB.prepare(
        'UPDATE active_ips SET last_seen = ? WHERE user_id = ? AND ip = ?'
      ).bind(now, user.id, clientIp).run();
    } else {
      const cntRow = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM active_ips WHERE user_id = ?'
      ).bind(user.id).first();
      const online = (cntRow && cntRow.c) || 0;
      if (online >= limit) return { ok: false, online, reason: 'ip-limit' };
      await env.DB.prepare(
        'INSERT INTO active_ips (user_id, ip, last_seen) VALUES (?, ?, ?) ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen'
      ).bind(user.id, clientIp, now).run();
    }
    const all = await env.DB.prepare(
      'SELECT ip, last_seen FROM active_ips WHERE user_id = ? ORDER BY last_seen DESC'
    ).bind(user.id).all();
    const rows = all.results || [];
    if (rows.length > limit) {
      const keep = new Set(rows.slice(0, limit).map(r => r.ip));
      for (const r of rows) {
        if (!keep.has(r.ip)) {
          await env.DB.prepare(
            'DELETE FROM active_ips WHERE user_id = ? AND ip = ?'
          ).bind(user.id, r.ip).run();
        }
      }
      if (!keep.has(clientIp)) return { ok: false, online: limit, reason: 'ip-limit' };
    }
    const finalCnt = await env.DB.prepare(
      'SELECT COUNT(*) AS c FROM active_ips WHERE user_id = ?'
    ).bind(user.id).first();
    return { ok: true, online: (finalCnt && finalCnt.c) || 1 };
  } catch (e) {
    console.error('ip limit', e);
    return { ok: true, online: 0 };
  }
}
async function listActiveIps(env, userId) {
  if (!(await d1Ready(env))) return [];
  try {
    const now = Date.now();
    await env.DB.prepare('DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?')
      .bind(userId, now - IP_IDLE_MS).run();
    const rows = await env.DB.prepare(
      'SELECT ip, last_seen FROM active_ips WHERE user_id = ? ORDER BY last_seen DESC'
    ).bind(userId).all();
    return (rows.results || []).map(r => ({
      ip: r.ip,
      lastSeen: r.last_seen,
      ageSec: Math.floor((now - r.last_seen) / 1000),
    }));
  } catch { return []; }
}
async function clearActiveIps(env, userId) {
  if (!(await d1Ready(env))) return false;
  try {
    await env.DB.prepare('DELETE FROM active_ips WHERE user_id = ?').bind(userId).run();
    return true;
  } catch { return false; }
}
// ===================== SPEED LIMIT =====================
function createRateLimiter(kbps) {
  const bytesPerSec = (typeof kbps === 'number' && kbps > 0) ? kbps * 1024 : 0;
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
const speedLimiters = new Map();
function getUserLimiter(user) {
  const kbps = Number(user.speedLimitKBps) || 0;
  if (kbps <= 0) return { enabled: false, async take() {} };
  let entry = speedLimiters.get(user.id);
  if (!entry || entry.kbps !== kbps) {
    entry = { kbps, limiter: createRateLimiter(kbps) };
    speedLimiters.set(user.id, entry);
  }
  return entry.limiter;
}
async function reserveSpeedBudget(env, userId, kbps, nbytes) {
  if (!(kbps > 0) || nbytes <= 0) return true;
  if (!(await d1Ready(env))) return true;
  const bytesPerSec = kbps * 1024;
  const now = Date.now();
  const WINDOW = 1000;
  const BURST = bytesPerSec * 1.25;
  try {
    const row = await env.DB.prepare(
      'SELECT window_start, bytes FROM speed_budget WHERE user_id = ?'
    ).bind(userId).first();
    let windowStart = row?.window_start || now;
    let used = row?.bytes || 0;
    if (now - windowStart >= WINDOW) {
      windowStart = now;
      used = 0;
    }
    if (used + nbytes > BURST) return false;
    used += nbytes;
    await env.DB.prepare(`
      INSERT INTO speed_budget (user_id, window_start, bytes) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET window_start = excluded.window_start, bytes = excluded.bytes
    `).bind(userId, windowStart, used).run();
    return true;
  } catch (e) {
    console.error('speed budget', e);
    return true;
  }
}
function createThrottle(env, user, localLimiter) {
  const kbps = Number(user.speedLimitKBps) || 0;
  if (kbps <= 0) {
    return { async add() {}, async flush() {} };
  }
  let pending = 0;
  const FLUSH_EVERY = 16 * 1024;
  const flush = async () => {
    const n = pending;
    pending = 0;
    if (n <= 0) return;
    await localLimiter.take(n);
    for (let i = 0; i < 50; i++) {
      const ok = await reserveSpeedBudget(env, user.id, kbps, n);
      if (ok) return;
      await new Promise(r => setTimeout(r, 40));
    }
  };
  return {
    async add(n) {
      n = Math.max(0, n | 0);
      if (!n) return;
      pending += n;
      if (pending >= FLUSH_EVERY) await flush();
    },
    flush,
  };
}
// ===================== STATUS =====================
async function buildUserStatus(env, user) {
  const total = await usageGet(env, user.id);
  const daily = await usageGetDaily(env, user.id);
  const activeIps = await listActiveIps(env, user.id);
  const now = Date.now();
  const expired = user.expiry ? now > Date.parse(user.expiry) : false;
  let status = 'active';
  if (user.enabled === false) status = 'disabled';
  else if (expired) status = 'expired';
  else if (user.quotaBytes > 0 && total.total >= user.quotaBytes) status = 'quota-exceeded';
  else if (user.dailyQuotaBytes > 0 && daily.total >= user.dailyQuotaBytes) status = 'daily-quota-exceeded';
  return {
    id: user.id,
    name: user.name,
    uuid: user.uuid,
    enabled: user.enabled !== false,
    expiry: user.expiry,
    quotaBytes: user.quotaBytes || 0,
    dailyQuotaBytes: user.dailyQuotaBytes || 0,
    speedLimitKBps: user.speedLimitKBps || 0,
    ipLimit: user.ipLimit || 0,
    blockAds: !!user.blockAds,
    cleanIp: user.cleanIp || '',
    notes: user.notes || '',
    status,
    onlineDevices: activeIps.length,
    activeDevices: activeIps,
    activeConns: connGet(user.id),
    subscription: `${SUB_PATH}?token=${user.uuid}`,
    usage: {
      totalBytes: total.total,
      upBytes: total.up,
      downBytes: total.down,
      totalGB: +(total.total / 1073741824).toFixed(3),
      dailyBytes: daily.total,
      dailyGB: +(daily.total / 1073741824).toFixed(3),
    },
  };
}
function userAllowed(status) { return status.status === 'active'; }

// ===================== SUB =====================

// لیست دامنه‌های ircf.space
const IRCF_DOMAINS = [
  { domain: 'ipv4.ircf.space', name: 'ipv4' },   // عمومی
  { domain: 'mci.ircf.space',  name: 'mci' },    // همراه‌اول
  { domain: 'mtn.ircf.space',  name: 'mtn' },    // ایرانسل
  { domain: 'mkh.ircf.space',  name: 'mkh' },    // مخابرات
  { domain: 'rtl.ircf.space',  name: 'rtl' },    // رایتل
  { domain: 'hwb.ircf.space',  name: 'hwb' },    // های‌وب
  { domain: 'ast.ircf.space',  name: 'ast' },    // آسیاتک
  { domain: 'sht.ircf.space',  name: 'sht' },    // شاتل
  { domain: 'prs.ircf.space',  name: 'prs' },    // پارس‌آنلاین
  { domain: 'mbt.ircf.space',  name: 'mbt' },    // مبین‌نت
  { domain: 'ask.ircf.space',  name: 'ask' },    // اندیشه‌سبز
  { domain: 'rsp.ircf.space',  name: 'rsp' },    // رسپینا
  { domain: 'afn.ircf.space',  name: 'afn' },    // افرانت
  { domain: 'ztl.ircf.space',  name: 'ztl' },    // زی‌تل
  { domain: 'psm.ircf.space',  name: 'psm' },    // پیشگامان
  { domain: 'arx.ircf.space',  name: 'arx' },    // آراکس
  { domain: 'smt.ircf.space',  name: 'smt' },    // سامانتل
  { domain: 'shm.ircf.space',  name: 'shm' },    // شاتل‌موبایل
  { domain: 'fnv.ircf.space',  name: 'fnv' },    // فن‌آوا
  { domain: 'dbn.ircf.space',  name: 'dbn' },    // دیده‌بان‌نت
  { domain: 'apt.ircf.space',  name: 'apt' },    // آپتل
  { domain: 'fnp.ircf.space',  name: 'fnp' },    // فناپ‌تلکام
  { domain: 'ryn.ircf.space',  name: 'ryn' },    // رای‌نت
  { domain: 'sbn.ircf.space',  name: 'sbn' },    // صبانت
  { domain: 'ptk.ircf.space',  name: 'ptk' },    // پتیاک
  { domain: 'atc.ircf.space',  name: 'atc' },    // عصر تلکام
];

// کش resolve (۵ دقیقه)
const IRCF_CACHE_TTL = 5 * 60 * 1000;
let ircfCache = null;   // Map: domain → ip
let ircfCacheAt = 0;
let ircfLoading = null;

async function resolveDomain(domain) {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/dns-json' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const answers = (data.Answer || []).filter(a => a.type === 1 && a.data);
    if (answers.length === 0) return null;

    // یکی از IPها را به صورت رندوم انتخاب کن (چون معمولاً چند تا A دارند)
    const pick = answers[Math.floor(Math.random() * answers.length)];
    return pick.data;
  } catch (e) {
    console.error('resolve failed:', domain, e?.message);
    return null;
  }
}

async function ensureIrcfResolved() {
  const now = Date.now();
  if (ircfCache && (now - ircfCacheAt) < IRCF_CACHE_TTL) {
    return ircfCache;
  }
  if (ircfLoading) return ircfLoading;

  ircfLoading = (async () => {
    const results = await Promise.all(
      IRCF_DOMAINS.map(async (item) => {
        const ip = await resolveDomain(item.domain);
        return { domain: item.domain, name: item.name, ip };
      })
    );

    const map = {};
    for (const r of results) {
      if (r.ip) {
        map[r.domain] = r.ip;
      }
    }

    // فقط وقتی حداقل چند تا موفق بود کش کن
    if (Object.keys(map).length >= 2) {
      ircfCache = map;
      ircfCacheAt = Date.now();
    } else if (ircfCache) {
      // اگر resolve جدید خیلی ضعیف بود، کش قبلی را نگه دار
      return ircfCache;
    } else {
      ircfCache = map;
      ircfCacheAt = Date.now();
    }

    return ircfCache;
  })();

  try {
    return await ircfLoading;
  } finally {
    ircfLoading = null;
  }
}

function formatBytesShort(n) {
  n = Number(n) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + 'GB';
  if (n >= 1048576) return (n / 1048576).toFixed(0) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

function daysRemaining(expiry) {
  if (!expiry) return '∞';
  const ms = Date.parse(expiry) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '0';
  return String(Math.ceil(ms / 86400000));
}

function buildVlessLink({ ip, port, uuid, workerHost, path, name, fp, alpn }) {
  const qs = new URLSearchParams({
    security: 'tls',
    sni: workerHost,
    fp: fp || 'chrome',
    type: 'ws',
    path,
    host: workerHost,
    encryption: 'none',
  });
  if (alpn) qs.set('alpn', alpn);
  return `vless://${uuid}@${ip}:${port}?${qs.toString()}#${encodeURIComponent(name)}`;
}

function buildBannerLink(workerHost, user, status) {
  const used = formatBytesShort(status?.usage?.totalBytes || 0);
  const total = user.quotaBytes > 0 ? formatBytesShort(user.quotaBytes) : '∞';
  const days = daysRemaining(user.expiry);
  const remark = `📋 ${used} / ${total} | ${days}d left | ${VERSION}`;
  return buildVlessLink({
    ip: '127.0.0.1',
    port: 1,
    uuid: user.uuid,
    workerHost,
    path: `/?u=${encodeURIComponent(user.id)}`,
    name: remark,
    fp: 'chrome',
    alpn: 'http/1.1',
  });
}

async function generateSubscription(workerHost, user, status) {
  const path = `/?u=${encodeURIComponent(user.id)}`;
  const links = [];

  // ۱. بنر اطلاعات
  links.push(buildBannerLink(workerHost, user, status));

  const push = (o) => links.push(buildVlessLink(o));
  const base = user.name || user.id;

  // ۲. کانفیگ‌های اول از گیت‌هاب (اگر موجود باشد)
  let ghDomains = [];
  try {
    ghDomains = await ensureDomainsList();
  } catch (_) {}
  const preferred = (ghDomains && ghDomains.length) ? ghDomains.slice(0, 3) : [];
  const preferredPorts = [443, 8443, 2053];
  const preferredFps = ['chrome', 'firefox', 'safari'];

  for (let i = 0; i < preferred.length; i++) {
    push({
      ip: preferred[i],
      port: preferredPorts[i % preferredPorts.length],
      uuid: user.uuid,
      workerHost,
      path,
      name: `⚡ ${base} | Pref-${i + 1}`,
      fp: preferredFps[i % preferredFps.length],
      alpn: 'http/1.1',
    });
  }

  // ۳. resolve کردن همه دامنه‌های ircf و ساخت کانفیگ با IP واقعی
  let resolvedMap = {};
  try {
    resolvedMap = await ensureIrcfResolved();
  } catch (_) {}

  const fps = ['chrome', 'firefox', 'safari', 'edge', 'random', 'chrome'];
  let idx = 0;

  for (const item of IRCF_DOMAINS) {
    const ip = resolvedMap[item.domain];
    if (!ip) continue; // فقط مواردی که IP دارند

    push({
      ip: ip,                    // ← فقط IP، نه دامنه
      port: 443,
      uuid: user.uuid,
      workerHost,
      path,
      name: `⚡ ${base} | ${item.name}`,
      fp: fps[idx % fps.length],
      alpn: 'http/1.1',
    });
    idx++;
  }

  return links.join('\n');
}
// ===================== VLESS =====================
function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function parseVlessHeader(buffer, expectedUuidBytes) {
  const view = new DataView(buffer);
  const len = buffer.byteLength;
  if (len < 19) return { ok: false, reason: 'too short' };
  if (view.getUint8(0) !== 0) return { ok: false, reason: 'bad version' };
  const uuidBytes = new Uint8Array(buffer, 1, 16);
  if (!bytesEqual(uuidBytes, expectedUuidBytes)) return { ok: false, reason: 'bad uuid' };
  let offset = 17;
  const addonLen = view.getUint8(offset);
  offset += 1 + addonLen;
  if (offset + 4 > len) return { ok: false, reason: 'truncated after addon' };
  const cmd = view.getUint8(offset);
  offset += 1;
  if (cmd !== 1 && cmd !== 2) return { ok: false, reason: 'bad cmd' };
  const port = view.getUint16(offset);
  offset += 2;
  const atype = view.getUint8(offset);
  offset += 1;
  let address = '';
  if (atype === 1) {
    if (offset + 4 > len) return { ok: false, reason: 'bad ipv4' };
    address = Array.from(new Uint8Array(buffer, offset, 4)).join('.');
    offset += 4;
  } else if (atype === 2) {
    if (offset >= len) return { ok: false, reason: 'bad domain len' };
    const dlen = view.getUint8(offset);
    offset += 1;
    if (offset + dlen > len) return { ok: false, reason: 'bad domain' };
    address = new TextDecoder().decode(new Uint8Array(buffer, offset, dlen));
    offset += dlen;
  } else if (atype === 3) {
    if (offset + 16 > len) return { ok: false, reason: 'bad ipv6' };
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(view.getUint16(offset + i * 2).toString(16));
    address = parts.join(':');
    offset += 16;
  } else {
    return { ok: false, reason: 'unknown atype ' + atype };
  }
  return {
    ok: true, cmd, address, port,
    rest: buffer.byteLength > offset ? buffer.slice(offset) : null,
  };
}


// ===================== PROXY =====================
function clientIpFrom(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || '';
}
async function handleVlessWebSocket(request, env, ctx, user) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }
  const clientIp = clientIpFrom(request);
  const ipCheck = await touchAndCheckIpLimit(env, user, clientIp);
  if (!ipCheck.ok) {
    return new Response(`device limit (${user.ipLimit})`, { status: 429 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  connInc(user.id);
  const uuidBytes = uuidToBytes(user.uuid);
  const localLimiter = getUserLimiter(user);
  const throttle = createThrottle(env, user, localLimiter);
  let remoteSocket = null;
  let remoteWriter = null;
  let headerParsed = false;
  let closed = false;
  let bytesUp = 0;
  let bytesDown = 0;
  const safeClose = () => {
    if (closed) return;
    closed = true;
    connDec(user.id);
    try { throttle.flush(); } catch (_) {}
    try { server.close(1000, 'done'); } catch (_) {}
    try { remoteWriter?.close(); } catch (_) {}
    try { remoteSocket?.close(); } catch (_) {}
    recordUsage(env, ctx, user.id, bytesUp, bytesDown);
  };
  const sendVlessResponse = () => {
    try { server.send(new Uint8Array([0x00, 0x00])); } catch (_) {}
  };
  const touchTimer = setInterval(() => {
    touchAndCheckIpLimit(env, user, clientIp).catch(() => {});
  }, 30_000);
  const clearTouch = () => { try { clearInterval(touchTimer); } catch (_) {} };
  server.addEventListener('message', async (event) => {
    try {
      let data = event.data;
      if (data instanceof Blob) data = await data.arrayBuffer();
      if (typeof data === 'string') data = new TextEncoder().encode(data).buffer;
      if (!(data instanceof ArrayBuffer)) data = new Uint8Array(data).buffer;
      if (!headerParsed) {
        const parsed = parseVlessHeader(data, uuidBytes);
        if (!parsed.ok) { clearTouch(); safeClose(); return; }
        headerParsed = true;
        if (parsed.cmd !== 1) { clearTouch(); safeClose(); return; }
        let dstHost = parsed.address;
        let dstPort = parsed.port;
        if (user.blockAds && await isAdHostOnline(dstHost)) {
          sendVlessResponse();
          clearTouch();
          safeClose();
          return;
        }
        if (dstPort === 53) {
          dstHost = ADGUARD_DNS_HOST;
          dstPort = ADGUARD_DNS_PORT;
        }
        try {
          remoteSocket = connect({ hostname: dstHost, port: dstPort });
          remoteWriter = remoteSocket.writable.getWriter();
          const reader = remoteSocket.readable.getReader();
          sendVlessResponse();
          if (parsed.rest && parsed.rest.byteLength > 0) {
            const n = parsed.rest.byteLength;
            await throttle.add(n);
            bytesUp += n;
            await remoteWriter.write(new Uint8Array(parsed.rest));
          }
          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength) {
                  await throttle.add(value.byteLength);
                  bytesDown += value.byteLength;
                  if (server.readyState === 1) server.send(value);
                }
              }
            } catch (_) {}
            clearTouch();
            safeClose();
          })();
        } catch (e) {
          console.log('connect failed', dstHost, dstPort, e && e.message);
          clearTouch();
          safeClose();
        }
        return;
      }
      if (remoteWriter && data.byteLength > 0) {
        await throttle.add(data.byteLength);
        bytesUp += data.byteLength;
        await remoteWriter.write(new Uint8Array(data));
      }
    } catch (_) {
      clearTouch();
      safeClose();
    }
  });
  server.addEventListener('close', () => { clearTouch(); safeClose(); });
  server.addEventListener('error', () => { clearTouch(); safeClose(); });
  return new Response(null, { status: 101, webSocket: client });
}
// ===================== API =====================
function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
async function handleApi(request, env, ctx, apiPath) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      },
    });
  }
  if (apiPath === '/users' && request.method === 'GET') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) {
      const user = await getUserById(env, id);
      if (!user) return json({ ok: false, error: 'not found' }, 404);
      return json({ ok: true, user: await buildUserStatus(env, user) });
    }
    const users = await getUsers(env);
    const list = await Promise.all(users.map(u => buildUserStatus(env, u)));
    return json({ ok: true, users: list, total: list.length, version: VERSION });
  }
  if (apiPath === '/users' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
    if (!body?.id) return json({ ok: false, error: 'id required' }, 400);
    const result = await pushUserUpdateToApi(env, body);
    usersCache = null;
    usersCacheAt = 0;
    if (body.speedLimitKBps !== undefined) speedLimiters.delete(body.id);
    if (!result.ok) return json(result, 404);
    return json({ ok: true, user: await buildUserStatus(env, result.user) });
  }
  if (apiPath === '/report-ips' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
    if (!body?.id) return json({ ok: false, error: 'id required' }, 400);
    let cleanIp = body.cleanIp;
    if (!cleanIp && Array.isArray(body.ips)) cleanIp = body.ips.join('\n');
    if (!cleanIp) return json({ ok: false, error: 'ips or cleanIp required' }, 400);
    const result = await pushUserUpdateToApi(env, { id: body.id, cleanIp: String(cleanIp) });
    usersCache = null;
    usersCacheAt = 0;
    if (!result.ok) return json(result, 404);
    return json({ ok: true, user: await buildUserStatus(env, result.user) });
  }
  if (apiPath === '/clear-ips' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
    if (!body?.id) return json({ ok: false, error: 'id required' }, 400);
    const ok = await clearActiveIps(env, body.id);
    return json({ ok, cleared: body.id });
  }
  if (apiPath === '/blocklist' && request.method === 'GET') {
    await ensureBlocklist();
    return json({
      ok: true,
      size: blockSetSize,
      source: blockSetSource,
      ageSec: blockSetAt ? Math.floor((Date.now() - blockSetAt) / 1000) : null,
      ttlSec: BLOCKLIST_TTL_MS / 1000,
    });
  }
  if (apiPath === '/domains' && request.method === 'GET') {
    await ensureDomainsList();
    return json({
      ok: true,
      list: domainsList || [],
      count: (domainsList || []).length,
      source: domainsListSource || null,
      ageSec: domainsListAt ? Math.floor((Date.now() - domainsListAt) / 1000) : null,
      ttlSec: DOMAINS_TTL_MS / 1000,
    });
  }
  if (apiPath === '/status' && request.method === 'GET') {
    const users = await getUsers(env);
    const statuses = await Promise.all(users.map(u => buildUserStatus(env, u)));
    const totalTraffic = statuses.reduce((s, u) => s + u.usage.totalBytes, 0);
    return json({
      ok: true,
      version: VERSION,
      users: statuses.length,
      active: statuses.filter(u => u.status === 'active').length,
      totalTrafficBytes: totalTraffic,
      totalTrafficGB: +(totalTraffic / 1073741824).toFixed(3),
      blocklist: {
        size: blockSetSize,
        source: blockSetSource || null,
        loaded: !!blockSet,
      },
      domains: {
        count: (domainsList || []).length,
        source: domainsListSource || null,
        loaded: !!(domainsList && domainsList.length),
      },
      live: statuses.map(u => ({
        id: u.id,
        name: u.name,
        onlineDevices: u.onlineDevices,
        activeConns: u.activeConns,
        speedLimitKBps: u.speedLimitKBps,
        ipLimit: u.ipLimit,
        activeDevices: u.activeDevices,
      })),
    });
  }
  return json({ ok: false, error: 'not found' }, 404);
}
// ===================== MAIN =====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const host = url.hostname;
    if (path === API_ROOT || path.startsWith(API_ROOT + '/')) {
      const apiPath = path.slice(API_ROOT.length) || '/';
      return handleApi(request, env, ctx, apiPath);
    }
    if (path === SUB_PATH || path === SUB_PATH + '/') {
      const token = url.searchParams.get('token') || '';
      if (!token) return new Response('token required', { status: 401 });
      const user = await getUserByToken(env, token);
      if (!user) return new Response('invalid token', { status: 404 });
      const status = await buildUserStatus(env, user);
      if (!userAllowed(status)) return new Response(`user ${status.status}`, { status: 403 });
      // preload blocklist + domains in background
      if (ctx?.waitUntil) {
        ctx.waitUntil(ensureBlocklist());
        ctx.waitUntil(ensureDomainsList());
      }
      const body = await generateSubscription(host, user, status);
      return new Response(body, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'profile-update-interval': '6',
        },
      });
    }
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const uid = url.searchParams.get('u') || '';
      const user = uid ? await getUserById(env, uid) : null;
      if (!user) return new Response('user not found', { status: 404 });
      const status = await buildUserStatus(env, user);
      if (!userAllowed(status)) return new Response(`forbidden: ${status.status}`, { status: 403 });
      return handleVlessWebSocket(request, env, ctx, user);
    }
    if (path === '/' || path === '/version') {
      return json({ version: VERSION });
    }
    return new Response('Not Found', { status: 404 });
  },
};
