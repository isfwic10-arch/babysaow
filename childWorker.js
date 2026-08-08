// child-worker.js — DNS via DoH (adblock DoH if blockAds, else Google clean DoH)
import { connect } from 'cloudflare:sockets';

const VERSION = '4.31.0-ipfix';
const API_SECRET = 'saow-pan2';
let MOTHER_URL = null;

const REPORT_THRESHOLD = 8 * 1024 * 1024; // هر ۸ مگ یک‌بار usage → کمتر D1
const STATUS_HTML_URL = 'https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/node-status.html';
const IP_IDLE_MS = 10 * 60 * 1000;
const SOFT_REJECT_DELAY_MS = 50;
const IP_CACHE_TTL_MS = 5 * 1000; // کش کوتاه — تا D1 زودتر دوباره چک شود
const IP_CLEANUP_PROB = 0.08; // فقط ~۸٪ درخواست‌ها cleanup idle

// ====================== DoH (rethinkdns with OISD-style lists) ======================
// const DOH_URL = 'https://sky.rethinkdns.com/1:-APACQCAEI0AECgAAIAAQA==';
// DoH با فیلتر تبلیغات (برای یوزرهایی که blockAds=true دارند)
const DOH_URL = 'https://hard.dnsforge.de/dns-query';
// DoH تمیز بدون فیلتر (برای یوزرهایی که blockAds=false دارند)
const DOH_CLEAN_URL = 'https://dns.google/dns-query';

const DOH_CACHE_TTL_MS = 10 * 60 * 1000; // ۱۰ دقیقه کش نتیجهٔ بلاک/اجازه
const DOH_TIMEOUT_MS = 2500;

// همه DNS از طریق DoH — انتخاب upstream بر اساس blockAds یوزر

// ====================== In-memory ======================
let usersByUuid = new Map();
const activeConns = new Map();
/** uuid -> Set<{ close: Function }> */
const activeSessions = new Map();
const limiters = new Map();
const ipCache = new Map(); // `${userId}|${ip}` -> { at, ok }
const memIps = new Map(); // userId -> Map<ip, lastSeen>  (اعمال limit حتی اگر D1 fail شود)
const dohCache = new Map(); // host -> { blocked: boolean, at: number }

/** خواندن عدد از چند نام فیلد ممکن */
function pickNum(obj, keys, fallback) {
  for (const k of keys) {
    if (obj == null || !(k in obj)) continue;
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * نرمال‌سازی فیلدهای محدودیت از mother یا ردیف D1
 * ipLimit: undefined → پیش‌فرض 1 | صریحاً 0 → نامحدود
 * speedLimitKBps: undefined/0 → نامحدود | >0 → KB/s
 */
function normalizeUserLimits(raw) {
  const o = raw || {};
  // IP
  let ipLimit;
  if (['ipLimit', 'ip_limit', 'maxIp', 'max_ip', 'ipCount'].some((k) => k in o && o[k] !== null && o[k] !== undefined && o[k] !== '')) {
    ipLimit = Math.max(0, pickNum(o, ['ipLimit', 'ip_limit', 'maxIp', 'max_ip', 'ipCount'], 1));
  } else {
    ipLimit = 1; // پیش‌فرض: ۱ آی‌پی
  }

  // Speed: پشتیبانی از KBps و Mbps و نام‌های مختلف
  let speedLimitKBps = 0;
  if (['speedLimitKBps', 'speed_limit_kbps', 'speedLimit', 'speed_kbps', 'limitKBps'].some((k) => k in o && o[k] != null && o[k] !== '')) {
    speedLimitKBps = Math.max(0, pickNum(o, ['speedLimitKBps', 'speed_limit_kbps', 'speedLimit', 'speed_kbps', 'limitKBps'], 0));
  } else if (['speedLimitMbps', 'speed_mbps', 'mbps'].some((k) => k in o && o[k] != null && o[k] !== '')) {
    const mbps = Math.max(0, pickNum(o, ['speedLimitMbps', 'speed_mbps', 'mbps'], 0));
    speedLimitKBps = mbps * 128; // 1 Mbps ≈ 128 KB/s
  }

  return { ipLimit, speedLimitKBps };
}

// آمار سبک DNS (per-isolate)
let dnsStats = { total: 0, ok: 0, fail: 0, dotBlocked: 0 };

let nodeDisabled = false;
let lastSyncAt = 0;
let childId = 'child-unknown';
let dbReady = false;
let _env = null;
let _ctx = null;

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

    // مهاجرت: جدول‌های قدیمی ممکن است ستون block_ads نداشته باشند
    try {
      const cols = await env.DB.prepare(`PRAGMA table_info(node_users)`).all();
      const names = new Set((cols.results || []).map((r) => r.name));
      if (!names.has('block_ads')) {
        await env.DB.prepare(
          `ALTER TABLE node_users ADD COLUMN block_ads INTEGER DEFAULT 1`
        ).run();
        console.log('ensureDb: migrated node_users +block_ads');
      }
      // ستون‌های احتمالی دیگر که بعداً اضافه شده‌اند
      const need = [
        ['daily_quota_bytes', 'INTEGER DEFAULT 0'],
        ['speed_limit_kbps', 'INTEGER DEFAULT 0'],
        ['ip_limit', 'INTEGER DEFAULT 1'],
      ];
      for (const [col, def] of need) {
        if (!names.has(col)) {
          await env.DB.prepare(`ALTER TABLE node_users ADD COLUMN ${col} ${def}`).run();
          console.log('ensureDb: migrated node_users +' + col);
        }
      }
    } catch (migErr) {
      console.log('ensureDb migrate:', migErr?.message);
    }

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
          normalizeUserLimits(u).speedLimitKBps,
          normalizeUserLimits(u).ipLimit,
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
      {
        const lim = normalizeUserLimits({
          speed_limit_kbps: r.speed_limit_kbps,
          ip_limit: r.ip_limit,
          speedLimitKBps: r.speed_limit_kbps,
          ipLimit: r.ip_limit,
        });
        // از D1: اگر ستون null بود پیش‌فرض ip=1
        const ipLimit = (r.ip_limit === null || r.ip_limit === undefined)
          ? 1
          : Math.max(0, Number(r.ip_limit) || 0);
        newMap.set(uuid, {
          id: String(r.id), uuid, name: r.name || '',
          enabled: !!r.enabled, expiry: r.expiry || null,
          quotaBytes: r.quota_bytes || 0, dailyQuotaBytes: r.daily_quota_bytes || 0,
          speedLimitKBps: Math.max(0, Number(r.speed_limit_kbps) || 0),
          ipLimit,
          blockAds: !!r.block_ads,
        });
      }
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
  try {
    if (usersByUuid.size > 0 && lastSyncAt > 0) return;
    await loadUsersFromDb(env || _env);
  } catch (e) {
    console.log('ensureUsersLoaded:', e?.message || e);
  }
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

/**
 * محدودیت IP همزمان — D1 اول (بین isolate)، حافظه دوم.
 * ترتیب: cleanup → لیست فعال → اگر IP هست OK → اگر ظرفیت پر است رد → insert → تأیید دوباره
 * limit <= 0 → نامحدود
 */
async function tryAcquireIp(env, userId, ip, limit) {
  const maxIps = Number(limit);
  if (!Number.isFinite(maxIps) || maxIps <= 0) return { ok: true, unlimited: true };
  if (!userId || !ip) return { ok: true, fallback: true };

  const ipStr = String(ip).trim();
  // IP نامعتبر / ناشناس را در جدول فعال ثبت نکن (جلوگیری از پر شدن با 0.0.0.0 و لبه CF)
  if (!isValidPublicIp(ipStr) || ipStr === '0.0.0.0') {
    return { ok: true, skipped: true, reason: 'invalid-or-unknown-ip' };
  }
  const key = userId + '|' + ipStr;
  const now = Date.now();
  const cutoff = now - IP_IDLE_MS;

  // حافظه isolate
  let m = memIps.get(userId);
  if (!m) {
    m = new Map();
    memIps.set(userId, m);
  }
  for (const [x, ts] of m) {
    if (now - ts > IP_IDLE_MS) m.delete(x);
  }

  // کش کوتاه فقط برای همین IP (reconnect سریع)
  const cached = ipCache.get(key);
  if (cached && cached.ok && now - cached.at < IP_CACHE_TTL_MS) {
    m.set(ipStr, now);
    return { ok: true, cached: true, limit: maxIps };
  }

  // بدون D1 فقط حافظه
  if (!env?.DB) {
    if (!m.has(ipStr) && m.size >= maxIps) {
      return { ok: false, reason: 'ip limit', current: m.size, limit: maxIps, via: 'memory' };
    }
    m.set(ipStr, now);
    ipCache.set(key, { at: now, ok: true });
    return { ok: true, via: 'memory-only', current: m.size, limit: maxIps };
  }

  try {
    await ensureDb(env);

    // همیشه idle این یوزر را پاک کن (نه تصادفی) تا ظرفیت آزاد شود
    await env.DB.prepare(
      `DELETE FROM node_active_ips WHERE user_id = ? AND last_seen < ?`
    ).bind(userId, cutoff).run();

    const listed = await env.DB.prepare(
      `SELECT ip, last_seen FROM node_active_ips WHERE user_id = ? ORDER BY last_seen ASC`
    ).bind(userId).all();
    const rows = listed.results || [];
    const known = new Set(rows.map((r) => String(r.ip)));

    // همین IP قبلاً مجاز بوده → فقط touch
    if (known.has(ipStr)) {
      await env.DB.prepare(
        `UPDATE node_active_ips SET last_seen = ? WHERE user_id = ? AND ip = ?`
      ).bind(now, userId, ipStr).run();
      m.set(ipStr, now);
      ipCache.set(key, { at: now, ok: true });
      return { ok: true, existing: true, current: known.size, limit: maxIps };
    }

    // ظرفیت پر — IP جدید رد شود (هنوز insert نشده)
    if (rows.length >= maxIps) {
      console.log('ip-limit reject', userId, ipStr, 'have', rows.length, 'max', maxIps, rows.map((r) => r.ip));
      return {
        ok: false,
        reason: 'ip limit',
        current: rows.length,
        limit: maxIps,
        held: rows.map((r) => r.ip),
        via: 'd1-pre',
      };
    }

    // جا هست → ثبت
    await env.DB.prepare(
      `INSERT INTO node_active_ips (user_id, ip, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen`
    ).bind(userId, ipStr, now).run();

    // تأیید بعد از insert (مقابل race دو isolate)
    const listed2 = await env.DB.prepare(
      `SELECT ip, last_seen FROM node_active_ips WHERE user_id = ? AND last_seen >= ? ORDER BY last_seen ASC`
    ).bind(userId, cutoff).all();
    const rows2 = listed2.results || [];

    if (rows2.length > maxIps) {
      // قدیمی‌ها را نگه دار، بقیه (از جمله IP جدید اگر جزو آخرهاست) را حذف کن
      const keep = new Set(rows2.slice(0, maxIps).map((r) => String(r.ip)));
      for (const r of rows2) {
        const x = String(r.ip);
        if (!keep.has(x)) {
          await env.DB.prepare(
            `DELETE FROM node_active_ips WHERE user_id = ? AND ip = ?`
          ).bind(userId, x).run();
        }
      }
      if (!keep.has(ipStr)) {
        m.delete(ipStr);
        ipCache.delete(key);
        console.log('ip-limit race reject', userId, ipStr, 'kept', [...keep]);
        return {
          ok: false,
          reason: 'ip limit',
          current: rows2.length,
          limit: maxIps,
          via: 'd1-race',
        };
      }
    }

    m.set(ipStr, now);
    ipCache.set(key, { at: now, ok: true });
    if (ipCache.size > 500) ipCache.delete(ipCache.keys().next().value);
    return { ok: true, current: Math.min(rows2.length, maxIps), limit: maxIps, via: 'd1' };
  } catch (e) {
    console.log('tryAcquireIp d1:', e?.message || e);
    // fallback سخت‌گیرانه: فقط حافظه همین isolate
    if (!m.has(ipStr) && m.size >= maxIps) {
      return { ok: false, reason: 'ip limit', current: m.size, limit: maxIps, via: 'memory-fallback' };
    }
    m.set(ipStr, now);
    ipCache.set(key, { at: now, ok: true });
    return { ok: true, via: 'memory-fallback', current: m.size, limit: maxIps };
  }
}

function touchActiveIp(env, userId, ip) {
  if (!userId || !ip) return;
  const ipStr = String(ip);
  const now = Date.now();
  const m = memIps.get(userId);
  if (m) m.set(ipStr, now);
  const key = userId + '|' + ipStr;
  const cached = ipCache.get(key);
  if (cached && now - cached.at < IP_CACHE_TTL_MS) return;
  ipCache.set(key, { at: now, ok: true });
  if (!env?.DB) return;
  const run = env.DB.prepare(`
    UPDATE node_active_ips SET last_seen = ? WHERE user_id = ? AND ip = ?
  `).bind(now, userId, ipStr).run().catch(() => {});
  if (_ctx && typeof _ctx.waitUntil === 'function') _ctx.waitUntil(run);
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

/**
 * IP واقعی کلاینت روی Cloudflare Workers
 * فقط CF-Connecting-IP قابل‌اعتماد است؛ XFF را فقط اگر شبیه IP عمومی معتبر بود استفاده می‌کنیم.
 * IPهای private / loopback / link-local و رنج‌های شناخته‌شده لبه CF رد می‌شوند.
 */
function isValidPublicIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const s = ip.trim();
  // IPv4
  const m4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const a = [+m4[1], +m4[2], +m4[3], +m4[4]];
    if (a.some((n) => n > 255)) return false;
    // 0.0.0.0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10 (CGNAT shared - keep? keep as public-ish)
    if (a[0] === 0) return false;
    if (a[0] === 10) return false;
    if (a[0] === 127) return false;
    if (a[0] === 169 && a[1] === 254) return false;
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return false;
    if (a[0] === 192 && a[1] === 168) return false;
    if (a[0] === 100 && a[1] >= 64 && a[1] <= 127) return false; // CGNAT
    // Cloudflare anycast تقریبی — این‌ها هرگز نباید به‌عنوان کلاینت ثبت شوند
    // 104.16–104.31, 172.64–172.71, 173.245, 103.21.244, 141.101, 108.162, 190.93, 188.114, 197.234, 198.41, 162.158, 104.18
    if (a[0] === 104 && a[1] >= 16 && a[1] <= 31) return false;
    if (a[0] === 172 && a[1] >= 64 && a[1] <= 71) return false;
    if (a[0] === 173 && a[1] === 245) return false;
    if (a[0] === 103 && a[1] === 21 && a[2] === 244) return false;
    if (a[0] === 141 && a[1] === 101) return false;
    if (a[0] === 108 && a[1] === 162) return false;
    if (a[0] === 190 && a[1] === 93) return false;
    if (a[0] === 188 && a[1] === 114) return false;
    if (a[0] === 197 && a[1] === 234) return false;
    if (a[0] === 198 && a[1] === 41) return false;
    if (a[0] === 162 && a[1] === 158) return false;
    // 205.251.x AWS / بعضی anycast — 205.252 بعضی edgeهای واسط
    // اگر کل 205.x را رد کنیم ممکن است کلاینت واقعی در این رنج باشد؛ فقط 205.251–205.255 مشکوک CF/AWS
    if (a[0] === 205 && a[1] >= 251) return false;
    return true;
  }
  // IPv6 ساده — رد کردن local/link
  if (s.includes(':')) {
    const low = s.toLowerCase();
    if (low === '::1' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return false;
    // IPv4-mapped
    const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isValidPublicIp(mapped[1]);
    return true;
  }
  return false;
}

function getClientIP(request) {
  try {
    // ۱) منبع اصلی روی Workers
    const cfIp = (request.headers.get('CF-Connecting-IP') || request.headers.get('cf-connecting-ip') || '').trim();
    if (isValidPublicIp(cfIp)) return cfIp;

    // ۲) True-Client-IP (اگر فعال باشد)
    const trueIp = (request.headers.get('True-Client-IP') || request.headers.get('true-client-ip') || '').trim();
    if (isValidPublicIp(trueIp)) return trueIp;

    // ۳) X-Forwarded-For: از راست به چپ اولین IP عمومی معتبر (آخرین hop نزدیک کلاینت معمولاً سمت چپ است؛
    // روی CF معمولاً XFF توسط خود CF نوشته می‌شود — باز هم فقط public معتبر)
    const xff = request.headers.get('X-Forwarded-For') || request.headers.get('x-forwarded-for') || '';
    if (xff) {
      const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (isValidPublicIp(p)) return p;
      }
    }

    // ۴) cf object (ندارد IP مستقیم معمولاً)
  } catch (e) {
    console.log('getClientIP err', e?.message || e);
  }
  // بدون IP معتبر — یک مقدار ثابت تا اسپم IPهای تصادفی نسازد
  return '0.0.0.0';
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

function isIpLiteral(host) {
  const h = String(host || '').trim();
  if (!h) return false;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  // IPv6 (simple)
  if (h.includes(':')) return true;
  return false;
}

// ====================== Rate Limiter (token bucket, per uuid) ======================
/** kbps <= 0 → بدون محدودیت */
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
    kbps,
    take(n) {
      const run = tail.then(() => doTake(n));
      tail = run.catch(() => {});
      return run;
    },
  };
}

function getLimiter(uuid, kbps) {
  const k = Math.max(0, Number(kbps) || 0);
  if (k <= 0) return { enabled: false, async take() {} };
  let entry = limiters.get(uuid);
  if (!entry || entry.kbps !== k) {
    entry = { kbps: k, limiter: createRateLimiter(k) };
    limiters.set(uuid, entry);
  }
  return entry.limiter;
}

// ====================== DoH Ad-Block (rethinkdns) ======================
function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** ساخت یک کوئری DNS ساده برای رکورد A */
function buildDnsQueryA(hostname) {
  const labels = String(hostname).toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const nameParts = [];
  for (const label of labels) {
    const enc = new TextEncoder().encode(label);
    if (enc.length > 63) return null;
    nameParts.push(enc.length);
    for (let i = 0; i < enc.length; i++) nameParts.push(enc[i]);
  }
  nameParts.push(0); // root

  const id = Math.floor(Math.random() * 65535);
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint16(0, id);
  view.setUint16(2, 0x0100); // RD
  view.setUint16(4, 1); // QDCOUNT
  // ANCOUNT, NSCOUNT, ARCOUNT = 0

  const question = new Uint8Array(nameParts.length + 4);
  question.set(nameParts, 0);
  const qView = new DataView(question.buffer);
  qView.setUint16(nameParts.length, 1); // QTYPE A
  qView.setUint16(nameParts.length + 2, 1); // QCLASS IN

  const packet = new Uint8Array(header.length + question.length);
  packet.set(header, 0);
  packet.set(question, header.length);
  return packet;
}

/** پارس پاسخ DoH و تشخیص بلاک بودن (0.0.0.0 یا بدون A) */
function isBlockedFromDnsResponse(buf) {
  if (!buf || buf.byteLength < 12) return true; // fail closed for safety? or false. بهتر fail open
  const view = new DataView(buf);
  const flags = view.getUint16(2);
  const rcode = flags & 0x0f;
  // NXDOMAIN / SERVFAIL → معمولاً بلاک یا خطا → بلاک در نظر می‌گیریم؟ برای adblock بهتره fail-open
  if (rcode !== 0) return false; // fail open on error

  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  if (ancount === 0) return true; // هیچ پاسخی = بلاک

  // رد شدن از سوال‌ها
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    while (offset < buf.byteLength) {
      const len = view.getUint8(offset);
      if (len === 0) { offset += 1; break; }
      if ((len & 0xc0) === 0xc0) { offset += 2; break; } // pointer
      offset += 1 + len;
    }
    offset += 4; // QTYPE + QCLASS
  }

  // بررسی answerها
  let hasRealA = false;
  for (let i = 0; i < ancount && offset + 10 < buf.byteLength; i++) {
    // NAME
    while (offset < buf.byteLength) {
      const len = view.getUint8(offset);
      if (len === 0) { offset += 1; break; }
      if ((len & 0xc0) === 0xc0) { offset += 2; break; }
      offset += 1 + len;
    }
    if (offset + 10 > buf.byteLength) break;
    const rtype = view.getUint16(offset); offset += 2;
    offset += 2; // class
    offset += 4; // TTL
    const rdlen = view.getUint16(offset); offset += 2;
    if (rtype === 1 && rdlen === 4 && offset + 4 <= buf.byteLength) { // A
      const a = view.getUint8(offset);
      const b = view.getUint8(offset + 1);
      const c = view.getUint8(offset + 2);
      const d = view.getUint8(offset + 3);
      if (a === 0 && b === 0 && c === 0 && d === 0) {
        // 0.0.0.0 → بلاک
        return true;
      }
      hasRealA = true;
    }
    offset += rdlen;
  }
  // اگر هیچ A واقعی نداشت → بلاک
  return !hasRealA;
}

async function queryDohBlocked(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || isIpLiteral(h)) return false;

  const now = Date.now();
  const cached = dohCache.get(h);
  if (cached && now - cached.at < DOH_CACHE_TTL_MS) {
    return cached.blocked;
  }

  try {
    const query = buildDnsQueryA(h);
    if (!query) return false;

    const dnsParam = base64UrlEncode(query);
    const url = `${DOH_URL}?dns=${dnsParam}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/dns-message',
        'User-Agent': 'cf-child/4.9.4',
      },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    clearTimeout(timer);

    if (!res.ok) {
      // fail open
      dohCache.set(h, { blocked: false, at: now });
      return false;
    }

    const buf = await res.arrayBuffer();
    const blocked = isBlockedFromDnsResponse(buf);

    dohCache.set(h, { blocked, at: now });
    // محدود کردن اندازه کش
    if (dohCache.size > 2000) {
      const first = dohCache.keys().next().value;
      dohCache.delete(first);
    }
    return blocked;
  } catch (e) {
    // timeout / network → fail open
    dohCache.set(h, { blocked: false, at: now });
    return false;
  }
}

async function isAdHost(host) {
  return queryDohBlocked(host);
}

/** رزولوشن واقعی DNS از طریق DoH (برای ترافیک کلاینت) */
/** upstream: اگر blockAds فعال → DOH_URL (فیلتردار)، وگرنه DOH_CLEAN_URL */
function pickDohUrl(blockAds) {
  return blockAds ? DOH_URL : DOH_CLEAN_URL;
}

async function dohResolve(dnsQueryBytes, blockAds = true) {
  if (!dnsQueryBytes || dnsQueryBytes.byteLength < 12) return null;
  const q = dnsQueryBytes instanceof Uint8Array ? dnsQueryBytes : new Uint8Array(dnsQueryBytes);
  const upstream = pickDohUrl(!!blockAds);
  dnsStats.total += 1;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
    const res = await fetch(upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/dns-message',
        'Accept': 'application/dns-message',
        'User-Agent': 'cf-child/' + VERSION,
      },
      body: q,
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    clearTimeout(timer);

    if (!res.ok) {
      const dnsParam = base64UrlEncode(q);
      const res2 = await fetch(`${upstream}?dns=${dnsParam}`, {
        method: 'GET',
        headers: { 'Accept': 'application/dns-message', 'User-Agent': 'cf-child/' + VERSION },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      if (!res2.ok) {
        dnsStats.fail += 1;
        return null;
      }
      dnsStats.ok += 1;
      return new Uint8Array(await res2.arrayBuffer());
    }
    dnsStats.ok += 1;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    dnsStats.fail += 1;
    return null;
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
    {
      const lim = normalizeUserLimits(u);
      newMap.set(uuid, {
        id: String(u.id), uuid, name: u.name || '',
        enabled: u.enabled !== false, expiry: u.expiry || null,
        quotaBytes: Number(u.quotaBytes) || Number(u.quota_bytes) || 0,
        dailyQuotaBytes: Number(u.dailyQuotaBytes) || Number(u.daily_quota_bytes) || 0,
        speedLimitKBps: lim.speedLimitKBps,
        ipLimit: lim.ipLimit,
        blockAds: u.blockAds !== false && u.block_ads !== 0 && u.block_ads !== false,
      });
    }
  }

  usersByUuid = newMap;
  lastSyncAt = Date.now();
  ipCache.clear();
  memIps.clear();
  limiters.clear(); // تا speed limit جدید اعمال شود
  // کش DoH را نگه می‌داریم (دامنه‌ها تغییر نکرده‌اند)

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
      doh: DOH_URL, dohClean: DOH_CLEAN_URL,
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ====================== VLESS XHTTP (stream-one) ======================
/**
 * XHTTP stream-one روی Cloudflare Workers:
 * - کلاینت یک POST می‌فرستد؛ بدنه = هدر VLESS + آپلود
 * - پاسخ استریم = دانلود از مقصد
 * سازگار با xhttpSettings.mode = "stream-one"
 */
function xlog(...args) {
  try {
    console.log('[xhttp]', ...args);
  } catch {}
}

function hexPreview(buf, max = 32) {
  try {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const n = Math.min(u.length, max);
    let s = '';
    for (let i = 0; i < n; i++) s += u[i].toString(16).padStart(2, '0');
    if (u.length > max) s += '…';
    return s;
  } catch {
    return '?';
  }
}

async function handleVlessXhttp(request, env, ctx) {
  const t0 = Date.now();
  const reqUrl = request.url || '';
  const method = request.method || '';
  const clientIP = getClientIP(request);
  const ct = request.headers.get('content-type') || '';
  const cl = request.headers.get('content-length') || '';
  const te = request.headers.get('transfer-encoding') || '';
  const hostH = request.headers.get('host') || '';
  const ua = (request.headers.get('user-agent') || '').slice(0, 80);
  const alpnHint = request.cf?.httpProtocol || request.headers.get('cf-visitor') || '';

  xlog('IN', {
    method,
    url: String(reqUrl).slice(0, 180),
    ip: clientIP,
    host: hostH,
    ct,
    cl,
    te,
    ua,
    alpn: alpnHint,
    users: usersByUuid.size,
    disabled: nodeDisabled,
  });

  try {
    await ensureUsersLoaded(env);
  } catch (e) {
    xlog('ensureUsersLoaded err', e?.message || e);
  }
  if (nodeDisabled) {
    xlog('REJECT nodeDisabled');
    return new Response('Node disabled', { status: 503 });
  }
  if (!request.body) {
    xlog('REJECT no body');
    return new Response('body required', { status: 400 });
  }

  const envRef = env;
  const bodyReader = request.body.getReader();

  // خواندن هدر VLESS از ابتدای استریم
  let headerBuf = new Uint8Array(0);
  let remoteEarly = null;
  let parsed = null;
  let readChunks = 0;

  const appendBuf = (a, b) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  try {
    while (headerBuf.length < 512) {
      const { done, value } = await bodyReader.read();
      readChunks++;
      if (done && (!value || !value.byteLength)) {
        xlog('body read done', { bufLen: headerBuf.length, chunks: readChunks });
        break;
      }
      if (value && value.byteLength) {
        headerBuf = appendBuf(headerBuf, value instanceof Uint8Array ? value : new Uint8Array(value));
        xlog('body chunk', { n: value.byteLength, total: headerBuf.length, hex: hexPreview(value) });
      }
      if (headerBuf.length >= 24) {
        const tryParse = parseVlessHeader(
          headerBuf.buffer.slice(headerBuf.byteOffset, headerBuf.byteOffset + headerBuf.byteLength)
        );
        if (tryParse.ok) {
          parsed = tryParse;
          if (parsed.rest && parsed.rest.byteLength > 0) {
            remoteEarly = new Uint8Array(parsed.rest);
          }
          xlog('VLESS header OK', {
            uuid: parsed.uuid,
            cmd: parsed.cmd,
            addr: parsed.address,
            port: parsed.port,
            early: remoteEarly?.byteLength || 0,
            headerBytes: headerBuf.length,
            ms: Date.now() - t0,
          });
          break;
        }
        xlog('VLESS parse not yet', { bufLen: headerBuf.length, hex: hexPreview(headerBuf) });
      }
      if (done) break;
      if (headerBuf.length > 4096) {
        xlog('header buffer overflow', { bufLen: headerBuf.length, hex: hexPreview(headerBuf, 64) });
        break;
      }
    }
  } catch (e) {
    xlog('read header EXCEPTION', e?.message || String(e));
    return new Response('bad request', { status: 400 });
  }

  if (!parsed || !parsed.ok) {
    xlog('REJECT invalid vless', {
      bufLen: headerBuf.length,
      chunks: readChunks,
      hex: hexPreview(headerBuf, 64),
      firstByte: headerBuf.length ? headerBuf[0] : null,
      ms: Date.now() - t0,
    });
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('invalid vless', { status: 400 });
  }

  const userUuid = parsed.uuid.toLowerCase();
  const cfg = getUserByUuid(userUuid);
  if (!cfg) {
    xlog('REJECT user not found / disabled / expired', {
      uuid: userUuid,
      loaded: usersByUuid.size,
      hasKey: usersByUuid.has(userUuid),
    });
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('unauthorized', { status: 403 });
  }
  const userId = cfg.id;
  xlog('user ok', { id: userId, name: cfg.name, ipLimit: cfg.ipLimit, speed: cfg.speedLimitKBps });

  // DNS / DoT
  const dnsAddrs = [
    '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9',
    'dns.google', 'dns.google.com', 'cloudflare-dns.com', 'dns.adguard.com',
    'dns.quad9.net', 'dns.dnsforge.de', 'one.one.one.one', 'dns.cloudflare.com',
  ];
  const addrLower = String(parsed.address || '').toLowerCase();
  const isDot = parsed.port === 853;
  const isDnsRequest =
    parsed.port === 53 ||
    (parsed.cmd === 2 && (parsed.port === 53 || dnsAddrs.includes(addrLower)));

  if (isDot) {
    dnsStats.dotBlocked += 1;
    xlog('REJECT DoT', { addr: parsed.address, port: parsed.port });
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('dot blocked', { status: 403 });
  }

  if (parsed.cmd === 2 && !isDnsRequest) {
    xlog('REJECT udp non-dns', { cmd: parsed.cmd, port: parsed.port });
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('udp not supported', { status: 400 });
  }
  if (parsed.cmd !== 1 && parsed.cmd !== 2) {
    xlog('REJECT bad cmd', { cmd: parsed.cmd });
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('only TCP', { status: 400 });
  }

  // IP limit
  const acq = await tryAcquireIp(envRef, userId, clientIP, cfg.ipLimit);
  if (!acq.ok) {
    xlog('REJECT ip limit', { userId, clientIP, acq });
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('ip limit', { status: 429 });
  }
  xlog('ip ok', acq);

  const userBlockAds = cfg.blockAds === true;
  const limiter = getLimiter(userUuid, cfg.speedLimitKBps);
  let bytesUp = 0;
  let bytesDown = 0;
  let sessionBytes = 0;
  let lastReported = 0;
  let closed = false;

  activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
  const sessionRef = {
    close: () => {
      closed = true;
    },
  };
  if (!activeSessions.has(userUuid)) activeSessions.set(userUuid, new Set());
  activeSessions.get(userUuid).add(sessionRef);

  const flushUsage = () => {
    if (!userId || bytesUp + bytesDown === 0) return;
    const u = bytesUp;
    const d = bytesDown;
    bytesUp = 0;
    bytesDown = 0;
    ctx.waitUntil(dbAddUsage(envRef, userId, u, d).catch(() => {}));
  };

  const maybeReport = () => {
    if (sessionBytes - lastReported >= REPORT_THRESHOLD) {
      flushUsage();
      lastReported = sessionBytes;
      if (userId) touchActiveIp(envRef, userId, clientIP);
    }
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeConns.set(userUuid, Math.max(0, (activeConns.get(userUuid) || 1) - 1));
    flushUsage();
    if (activeSessions.has(userUuid)) {
      const set = activeSessions.get(userUuid);
      set.delete(sessionRef);
      if (set.size === 0) activeSessions.delete(userUuid);
    }
    xlog('cleanup', {
      userId,
      up: bytesUp,
      down: bytesDown,
      session: sessionBytes,
      ms: Date.now() - t0,
    });
  };

  // DNS mode via DoH — پاسخ مستقیم در body
  if (isDnsRequest) {
    xlog('DNS mode', { addr: parsed.address, port: parsed.port, early: remoteEarly?.byteLength || 0 });
    try {
      const queries = [];
      if (remoteEarly && remoteEarly.byteLength > 0) {
        queries.push(remoteEarly);
      }
      for (;;) {
        const { done, value } = await bodyReader.read();
        if (value && value.byteLength) {
          queries.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
        if (done) break;
      }
      let all = new Uint8Array(0);
      for (const q of queries) all = appendBuf(all, q);

      const parts = [];
      let usedLengthPrefix = false;
      if (all.byteLength >= 2) {
        let off = 0;
        while (off + 2 <= all.byteLength) {
          const len = (all[off] << 8) | all[off + 1];
          if (len < 12 || off + 2 + len > all.byteLength) break;
          parts.push(all.subarray(off + 2, off + 2 + len));
          off += 2 + len;
          usedLengthPrefix = true;
        }
      }
      if (!parts.length && all.byteLength >= 12) {
        parts.push(all);
        usedLengthPrefix = false;
      }

      const outChunks = [];
      outChunks.push(new Uint8Array([0, 0]));
      for (const query of parts) {
        if (limiter.enabled) await limiter.take(query.byteLength);
        bytesUp += query.byteLength;
        sessionBytes += query.byteLength;
        const resp = await dohResolve(query, userBlockAds);
        if (!resp || resp.byteLength < 12) continue;
        let out;
        if (usedLengthPrefix) {
          out = new Uint8Array(2 + resp.byteLength);
          out[0] = (resp.byteLength >> 8) & 0xff;
          out[1] = resp.byteLength & 0xff;
          out.set(resp, 2);
        } else {
          out = resp;
        }
        if (limiter.enabled) await limiter.take(out.byteLength);
        bytesDown += out.byteLength;
        sessionBytes += out.byteLength;
        outChunks.push(out);
      }
      maybeReport();
      cleanup();

      let totalLen = 0;
      for (const c of outChunks) totalLen += c.byteLength;
      const body = new Uint8Array(totalLen);
      let o = 0;
      for (const c of outChunks) {
        body.set(c, o);
        o += c.byteLength;
      }
      xlog('DNS response', { parts: parts.length, outLen: totalLen, ms: Date.now() - t0 });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (e) {
      xlog('DNS fail', e?.message || e);
      cleanup();
      return new Response('dns fail', { status: 502 });
    }
  }

  // ad-block
  if (cfg.blockAds === true && (await isAdHost(parsed.address))) {
    xlog('REJECT ad blocked', { host: parsed.address });
    cleanup();
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('ad blocked', { status: 403 });
  }

  // TCP connect
  let remoteSocket;
  try {
    xlog('connect start', { host: parsed.address, port: parsed.port });
    remoteSocket = connect({ hostname: parsed.address, port: parsed.port });
    xlog('connect opened', { host: parsed.address, port: parsed.port, ms: Date.now() - t0 });
  } catch (e) {
    xlog('connect FAIL', { host: parsed.address, port: parsed.port, err: e?.message || String(e) });
    cleanup();
    try {
      bodyReader.releaseLock();
    } catch {}
    return new Response('connect fail', { status: 502 });
  }

  const remoteWriter = remoteSocket.writable.getWriter();

  // آپلود: early data + باقی bodyReader → remote
  const uploadDone = (async () => {
    try {
      if (remoteEarly && remoteEarly.byteLength > 0) {
        if (limiter.enabled) await limiter.take(remoteEarly.byteLength);
        bytesUp += remoteEarly.byteLength;
        sessionBytes += remoteEarly.byteLength;
        await remoteWriter.write(remoteEarly);
        maybeReport();
        xlog('upload early', { n: remoteEarly.byteLength });
      }
      while (!closed) {
        const { done, value } = await bodyReader.read();
        if (value && value.byteLength) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (limiter.enabled) await limiter.take(chunk.byteLength);
          bytesUp += chunk.byteLength;
          sessionBytes += chunk.byteLength;
          maybeReport();
          await remoteWriter.write(chunk);
        }
        if (done) {
          xlog('upload body done', { up: bytesUp });
          break;
        }
        if (userUuid && !getUserByUuid(userUuid)) {
          xlog('upload stop: user revoked');
          closed = true;
          break;
        }
      }
    } catch (e) {
      xlog('upload ERR', e?.message || String(e));
    } finally {
      try {
        await remoteWriter.close();
      } catch {}
      try {
        bodyReader.releaseLock();
      } catch {}
      xlog('upload finally', { up: bytesUp, ms: Date.now() - t0 });
    }
  })();

  // دانلود: remote → response stream (+ هدر پاسخ VLESS اول)
  const { readable, writable } = new TransformStream();
  const downWriter = writable.getWriter();

  const downloadDone = (async () => {
    try {
      await downWriter.write(new Uint8Array([0, 0]));
      xlog('download sent vless ok header');
      const reader = remoteSocket.readable.getReader();
      while (!closed) {
        const { done, value } = await reader.read();
        if (value && value.byteLength) {
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          if (userUuid && !getUserByUuid(userUuid)) {
            xlog('download stop: user revoked');
            closed = true;
            break;
          }
          if (limiter.enabled) await limiter.take(chunk.byteLength);
          bytesDown += chunk.byteLength;
          sessionBytes += chunk.byteLength;
          maybeReport();
          await downWriter.write(chunk);
        }
        if (done) {
          xlog('download remote done', { down: bytesDown });
          break;
        }
      }
      try {
        reader.releaseLock();
      } catch {}
    } catch (e) {
      xlog('download ERR', e?.message || String(e));
    } finally {
      try {
        await downWriter.close();
      } catch {}
      try {
        remoteSocket.close();
      } catch {}
      cleanup();
    }
  })();

  ctx.waitUntil(
    Promise.allSettled([uploadDone, downloadDone]).then((results) => {
      xlog('session settled', {
        up: results[0]?.status,
        down: results[1]?.status,
        bytesUp,
        bytesDown,
        ms: Date.now() - t0,
      });
      cleanup();
    })
  );

  xlog('RESPONSE stream start', {
    dest: `${parsed.address}:${parsed.port}`,
    userId,
    ms: Date.now() - t0,
  });

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}

// ====================== VLESS WebSocket (legacy fallback) ======================
async function handleVlessWebSocket(request, env, ctx) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }

  try {
    await ensureUsersLoaded(env);
  } catch {}
  if (nodeDisabled) return new Response('Node disabled', { status: 503 });

  let pair, client, server;
  try {
    pair = new WebSocketPair();
    [client, server] = Object.values(pair);
    server.binaryType = 'arraybuffer';
    server.accept();
  } catch (e) {
    console.log('ws accept:', e?.message || e);
    return new Response('ws error', { status: 500 });
  }

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
  let isDnsMode = false; // همه DNS از DoH
  let userBlockAds = true; // از cfg یوزر؛ انتخاب upstream DoH

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
      if (userId) touchActiveIp(envRef, userId, clientIP);
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

    // first-chunk log disabled (noise) — فقط DNS خاص لاگ می‌شود

    // بعد از اتصال — ترافیک عادی (TCP non-DNS)
    if (remoteWriter) {
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

    // حالت DNS: کلاینت کوئری DNS فرستاده → فقط از DoH جواب بده (MITM)
    if (isDnsMode) {
      if (userUuid && !getUserByUuid(userUuid)) {
        return safeClose('revoked');
      }
      try {
        // تشخیص فریم: ممکن است چند کوئری length-prefixed پشت سر هم باشد (TCP DNS / XUDP)
        // یا یک raw DNS message
        const queries = [];
        let usedLengthPrefix = false;

        if (chunk.byteLength >= 2) {
          let off = 0;
          while (off + 2 <= chunk.byteLength) {
            const len = (chunk[off] << 8) | chunk[off + 1];
            if (len < 12 || off + 2 + len > chunk.byteLength) break;
            queries.push(chunk.subarray(off + 2, off + 2 + len));
            off += 2 + len;
            usedLengthPrefix = true;
          }
        }
        // اگر هیچ فریم معتبری پیدا نشد → کل پیام یک کوئری خام است
        if (queries.length === 0) {
          queries.push(chunk);
          usedLengthPrefix = false;
        }

        for (const query of queries) {
          if (limiter.enabled) await limiter.take(query.byteLength);
          bytesUp += query.byteLength;
          sessionBytes += query.byteLength;
          maybeReport();

          const resp = await dohResolve(query, userBlockAds);
          if (!resp || resp.byteLength < 12) {
            continue;
          }

          let out;
          if (usedLengthPrefix) {
            // همان سبک length-prefix که کلاینت فرستاده بود
            out = new Uint8Array(2 + resp.byteLength);
            out[0] = (resp.byteLength >> 8) & 0xff;
            out[1] = resp.byteLength & 0xff;
            out.set(resp, 2);
          } else {
            // raw
            out = resp;
          }

          if (limiter.enabled) await limiter.take(out.byteLength);
          bytesDown += out.byteLength;
          sessionBytes += out.byteLength;
          maybeReport();
          try {
            server.send(out);
          } catch {
            safeClose('ws send fail');
            return;
          }
        }
      } catch (e) {
        safeClose('dns fail');
      }
      return;
    }

    // هدر VLESS
    const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    const parsed = parseVlessHeader(buf);
    if (!parsed.ok) {
      return safeClose('bad header');
    }

    userUuid = parsed.uuid.toLowerCase();
    const cfg = getUserByUuid(userUuid);
    if (!cfg) {
      return safeClose('user not found');
    }
    userId = cfg.id;

    // تشخیص DNS / DoT
    const dnsAddrs = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9',
      'dns.google', 'dns.google.com', 'cloudflare-dns.com', 'dns.adguard.com',
      'dns.quad9.net', 'dns.dnsforge.de', 'one.one.one.one', 'dns.cloudflare.com'];
    const addrLower = String(parsed.address || '').toLowerCase();
    const isDot = parsed.port === 853; // DNS over TLS
    const isDnsRequest =
      parsed.port === 53 ||
      (parsed.cmd === 2 && (parsed.port === 53 || dnsAddrs.includes(addrLower)));

    // DoT (853) را قطع می‌کنیم تا کلاینت به DNS/53 برگردد و با DoH جواب داده شود
    if (isDot) {
      dnsStats.dotBlocked += 1;
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('dot blocked, use dns/53');
    }

    if (parsed.cmd === 2 && !isDnsRequest) {
      sendOk();
      return safeClose('udp not supported');
    }
    if (parsed.cmd !== 1 && parsed.cmd !== 2) {
      sendOk();
      return safeClose('only TCP');
    }

    // محدودیت IP همزمان
    const acq = await tryAcquireIp(envRef, userId, clientIP, cfg.ipLimit);
    if (!acq.ok) {
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('ip limit');
    }

    joined = true;
    userBlockAds = cfg.blockAds === true;
    activeConns.set(userUuid, (activeConns.get(userUuid) || 0) + 1);
    // محدودیت سرعت (۰ = نامحدود) — روی آپلود و دانلود اعمال می‌شود
    limiter = getLimiter(userUuid, cfg.speedLimitKBps);

    // ثبت سشن برای قطع بعد از sync
    sessionRef = { close: () => safeClose('revoked') };
    if (!activeSessions.has(userUuid)) activeSessions.set(userUuid, new Set());
    activeSessions.get(userUuid).add(sessionRef);

    let host = parsed.address;
    let port = parsed.port;

    // ad-block فقط اگر برای این یوزر blockAds فعال باشد (و مقصد DNS نباشد)
    if (!isDnsRequest && cfg.blockAds === true && (await isAdHost(host))) {
      joined = false;
      sendOk();
      await sleep(SOFT_REJECT_DELAY_MS);
      return safeClose('ad blocked');
    }

    // ========== همه DNS از DoH ==========
    if (isDnsRequest) {
      isDnsMode = true;
      sendOk();

      // اگر early data / rest داشت، همان را به عنوان کوئری اول پردازش کن
      if (parsed.rest && parsed.rest.byteLength > 0) {
        const first = new Uint8Array(parsed.rest);
        await processChunk(first);
      }
      return;
    }

    // ========== TCP عادی ==========
    try {
      remoteSocket = connect({ hostname: host, port });
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
    try {
      const data = ev.data;
      if (data instanceof ArrayBuffer) {
        processChunk(new Uint8Array(data)).catch(() => { try { safeClose(); } catch {} });
      } else if (data instanceof Blob) {
        data.arrayBuffer()
          .then((b) => processChunk(new Uint8Array(b)))
          .catch(() => { try { safeClose(); } catch {} });
      } else if (typeof data === 'string') {
        processChunk(new TextEncoder().encode(data)).catch(() => { try { safeClose(); } catch {} });
      }
    } catch {
      try { safeClose(); } catch {}
    }
  });
  server.addEventListener('close', () => { try { safeClose(); } catch {} });
  server.addEventListener('error', () => { try { safeClose(); } catch {} });

  if (earlyData && earlyData.byteLength > 0) {
    try {
      ctx.waitUntil(processChunk(earlyData).catch(() => {}));
    } catch {
      processChunk(earlyData).catch(() => {});
    }
  }

  return new Response(null, { status: 101, webSocket: client });
}

// ====================== Status ======================
async function serveStatusPage(id) {
  try {
    const res = await fetch(STATUS_HTML_URL, {
      headers: { 'User-Agent': 'cf-child/4.9.4' },
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
           <h1>SAOW</h1><p>Edge Node (Push + D1 + DoH)</p>
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
      _ctx = ctx;
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
          ok: true, id: childId, version: VERSION, mode: 'push-d1-doh-xhttp',
          transport: ['xhttp', 'ws'],
          activeUsers: Math.max(activeUsersCount, ips.length),
          usersLoaded: usersByUuid.size, activeIpEntries: ips.length,
          nodeDisabled, lastSyncAt: lastSyncAt || null, hasDB: !!env.DB,
          doh: DOH_URL, dohClean: DOH_CLEAN_URL, dohCacheSize: dohCache.size,
          dns: { ...dnsStats },
          limits: Array.from(usersByUuid.values()).slice(0, 20).map((u) => ({
            id: u.id,
            ipLimit: u.ipLimit,
            speedLimitKBps: u.speedLimitKBps,
            blockAds: u.blockAds,
          })),
          memIpUsers: memIps.size,
        }), { headers: { 'content-type': 'application/json' } });
      }

      // XHTTP stream-one: هر POST غیر از /sync (با body)
      if (request.method === 'POST' && request.body) {
        console.log('[route] POST → xhttp', path, request.headers.get('host'), getClientIP(request));
        return handleVlessXhttp(request, env, ctx);
      }

      // WebSocket legacy (برای سازگاری موقت)
      if (isWs) {
        console.log('[route] WS → vless', path, getClientIP(request));
        return handleVlessWebSocket(request, env, ctx);
      }

      // سایر متدها — برای دیباگ اینکه کلاینت چه می‌فرستد
      if (path !== '/' && path !== '/version' && path !== '/health') {
        console.log('[route] OTHER', request.method, path, {
          host: request.headers.get('host'),
          upgrade: request.headers.get('upgrade'),
          ct: request.headers.get('content-type'),
          ip: getClientIP(request),
        });
      }

      if (path === '/') return serveStatusPage(childId);

      if (path === '/version') {
        await ensureUsersLoaded(env);
        return new Response(JSON.stringify({
          version: VERSION, role: 'node', mode: 'push-d1-doh-xhttp', id: childId,
          usersLoaded: usersByUuid.size, nodeDisabled,
          lastSyncAt: lastSyncAt || null, hasDB: !!env.DB,
          doh: DOH_URL, dohClean: DOH_CLEAN_URL,
          dns: { ...dnsStats },
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
