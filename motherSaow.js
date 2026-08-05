// ================================================================================
// Saow Mother Worker + Telegram Bot — Architecture & Function Map
// Version: mother-bot-3.5 (unified Cloudflare Worker)
// ================================================================================

// OVERVIEW
// --------
// This is a single Cloudflare Worker that acts as:
// 1) Mother control-plane for a distributed VLESS proxy panel
// 2) Telegram bot for admins and end-users (shop / support / services)
// 3) D1-backed API for child proxy nodes (heartbeat, connect, usage, IP limits)
// 4) Subscription generator (/pull?token=UUID) that builds VLESS links pointing
//    at healthy child workers

// Architecture:
//   Telegram users  <->  Mother Worker (bot + D1 + /pull + /api)
//   Child Workers   <->  Mother /api/node/report  (auth: API_SECRET)
//   Clients (V2Ray) <->  Child Workers (WebSocket VLESS) -> TCP destinations

// Important env bindings (examples):
//   BOT_TOKEN, ADMIN_IDS, DB (D1), CF_TOKEN, MOTHER_ACCOUNT_ID, WORKER_NAME,
//   MOTHER_URL (optional self URL)

// Constants:
//   VERSION / BOT_VERSION — panel version strings
//   TG / CF_API — Telegram & Cloudflare API bases
//   CHILD_WORKER_URL / MOTHER_CODE_URL — GitHub raw sources for updates
//   CF_TOKEN_URL — deep link to create CF API token with needed permissions
//   API_ROOT=/api  SUB_PATH=/pull
//   NODE_TTL — how long a child stays "online" without heartbeat (default 6 min)
//   IP_IDLE_MS — how long an IP stays in active_ips without touch (prefer >= 5 min)
//   API_SECRET — shared secret child->mother reports (must match child)

// --------------------------------------------------------------------------------
// MAIN ENTRY
// --------------------------------------------------------------------------------
// export default.fetch(request, env, ctx)
//   Routes:
//   - POST / or /webhook → Telegram updates (handleTelegramUpdate), sets env._SELF_URL
//   - GET /setwebhook → helper to set Telegram webhook to this worker
//   - /api/* → handleApi (child node API + status/users)
//   - /pull → subscription body for user UUID token
//   - / or /version → JSON version

// --------------------------------------------------------------------------------
// TELEGRAM ROUTING
// --------------------------------------------------------------------------------
// handleTelegramUpdate(update, env)
//   callback_query → handleCallback
//   message → handleMessage

// isAdmin(id, env)
//   true if id is listed in env.ADMIN_IDS (comma-separated)

// handleMessage(msg, env)
//   Admin branch:
//     - photo ignored for shop payment (admins handled separately if needed)
//     - reply-based flows: create user, expiry, notes, quotas, IP, speed, shop
//       settings (card, channel, support, plans, test quota/days), CF token for
//       node create/delete/account status
//     - free text: findManagedNodeByText → showNodeDetail; else findUserByText → showUser
//     - /start|/menu|منو → showMain
//   User branch (if shop enabled):
//     - photo → handlePaymentScreenshot (buy or renew receipt)
//     - force channel join via checkChannelMember / sendForceJoin
//     - /start → showUserHome
//     - otherwise short help

// handleCallback(cq, env)
//   Always answerCallbackQuery first.
//   User-safe callbacks first (even for admins):
//     user_home, user_buy, user_plan, user_test, user_guide, user_support,
//     user_check_join, user_my_services, mysvc, revoke_uuid, renew_req, renew_plan
//   Then admin-only:
//     orders approve/reject, shop_* settings, plans, test settings, main/status,
//     users, user fields, nodes, del_node, update_child, update_mother,
//     mother_account_status, node_acc, renew_do (optional legacy)

// --------------------------------------------------------------------------------
// ADMIN UI
// --------------------------------------------------------------------------------
// showMain — main admin keyboard (users, nodes, shop, status, create user, ...)
// showStatus / getStatusData — aggregate users, traffic, online, nodes
// showUsers / showUser — user list and single user card with edit actions
// Menus for fields: expiryMenu, setExpiry, ipLimitMenu, speedMenu, quotaMenu,
//   dailyMenu, toggleAds, doToggle, doReset, doClearIPs, showSub, sendQR,
//   confirmDelete, doDelete, setField
// create user via force_reply name → upsertUser

// --------------------------------------------------------------------------------
// SHOP (END-USER SALES)
// --------------------------------------------------------------------------------
// Tables (created in d1Ready):
//   shop_settings (key/value), shop_plans, shop_orders

// getShopSetting / setShopSetting / getShopConfig
//   Config keys: enabled, card_number, card_name, support_id, channel_id,
//   channel_link, force_join, test_enabled, test_quota_mb, test_days,
//   guide_text, welcome_text, plus ephemeral ustate:USERID and order_type:*

// showShopAdmin — toggles sale on/off, force-join on/off, card, channel, plans,
//   test account, pending orders, texts (2-column keyboard)

// showShopPlansAdmin / listPlans — CRUD plans (name|days|quota_gb|daily_gb|price|ip)
// showPendingOrders — pending orders with approve/reject

// User flow:
//   showUserHome → buy / test / my services / guide / support
//   showBuyPlans → showPayInfo (sets state waiting_receipt)
//   handlePaymentScreenshot → creates shop_orders pending, forwards photo to admins
//   approveOrder:
//     if renew (order_type=renew or plan_name starts with تمدید / panel_user_id set):
//       keep same user id + UUID; extend expiry; update quota/ip from plan
//     else:
//       create new panel user; notes include order:ID | tg:TELEGRAM_ID
//     notify user with sub URL; update admin message caption when possible
//   rejectOrder — mark rejected, notify user

// Renew flow:
//   showMyServiceDetail → requestRenew → list plans → showRenewPayInfo
//     state: waiting_receipt_renew + panelUserId + planId
//   same screenshot path; approveOrder renew branch preserves UUID

// Test account:
//   giveTestAccount once per tg user (test_used:ID flag), limited quota/days

// Channel lock:
//   checkChannelMember uses getChatMember; if force_join on and not member → block
//   sendForceJoin shows channel link + "I joined" callback
//   IMPORTANT: force_join must be toggled ON after setting channel_id;
//   bot must be admin in the channel

// User services:
//   showMyServices — approved orders + users named shop-TGID / test-TGID / notes tg:
//   showMyServiceDetail — usage, expiry, UUID, sub link, renew, revoke UUID
//   revokeUserUuid — new UUID, old sub dies

// State helpers:
//   setUserState / getUserState / clearUserState stored in shop_settings

// --------------------------------------------------------------------------------
// NODES (CLOUDFLARE CHILD WORKERS)
// --------------------------------------------------------------------------------
// managed_nodes table: id, script_name, account_id, db_id, db_name, token_encrypted, url
// children table: heartbeat presence (id, url, version, capacity, last_seen, active_users)

// showNodesManage / showNodes — list managed + alive; buttons delete/reinstall/account
// showNodeCreate / node_create_token — ask CF token (with CF_TOKEN_URL button)
// createCloudflareNode(token):
//   - refuse if same account as mother (getMotherAccountId)
//   - create D1, upload child script from CHILD_WORKER_URL with bindings
//     (MOTHER_URL, etc.), save managed_nodes + token
// updateChildNode — delete old worker/D1 carefully, reinstall, cleanup children rows
// doDeleteNode / confirmDeleteNode — delete worker + D1 + managed_nodes + children
// doUpdateMother — redeploy mother from MOTHER_CODE_URL using env.CF_TOKEN /
//   WORKER_NAME / preserve bindings
// showMotherAccountStatus / showNodeAccountStatus / getAccountRequestsToday
//   GraphQL httpRequests1dGroups for today's request count

// findManagedNodeByText / showNodeDetail
//   Admin can paste script name or workers.dev URL to open node detail

// removeChildByScriptName — purge heartbeat rows matching script name after
//   delete/update so subscription stops using stale nodes

// --------------------------------------------------------------------------------
// USERS / QUOTA / IP (D1)
// --------------------------------------------------------------------------------
// users, usage, usage_daily, active_ips tables

// upsertUser / getUserById / getUserByUuid / getUsers / deleteUser / mapUserRow
// addUsage / getUsage / getDailyUsage / resetUsage
// touchAndCheckIpLimit — enforce concurrent distinct IPs; refresh last_seen
// getActiveIPCount / listActiveIps / clearActiveIps
// buildFullUser — status active|disabled|expired|quota-exceeded|daily-quota-exceeded

// IP_IDLE_MS too low (e.g. 90s) can cause IP flapping; prefer several minutes.

// --------------------------------------------------------------------------------
// CHILD API (handleApi)
// --------------------------------------------------------------------------------
// Auth: Bearer / X-API-Key / X-Secret must equal API_SECRET

// POST /api/node/report
//   type=heartbeat → registerChild
//   type=connect → IP limit + enabled + quota checks → { enabled, config }
//   type=disconnect → add residual usage
//   type=usage → add usage, refresh IP, maybe action=close if quota/disabled

// GET /api/status|/info → getStatusData
// GET /api/nodes → healthy children
// GET /api/users?uuid=|/id= → full user (child getUserConfig should use this,
//   NOT legacy /api/item)

// --------------------------------------------------------------------------------
// SUBSCRIPTION
// --------------------------------------------------------------------------------
// generateSubscription(env, user, motherHost)
//   If disabled/expired/quota → info-only dummy VLESS links
//   Else select child host:
//     prefer managed_nodes that match healthy children heartbeat
//     else first managed with url
//     else first alive
//   Build: status line (fake 127.0.0.1) + preferred domains + IRCF clean IPs
//   All real links use child hostname as WS host/SNI, path /?u=USERID

// Domains: ensureDomainsList (GitHub list), ensureIrcfResolved (DNS A cache)
// buildVlessLink / buildInfoLink / formatBytesShort / daysRemaining

// --------------------------------------------------------------------------------
// CHILD WORKER (separate script childWorker.js) — expected behavior
// --------------------------------------------------------------------------------
// - WebSocket VLESS parse → TCP connect via cloudflare:sockets
// - reportToMother connect/usage/disconnect/heartbeat
// - getUserConfig should call Mother GET /api/users?uuid=
// - Do NOT use ipLimit as local concurrent WebSocket cap; use LOCAL_MAX_CONNS (~32)
// - Prefer fail-open if mother connect response is null (network blip)
// - Avoid gating download on server.readyState === 1; try/catch send instead
// - REPORT_THRESHOLD controls how often usage is posted (e.g. 1–5 MB)
// - Ad block optional via blocklist + port 53 redirect to AdGuard DNS

// --------------------------------------------------------------------------------
// CF HELPERS
// --------------------------------------------------------------------------------
// cfFetch(path, token, options) — Cloudflare API v4 JSON
// d1Ready(env) — CREATE TABLE IF NOT EXISTS for all schema pieces
// json / send / edit / answer / escape — HTTP & Telegram helpers
// generateId / generateUuid / todayKey / extractSecret / requireAuth

// --------------------------------------------------------------------------------
// OPERATIONAL NOTES / COMMON PITFALLS
// --------------------------------------------------------------------------------
// 1) After setting channel_id, toggle force_join ON or lock never activates.
// 2) editMessageText fails on photo messages (order receipts); use try/edit then
//    send, or shop_orders_new that always sends a new message.
// 3) Subscription may still serve old child if children heartbeat rows not cleaned
//    after node replace — always removeChildByScriptName on delete/update.
// 4) Mother and child API_SECRET must match.
// 5) Child cannot be installed on the same CF account as mother (policy in create).
// 6) D1 free tier ~10 DBs per account — updating nodes must delete old DBs.
// 7) Admin ADMIN_IDS must include numeric Telegram user id as string.
// 8) Renew must preserve UUID; only expiry/quota/ip change from selected plan.

// END OF MAP
// ================================================================================
const VERSION = "mother-bot-3.10-push";
const BOT_VERSION = "3.8.99";
const TG = "https://api.telegram.org";
const CF_API = "https://api.cloudflare.com/client/v4";
const CHILD_WORKER_URL = "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/childWorker.js";
const MOTHER_CODE_URL = "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/motherSaow.js";
const CF_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Saow%20Installer";
const STATUS_HTML_URL = "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/master-status.html";

const API_ROOT = "/api";
const SUB_PATH = "/pull";
const NODE_TTL = 1 * 60 * 1000; // ۱ دقیقه بدون پاسخ → آفلاین
const IP_IDLE_MS = 5 * 60 * 1000;
const API_SECRET = "saow-pan2";

// ====================== Main Entry ======================
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "POST" && (path === "/" || path === "/webhook")) {
        const update = await request.json();
        env._SELF_URL = url.origin;
        ctx.waitUntil(handleTelegramUpdate(update, env));
        return new Response("OK");
      }

      if (request.method === "GET" && path === "/setwebhook") {
        const target = url.searchParams.get("url") || url.origin;
        const res = await fetch(`${TG}/bot${env.BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: target,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: true,
          }),
        });
        return new Response(await res.text(), { status: res.status });
      }

      if (path.startsWith(API_ROOT)) {
        return handleApi(request, env, path.slice(API_ROOT.length) || "/");
      }

      if (path === SUB_PATH || path === SUB_PATH + "/") {
        const token = url.searchParams.get("token") || "";
        if (!token) return new Response("token required", { status: 401 });

        const user = await getUserByUuid(env, token);
        if (!user) return new Response("invalid", { status: 404 });

        const ua = (request.headers.get("user-agent") || "").toLowerCase();
        const accept = (request.headers.get("accept") || "").toLowerCase();
        const isBrowser =
          accept.includes("text/html") ||
          /mozilla|chrome|safari|firefox|edge|opera|samsung/i.test(ua);

        if (isBrowser) {
          return serveSubPage(request, env, user, url);
        }

        ctx.waitUntil(ensureDomainsList());
        ctx.waitUntil(ensureIrcfResolved());
        const body = await generateSubscription(env, user, url.hostname);
        return new Response(body, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "profile-update-interval": "6",
          },
        });
      }

      if (path === "/") {
        return serveStatusPage(request, env);
      }

      if (path === "/version") {
        return json({ v: VERSION, r: "core+bot+push" });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error("main error", e);
      return new Response("Error", { status: 500 });
    }
  },

  // Cron Trigger: هر دقیقه یک Full Sync کامل
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fullSyncAll(env));
  },
};

// ====================== Push + State Exchange ======================

/**
 * همگام‌سازی کامل با همه نودهای مدیریت‌شده
 * فقط مادر درخواست می‌زند. فرزند هیچ‌وقت شروع‌کننده نیست.
 */
async function fullSyncAll(env) {
  if (!(await d1Ready(env))) return;
  try {
    const managed = await getManagedNodes(env);
    if (!managed.length) return;

    // موازی اما با محدودیت ساده برای جلوگیری از overload
    const results = await Promise.allSettled(
      managed.map((node) => syncWithChild(env, node))
    );

    let ok = 0;
    for (const r of results) if (r.status === "fulfilled" && r.value) ok++;
    console.log(`fullSyncAll: ${ok}/${managed.length} success`);
  } catch (e) {
    console.error("fullSyncAll error", e?.message);
  }
}

/**
 * یک نود خاص را همگام می‌کند.
 * مادر → POST /sync به فرزند
 * فرزند در همان پاسخ گزارش کامل می‌دهد.
 */
async function syncWithChild(env, node) {
  if (!node?.url) return false;

  try {
    const users = await getUsers(env);
    const payload = {
      type: "full_sync",
      timestamp: Date.now(),
      mother_version: VERSION,
      users: users.map((u) => ({
        id: u.id,
        uuid: u.uuid,
        name: u.name,
        enabled: !!u.enabled,
        expiry: u.expiry || null,
        quotaBytes: u.quotaBytes || 0,
        dailyQuotaBytes: u.dailyQuotaBytes || 0,
        speedLimitKBps: u.speedLimitKBps || 0,
        ipLimit: u.ipLimit || 1,
        blockAds: !!u.blockAds,
      })),
      node: {
        disabled: node.is_disabled === 1,
        script_name: node.script_name,
      },
    };

    const target = String(node.url).replace(/\/$/, "") + "/sync";
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
        "X-Mother-Secret": API_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.log(`sync fail ${node.script_name}: HTTP ${res.status}`);
      return false;
    }

    const report = await res.json();
    if (!report || report.ok === false) {
      console.log(`sync reject ${node.script_name}:`, report?.reason || "no ok");
      return false;
    }

    await processChildReport(env, node, report);
    return true;
  } catch (e) {
    console.log(`syncWithChild ${node.script_name}:`, e?.message);
    return false;
  }
}

/**
 * پردازش گزارش دریافتی از فرزند در پاسخ همان درخواست
 */
async function processChildReport(env, node, report) {
  if (!(await d1Ready(env))) return;
  const now = Date.now();
  const childId = report.child_id || node.script_name || node.id;

  // به‌روزرسانی حضور نود
  try {
    await env.DB.prepare(`
      INSERT INTO children (id, url, version, capacity, last_seen, active_users, healthy, meta)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = CASE WHEN excluded.url != '' THEN excluded.url ELSE children.url END,
        version = excluded.version,
        capacity = excluded.capacity,
        last_seen = excluded.last_seen,
        active_users = excluded.active_users,
        healthy = 1,
        meta = excluded.meta
    `).bind(
      childId,
      node.url || "",
      report.version || "",
      report.capacity ?? 50,
      now,
      report.active_users ?? 0,
      JSON.stringify(report.meta || {})
    ).run();
  } catch (e) {
    console.log("processChildReport children:", e?.message);
  }

  // مصرف (دلتا از آخرین sync)
  if (Array.isArray(report.usage)) {
    for (const u of report.usage) {
      const uid = u.user_id || u.id;
      const up = Number(u.up) || 0;
      const down = Number(u.down) || 0;
      if (uid && up + down > 0) {
        await addUsage(env, uid, up, down);
      }
    }
  }

  // IPهای فعال گزارش‌شده توسط این نود
  if (Array.isArray(report.active_ips)) {
    for (const entry of report.active_ips) {
      const uid = entry.user_id || entry.id;
      if (!uid) continue;
      const ips = Array.isArray(entry.ips) ? entry.ips : [];
      for (const ip of ips) {
        if (!ip) continue;
        try {
          await env.DB.prepare(`
            INSERT INTO active_ips (user_id, ip, last_seen, child_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, ip) DO UPDATE SET
              last_seen = excluded.last_seen,
              child_id = excluded.child_id
          `).bind(uid, String(ip), now, childId).run();
        } catch {}
      }
    }
  }
}

/** فراخوانی همگام‌سازی پس از تغییرات مدیریتی (بدون مسدود کردن پاسخ تلگرام) */
function triggerSync(env) {
  fullSyncAll(env).catch((e) => console.log("triggerSync:", e?.message));
}


async function createFullBackup(env) {
  if (!(await d1Ready(env))) throw new Error("D1 not ready");

  const [
    usersRes,
    usageRes,
    usageDailyRes,
    managedRes,
    shopSettingsRes,
    shopPlansRes,
    shopOrdersRes,
    cfAccountsRes,
    childrenRes,
    activeIpsRes,
  ] = await Promise.all([
    env.DB.prepare("SELECT * FROM users").all(),
    env.DB.prepare("SELECT * FROM usage").all(),
    env.DB.prepare("SELECT * FROM usage_daily").all(),
    env.DB.prepare("SELECT * FROM managed_nodes").all(),
    env.DB.prepare("SELECT * FROM shop_settings").all(),
    env.DB.prepare("SELECT * FROM shop_plans").all(),
    env.DB.prepare("SELECT * FROM shop_orders").all(),
    env.DB.prepare("SELECT * FROM cf_accounts").all(),
    env.DB.prepare("SELECT * FROM children").all().catch(() => ({ results: [] })),
    env.DB.prepare("SELECT * FROM active_ips").all().catch(() => ({ results: [] })),
  ]);

  // ustate موقت را از بکاپ حذف می‌کنیم تا وضعیت session منتقل نشود
  const shopSettings = (shopSettingsRes.results || []).filter(
    (s) => !String(s.key || "").startsWith("ustate:")
  );

  const backup = {
    version: VERSION,
    bot_version: BOT_VERSION,
    created_at: new Date().toISOString(),
    created_at_tehran: new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" }),
    tables: {
      users: usersRes.results || [],
      usage: usageRes.results || [],
      usage_daily: usageDailyRes.results || [],
      managed_nodes: managedRes.results || [],
      shop_settings: shopSettings,
      shop_plans: shopPlansRes.results || [],
      shop_orders: shopOrdersRes.results || [],
      cf_accounts: cfAccountsRes.results || [],
      children: childrenRes.results || [],
      active_ips: activeIpsRes.results || [],
    },
  };

  return backup;
}

async function handleBackupImport(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    await send(chatId, "⏳ در حال دانلود و بررسی فایل بکاپ...", env);

    const fileId = msg.document.file_id;
    const fileRes = await fetch(`${TG}/bot${env.BOT_TOKEN}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json();
    if (!fileData.ok) throw new Error("getFile failed");

    const filePath = fileData.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
    const contentRes = await fetch(downloadUrl);
    const text = await contentRes.text();

    let backup;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new Error("فایل JSON معتبر نیست");
    }

    if (!backup?.tables?.users) throw new Error("ساختار بکاپ نامعتبر است");

    await clearUserState(env, userId);
    await send(chatId, "⏳ در حال ایمپورت کامل جداول (کاربران + نودها + فروشگاه + اکانت‌ها)...", env);

    // پاک کردن کامل جداول پنل تا انتقال ۱۰۰٪ باشد
    await env.DB.batch([
      env.DB.prepare("DELETE FROM users"),
      env.DB.prepare("DELETE FROM usage"),
      env.DB.prepare("DELETE FROM usage_daily"),
      env.DB.prepare("DELETE FROM shop_settings"),
      env.DB.prepare("DELETE FROM shop_plans"),
      env.DB.prepare("DELETE FROM shop_orders"),
      env.DB.prepare("DELETE FROM managed_nodes"),
      env.DB.prepare("DELETE FROM cf_accounts"),
      env.DB.prepare("DELETE FROM children"),
      env.DB.prepare("DELETE FROM active_ips"),
    ]);

    // درج کاربران
    for (const u of backup.tables.users || []) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO users
        (id, name, uuid, enabled, expiry, quota_bytes, daily_quota_bytes, speed_limit_kbps,
         ip_limit, clean_ip, block_ads, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        u.id, u.name, u.uuid, u.enabled ?? 1, u.expiry || null,
        u.quota_bytes || 0, u.daily_quota_bytes || 0, u.speed_limit_kbps || 0,
        u.ip_limit || 1, u.clean_ip || "", u.block_ads ?? 1, u.notes || "",
        u.created_at || Date.now(), u.updated_at || Date.now()
      ).run();
    }

    // usage
    for (const r of backup.tables.usage || []) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO usage (user_id, up, down, total, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(r.user_id, r.up || 0, r.down || 0, r.total || 0, r.updated_at || Date.now()).run();
    }

    // usage_daily
    for (const r of backup.tables.usage_daily || []) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO usage_daily (user_id, day, up, down, total)
        VALUES (?, ?, ?, ?, ?)
      `).bind(r.user_id, r.day, r.up || 0, r.down || 0, r.total || 0).run();
    }

    // shop_settings (حالت‌های موقت ustate را رد می‌کنیم)
    for (const s of backup.tables.shop_settings || []) {
      const key = String(s.key || "");
      if (key.startsWith("ustate:")) continue;
      await setShopSetting(env, key, s.value);
    }

    // shop_plans
    for (const p of backup.tables.shop_plans || []) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO shop_plans
        (id, name, days, quota_gb, daily_gb, price, ip_limit, enabled, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        p.id, p.name, p.days || 30, p.quota_gb || 0, p.daily_gb || 0,
        p.price || 0, p.ip_limit || 1, p.enabled ?? 1, p.sort_order || 0
      ).run();
    }

    // shop_orders
    for (const o of backup.tables.shop_orders || []) {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO shop_orders
        (id, user_id, username, plan_id, plan_name, price, status, created_at, approved_at, panel_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        o.id, o.user_id, o.username || "", o.plan_id, o.plan_name,
        o.price || 0, o.status || "pending", o.created_at || Date.now(),
        o.approved_at || null, o.panel_user_id || null
      ).run();
    }

    // managed_nodes (نودهای فرزند — بکاپ کامل)
    let nodesImported = 0;
    for (const n of backup.tables.managed_nodes || []) {
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO managed_nodes
          (id, script_name, account_id, db_id, db_name, token_encrypted, url, is_disabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          n.id || n.script_name,
          n.script_name || n.id,
          n.account_id || "",
          n.db_id || "",
          n.db_name || "",
          n.token_encrypted || "",
          n.url || "",
          n.is_disabled ?? 0,
          n.created_at || Date.now()
        ).run();
        nodesImported++;
      } catch (e) {
        console.log("import managed_node fail:", e?.message);
      }
    }

    // cf_accounts (توکن‌ها و ایمیل اکانت‌های CF)
    let accountsImported = 0;
    for (const a of backup.tables.cf_accounts || []) {
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO cf_accounts
          (account_id, token, email, name, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          a.account_id,
          a.token || "",
          a.email || "",
          a.name || "",
          a.updated_at || Date.now()
        ).run();
        accountsImported++;
      } catch (e) {
        console.log("import cf_account fail:", e?.message);
      }
    }

    // children / active_ips در بکاپ اختیاری‌اند (معمولاً runtime هستند)
    if (Array.isArray(backup.tables.children)) {
      for (const c of backup.tables.children) {
        try {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO children
            (id, url, version, capacity, last_seen, active_users, healthy, meta)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            c.id, c.url || "", c.version || "", c.capacity ?? 50,
            c.last_seen || 0, c.active_users ?? 0, c.healthy ?? 1,
            typeof c.meta === "string" ? c.meta : JSON.stringify(c.meta || {})
          ).run();
        } catch {}
      }
    }
    if (Array.isArray(backup.tables.active_ips)) {
      for (const ip of backup.tables.active_ips) {
        try {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO active_ips (user_id, ip, last_seen, child_id)
            VALUES (?, ?, ?, ?)
          `).bind(ip.user_id, ip.ip, ip.last_seen || Date.now(), ip.child_id || "").run();
        } catch {}
      }
    }

    triggerSync(env);

    const usersCount = (backup.tables.users || []).length;
    const plansCount = (backup.tables.shop_plans || []).length;
    const ordersCount = (backup.tables.shop_orders || []).length;

    return send(
      chatId,
      `✅ <b>ایمپورت کامل شد</b>\n\n` +
        `👥 کاربران: <b>${usersCount}</b>\n` +
        `🖥 نودها: <b>${nodesImported}</b>\n` +
        `☁️ اکانت CF: <b>${accountsImported}</b>\n` +
        `📦 پلن‌ها: <b>${plansCount}</b>\n` +
        `🧾 سفارش‌ها: <b>${ordersCount}</b>\n\n` +
        `همگام‌سازی با نودها شروع شد.`,
      env,
      [[{ text: "🏠 منو", callback_data: "main" }], [{ text: "🖥 نودها", callback_data: "nodes" }]]
    );
  } catch (e) {
    await clearUserState(env, userId);
    return send(chatId, `❌ خطا در ایمپورت:\n<code>${escape(e.message)}</code>`, env, [
      [{ text: "🏠 منو", callback_data: "main" }],
    ]);
  }
}

async function updateAllChildNodes(chatId, env, msgId) {
  await edit(chatId, msgId, "⏳ در حال آماده‌سازی آپدیت همه نودها...", env);

  const managed = await getManagedNodes(env);
  if (!managed.length) {
    return edit(chatId, msgId, "هیچ نود مدیریت‌شده‌ای وجود ندارد.", env, [
      [{ text: "🔙", callback_data: "nodes_manage" }],
    ]);
  }

  let success = 0;
  let failed = 0;
  const results = [];

  for (const node of managed) {
    try {
      await edit(chatId, msgId, `⏳ در حال آپدیت نود ${success + failed + 1}/${managed.length}\n<code>${escape(node.script_name)}</code>`, env);

      // حذف قدیمی
      const token = node.token_encrypted;
      const accountId = node.account_id;
      const oldScript = node.script_name;
      const oldDbId = node.db_id;

      try {
        await cfFetch(`/accounts/${accountId}/workers/scripts/${oldScript}`, token, { method: "DELETE" });
      } catch {}

      if (oldDbId) {
        try {
          await cfFetch(`/accounts/${accountId}/d1/database/${oldDbId}`, token, { method: "DELETE" });
        } catch {}
      }

      await removeChildByScriptName(env, oldScript);
      await removeManagedNode(env, node.id);

      // کمی صبر
      await new Promise((r) => setTimeout(r, 1500));

      // ساخت مجدد با همان توکن
      const createResult = await createCloudflareNodeSilent(token, env); // نسخهٔ silent پایین
      if (createResult.ok) {
        success++;
        results.push(`✅ ${node.script_name} → ${createResult.scriptName}`);
      } else {
        failed++;
        results.push(`❌ ${node.script_name}: ${createResult.error}`);
      }
    } catch (e) {
      failed++;
      results.push(`❌ ${node.script_name}: ${e.message}`);
    }
  }

  triggerSync(env);

  const text =
    `✅ آپدیت همه نودها تمام شد\n\n` +
    `موفق: <b>${success}</b>\n` +
    `ناموفق: <b>${failed}</b>\n\n` +
    results.slice(0, 15).map((r) => escape(r)).join("\n");

  return edit(chatId, msgId, text, env, [
    [{ text: "📊 وضعیت نودها", callback_data: "nodes" }],
    [{ text: "🔙 مدیریت", callback_data: "nodes_manage" }],
  ]);
}

async function createCloudflareNodeSilent(token, env) {
  try {
    const accountsRes = await cfFetch("/accounts?per_page=5", token);
    if (!accountsRes.success || !accountsRes.result?.length) {
      return { ok: false, error: "accounts failed" };
    }
    const accountId = accountsRes.result[0].id;

    const motherAccountId = await getMotherAccountId(env);
    if (motherAccountId && motherAccountId === accountId) {
      return { ok: false, error: "same account as mother" };
    }

    let accountSubdomain = null;
    try {
      const subRes = await cfFetch(`/accounts/${accountId}/workers/subdomain`, token);
      if (subRes.success && subRes.result?.subdomain) accountSubdomain = subRes.result.subdomain;
    } catch {}

    if (!accountSubdomain) {
      return { ok: false, error: "no workers.dev subdomain" };
    }

    const codeRes = await fetch(CHILD_WORKER_URL);
    if (!codeRes.ok) return { ok: false, error: "fetch child code failed" };
    let workerCode = await codeRes.text();

    workerCode = workerCode.replace(
      /(?:const|let|var)\s+MOTHER_URL\s*=\s*[^;]+;?/,
      `let MOTHER_URL = null;`
    );
    workerCode = workerCode.replace(
      /(export\s+default\s*\{\s*async\s+fetch\s*\(\s*request\s*,\s*env\s*,\s*ctx\s*\)\s*\{)/,
      `$1\n    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";\n`
    );

    const randomNum = Math.floor(10000 + Math.random() * 90000);
    const scriptName = `wk-${randomNum}`;
    const dbName = `db-${randomNum}`;
    const nodeUrl = `https://${scriptName}.${accountSubdomain}.workers.dev`;

    const dbRes = await cfFetch(`/accounts/${accountId}/d1/database`, token, {
      method: "POST",
      body: JSON.stringify({ name: dbName }),
    });
    if (!dbRes.success) return { ok: false, error: "D1 create failed" };
    const databaseId = dbRes.result.uuid || dbRes.result.id;

    const motherUrl = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");

    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2024-09-23",
      bindings: [
        { type: "d1", name: "DB", database_id: databaseId },
        { type: "plain_text", name: "MOTHER_URL", text: motherUrl },
        { type: "plain_text", name: "API_SECRET", text: API_SECRET },
      ],
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");

    const uploadRes = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const uploadJson = await uploadRes.json();
    if (!uploadJson.success) {
      try { await cfFetch(`/accounts/${accountId}/d1/database/${databaseId}`, token, { method: "DELETE" }); } catch {}
      return { ok: false, error: "upload failed" };
    }

    try {
      await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, token, {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      });
    } catch {}

    await saveManagedNode(env, {
      id: scriptName,
      script_name: scriptName,
      account_id: accountId,
      db_id: databaseId,
      db_name: dbName,
      token_encrypted: token,
      url: nodeUrl,
      created_at: Date.now(),
    });

    return { ok: true, scriptName, url: nodeUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}


// ====================== Telegram Handlers ======================

async function purgeUnknownChildren(env) {
  if (!(await d1Ready(env))) return;
  try {
    const managed = await getManagedNodes(env);
    if (!managed.length) return;

    const allChildren = await env.DB.prepare("SELECT id, url FROM children").all();
    const rows = allChildren.results || [];

    for (const c of rows) {
      const isKnown = managed.some(
        (m) =>
          c.id?.includes(m.script_name) ||
          (m.url && c.id?.includes(String(m.script_name || "").replace(/-/g, ""))) ||
          (m.script_name && c.url?.includes(m.script_name))
      );
      if (!isKnown) {
        await env.DB.prepare("DELETE FROM children WHERE id = ?").bind(c.id).run();
      }
    }
  } catch (e) {
    console.log("purgeUnknownChildren:", e?.message);
  }
}

async function serveSubPage(request, env, user, url) {
  const full = await buildFullUser(env, user);
  const clientIP =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "—";
  const country = request.cf?.country || "—";

  const linksText = await generateSubscription(env, user, url.hostname);
  const links = linksText.split("\n").filter((l) => l.startsWith("vless://"));

  const usedGB = full.usage?.totalGB || 0;
  const quotaGB = user.quotaBytes > 0 ? +(user.quotaBytes / 1073741824).toFixed(2) : 0;
  const usagePercent = quotaGB > 0 ? Math.min(100, (usedGB / quotaGB) * 100) : 0;

  const data = {
    name: user.name,
    status: full.status,
    expiryText: user.expiry
      ? new Date(user.expiry).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
      : "∞",
    usageText: usedGB + " GB",
    quotaText: quotaGB > 0 ? quotaGB + " GB" : "∞",
    usagePercent,
    activeIPs: full.activeIPs,
    ipLimit: user.ipLimit,
    clientIP,
    country,
    links,
    subUrl: `${url.origin}/pull?token=${user.uuid}`,
  };

  let html = "";
  try {
    const res = await fetch(
      "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/sub-status.html",
      { cf: { cacheTtl: 300, cacheEverything: true } }
    );
    if (res.ok) html = await res.text();
  } catch {}

  if (!html) {
    html = `<!DOCTYPE html><html><body style="background:#05060f;color:#e2e8f0;font-family:sans-serif;padding:2rem">
      <h1>SAOW</h1><p>${full.status}</p><p>${usedGB} / ${quotaGB || "∞"} GB</p></body></html>`;
  }

  const inject = `<script>window.__SAOW_SUB__=${JSON.stringify(data)};</script>`;
  if (html.includes("</head>")) {
    html = html.replace("</head>", inject + "</head>");
  } else {
    html = inject + html;
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function toggleNodeStatus(chatId, nodeId, env, msgId) {
  await edit(chatId, msgId, "⏳ در حال تغییر وضعیت نود...", env);

  try {
    const node = await getManagedNode(env, nodeId);
    if (!node) {
      return edit(chatId, msgId, "❌ نود پیدا نشد.", env, [[{ text: "🔙", callback_data: "nodes" }]]);
    }

    const newDisabled = node.is_disabled === 1 ? 0 : 1;

    await env.DB.prepare("UPDATE managed_nodes SET is_disabled = ? WHERE id = ?")
      .bind(newDisabled, nodeId)
      .run();

    // فوری وضعیت children را هم به‌روز کن
    await env.DB.prepare(
      "UPDATE children SET healthy = ?, active_users = 0 WHERE id LIKE ? OR url LIKE ?"
    )
      .bind(newDisabled === 1 ? 0 : 1, `%${node.script_name}%`, `%${node.script_name}%`)
      .run();

    // فوری به خود نود هم بگو (اگر آنلاین باشد)
    triggerSync(env);

    const statusMsg =
      newDisabled === 1
        ? `🔒 نود <code>${escape(node.script_name)}</code> <b>کاملاً قفل و غیرفعال شد</b>.\n\n• تمام اتصال‌های جدید ریجکت خواهند شد.\n• لینک‌های سابسکریپشن به این نود متصل نمی‌شوند.`
        : `🔓 نود <code>${escape(node.script_name)}</code> <b>آنلاک و فعال شد</b>.\n\n• همگام‌سازی و خروجی ساب به حالت عادی برگشت.`;

    return edit(chatId, msgId, statusMsg, env, [
      [{ text: "🔙 جزئیات نود", callback_data: `node_detail:${nodeId}` }],
      [{ text: "🖥 لیست نودها", callback_data: "nodes" }],
    ]);
  } catch (err) {
    return edit(chatId, msgId, `❌ خطا در تغییر وضعیت:\n<code>${escape(err.message)}</code>`, env, [
      [{ text: "🔙", callback_data: "nodes" }],
    ]);
  }
}

/** خروج/ورود نود از چرخه ساب (نود فعال می‌ماند، فقط در لینک ساب انتخاب نمی‌شود) */
async function toggleNodeExcludeSub(chatId, nodeId, env, msgId) {
  await edit(chatId, msgId, "⏳ در حال تغییر وضعیت ساب...", env);
  try {
    const node = await getManagedNode(env, nodeId);
    if (!node) {
      return edit(chatId, msgId, "❌ نود پیدا نشد.", env, [[{ text: "🔙", callback_data: "nodes" }]]);
    }
    const newVal = node.exclude_sub === 1 ? 0 : 1;
    await env.DB.prepare("UPDATE managed_nodes SET exclude_sub = ? WHERE id = ?")
      .bind(newVal, nodeId)
      .run();

    const msg =
      newVal === 1
        ? `🚫 نود <code>${escape(node.script_name)}</code> از <b>چرخه ساب</b> خارج شد.\n\n• نود همچنان آنلاین و فعال است.\n• لینک ساب کاربران عمومی به این نود اشاره نمی‌کند.\n• کاربران قفل‌شده روی همین نود همچنان آن را می‌گیرند.`
        : `✅ نود <code>${escape(node.script_name)}</code> دوباره وارد <b>چرخه ساب</b> شد.`;

    return edit(chatId, msgId, msg, env, [
      [{ text: "🔙 جزئیات نود", callback_data: `node_detail:${nodeId}` }],
      [{ text: "🖥 لیست نودها", callback_data: "nodes" }],
    ]);
  } catch (err) {
    return edit(chatId, msgId, `❌ خطا:\n<code>${escape(err.message)}</code>`, env, [
      [{ text: "🔙", callback_data: "nodes" }],
    ]);
  }
}

function extractUuidFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const m = raw.match(/^vless:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
  if (m) return m[1].toLowerCase();

  const m2 = raw.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (m2) return m2[1].toLowerCase();

  return null;
}

async function findManagedNodeByText(text, env) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const managed = await getManagedNodes(env);
  if (!managed.length) return null;

  let host = "";
  let pathHint = raw.toLowerCase();
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      host = u.hostname.toLowerCase();
      pathHint = host;
    }
  } catch {}

  const hostFirst = host ? host.split(".")[0] : "";

  for (const m of managed) {
    const name = String(m.script_name || "").toLowerCase();
    const url = String(m.url || "").toLowerCase();
    const id = String(m.id || "").toLowerCase();

    if (raw.toLowerCase() === name || raw.toLowerCase() === id) return m;
    if (name && pathHint.includes(name)) return m;
    if (hostFirst && name && (hostFirst === name || hostFirst.includes(name) || name.includes(hostFirst))) return m;
    if (url && (raw.toLowerCase() === url || url.includes(pathHint) || pathHint.includes(url))) return m;
    if (url && host && url.includes(host)) return m;
  }
  return null;
}

async function showNodeDetail(chatId, node, env, msgId = null) {
  if (!node) {
    return msgId
      ? edit(chatId, msgId, "❌ نود پیدا نشد.", env, [[{ text: "🔙", callback_data: "nodes" }]])
      : send(chatId, "❌ نود پیدا نشد.", env);
  }

  // وضعیت زنده از D1
  const alive = await getHealthyChildren(env);
  const live = alive.find(
    (a) =>
      a.id.includes(node.script_name) ||
      (node.url && a.id.includes(String(node.script_name || "").replace(/-/g, ""))) ||
      (node.url && a.url && String(a.url).includes(node.script_name))
  );

  // اگر آفلاین بود، یک probe سریع
  let probe = null;
  if (!live && node.url) {
    probe = await probeNodeHealth(node.url);
  }

  const online = !!live || !!(probe && probe.ok);
  const src = live || (probe && probe.ok ? probe : null);

  const lastSeen = src?.lastSeen
    ? new Date(src.lastSeen).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
    : "هنوز همگام‌سازی نشده";

  // اطلاعات اکانت + توکن
  let email = "—";
  let reqToday = "—";
  let tokenDisplay = "—";
  let accError = "";
  try {
    const acc = await getNodeAccountInfo(env, node);
    if (acc?.email) email = acc.email;
    if (acc?.requestsToday != null) reqToday = Number(acc.requestsToday).toLocaleString("fa-IR");
    if (acc?.token) {
      // نمایش کامل توکن (طبق درخواست شما)
      tokenDisplay = acc.token;
    }
    if (acc?.error) accError = acc.error;
  } catch (e) {
    accError = e?.message || "خطا در دریافت اطلاعات اکانت";
  }

  const lock = node.is_disabled === 1 ? "🔒 قفل کامل" : "🔓 باز";
  const subState = node.exclude_sub === 1 ? "🚫 خارج از ساب" : "✅ در چرخه ساب";
  let statusLine = online ? "🟢 آنلاین" : "🔴 آفلاین";

  if (!online && probe) {
    if (probe.statusCode === 429) {
      statusLine = "🟠 محدودیت نرخ (۴۲۹) — ممکن است هنوز کار کند";
    } else if (probe.statusCode && probe.statusCode !== 0) {
      statusLine = `🔴 آفلاین (HTTP ${probe.statusCode})`;
    }
  }

  const usersFa =
    src?.activeUsers != null ? faNum(src.activeUsers) : "—";
  const capFa = src?.capacity != null ? faNum(src.capacity) : "—";
  const childNo = shortChildId(node.script_name);

  let text =
    `${statusLine} · ${lock} · ${subState}\n\n` +
    `📛 <code>${escape(node.script_name)}</code>\n` +
    `🔢 شماره child: <b>${faNum(childNo)}</b>\n` +
    `🔗 <code>${escape(node.url || "—")}</code>\n` +
    `☁️ Account: <code>${escape((node.account_id || "—").slice(0, 12))}…</code>\n` +
    `📧 ${escape(email)}\n` +
    `📈 درخواست امروز: <b>${escape(reqToday)}</b>\n` +
    `👥 همزمان: <b>${usersFa}</b> / ${capFa}\n` +
    `📦 نسخه: ${escape(src?.version || "—")}\n` +
    `⏱ همگام: ${lastSeen}\n\n` +
    `🔑 <b>توکن CF:</b>\n<code>${escape(tokenDisplay)}</code>`;

  if (accError) {
    text += `\n\n⚠️ خطا در اطلاعات اکانت:\n<code>${escape(accError.slice(0, 150))}</code>`;
  }

  if (!online && probe) {
    if (probe.statusCode && probe.statusCode !== 0) {
      text += `\n\n📡 Probe: HTTP <code>${probe.statusCode}</code>`;
    }
    if (probe.error) {
      text += `\n<code>${escape(String(probe.error).slice(0, 120))}</code>`;
    }
    if (probe.statusCode === 429) {
      text += `\n\n💡 نود ممکن است همچنان سرویس دهد؛ مادر به‌خاطر Rate Limit همگام نمی‌شود.`;
    }
  }

  const toggleText = node.is_disabled === 1 ? "🔓 آنلاک کامل" : "🔒 قفل کامل";
  const subToggleText =
    node.exclude_sub === 1 ? "✅ ورود به چرخه ساب" : "🚫 خروج از چرخه ساب";

  const kb = [
    [
      { text: "🔄 رفرش", callback_data: `node_detail:${node.id}` },
      { text: toggleText, callback_data: `toggle_node:${node.id}` },
    ],
    [{ text: subToggleText, callback_data: `toggle_sub:${node.id}` }],
    [
      { text: "♻️ نصب مجدد", callback_data: `update_child:${node.id}` },
      { text: "📈 اکانت CF", callback_data: `node_acc:${node.id}` },
    ],
    [{ text: "🗑 حذف", callback_data: `del_node:${node.id}` }],
    [
      { text: "🖥 همه نودها", callback_data: "nodes" },
      { text: "🔙 مدیریت", callback_data: "nodes_manage" },
    ],
  ];

  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showRenewPayInfo(chatId, tgUserId, panelUserId, planId, env, msgId = null) {
  const user = await getUserById(env, panelUserId);
  if (!user) {
    return send(chatId, "سرویس پیدا نشد.", env, [[{ text: "🏠 منو", callback_data: "user_home" }]]);
  }

  const plans = await listPlans(env, false);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) {
    return send(chatId, "پلن پیدا نشد.", env, [[{ text: "🔙", callback_data: `mysvc:${panelUserId}` }]]);
  }

  const cfg = await getShopConfig(env);
  if (!cfg.cardNumber) {
    return send(chatId, "اطلاعات پرداخت هنوز تنظیم نشده.", env, [
      [{ text: "🏠 منو", callback_data: "user_home" }],
    ]);
  }

  await setUserState(env, tgUserId, {
    step: "waiting_receipt_renew",
    planId,
    panelUserId,
  });

  const text =
    `♻️ <b>پرداخت تمدید</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `سرویس: <b>${escape(user.name)}</b>\n` +
    `پلن: <b>${escape(plan.name)}</b>\n` +
    `مدت اضافه‌شونده: <b>${faNum(plan.days)} روز</b>\n` +
    `مبلغ: <b>${Number(plan.price).toLocaleString("fa-IR")} تومان</b>\n\n` +
    `⚠️ UUID شما عوض نمی‌شود؛ فقط حجم/زمان طبق پلن اعمال می‌شود.\n\n` +
    `به این کارت واریز کنید:\n` +
    `💳 <code>${escape(cfg.cardNumber)}</code>\n` +
    `👤 ${escape(cfg.cardName)}\n\n` +
    `بعد از پرداخت، <b>اسکرین‌شات رسید</b> را همین‌جا بفرستید.`;

  const kb = [[{ text: "❌ انصراف", callback_data: `mysvc:${panelUserId}` }]];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showMyServiceDetail(chatId, tgUserId, panelUserId, env, msgId = null) {
  const user = await getUserById(env, panelUserId);
  if (!user) {
    return edit(chatId, msgId, "سرویس پیدا نشد.", env, [[{ text: "🔙", callback_data: "user_my_services" }]]);
  }
  const notes = String(user.notes || "");
  const name = String(user.name || "");
  const ok =
    name === `test-${tgUserId}` ||
    name.startsWith(`shop-${tgUserId}`) ||
    notes.includes(`tg:${tgUserId}`) ||
    notes.includes(`order:`);
  if (!ok && !isAdmin(tgUserId, env)) {
    return edit(chatId, msgId, "دسترسی ندارید.", env, [[{ text: "🔙", callback_data: "user_home" }]]);
  }

  const full = await buildFullUser(env, user);
  const base = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");
  const sub = `${base}/pull?token=${user.uuid}`;
  const expiryText = user.expiry
    ? new Date(user.expiry).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
    : "∞";
  const quota = user.quotaBytes === 0 ? "∞" : (user.quotaBytes / 1073741824).toFixed(2) + " GB";
  const used = (full.usage?.totalGB || 0) + " GB";

  const text =
    `${full.status === "active" ? "🟢" : "🔴"} <b>${escape(user.name)}</b>\n\n` +
    `📊 وضعیت: <b>${full.status}</b>\n` +
    `📈 مصرف: <b>${used}</b> / ${quota}\n` +
    `📅 انقضا: <b>${expiryText}</b>\n` +
    `🌐 IP: ${full.activeIPs}/${user.ipLimit}\n\n` +
    `🔑 UUID:\n<code>${user.uuid}</code>\n\n` +
    `🔗 ساب:\n<code>${sub}</code>`;

  const kb = [
    [{ text: "🔄 تغییر UUID (ریوک)", callback_data: `revoke_uuid:${user.id}` }],
    [{ text: "♻️ تمدید (انتخاب پلن و پرداخت)", callback_data: `renew_req:${user.id}` }],
    [{ text: "🔙 سرویس‌های من", callback_data: "user_my_services" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function revokeUserUuid(chatId, tgUserId, panelUserId, env, msgId) {
  const user = await getUserById(env, panelUserId);
  if (!user) return edit(chatId, msgId, "پیدا نشد.", env, [[{ text: "🔙", callback_data: "user_my_services" }]]);

  const newUuid = generateUuid();
  await upsertUser(env, { ...user, uuid: newUuid });
  triggerSync(env);

  const base = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");
  const sub = `${base}/pull?token=${newUuid}`;

  const text =
    `✅ UUID جدید ساخته شد. لینک قبلی باطل است.\n\n` +
    `🔑 <code>${newUuid}</code>\n\n` +
    `🔗 <code>${sub}</code>`;
  return edit(chatId, msgId, text, env, [
    [{ text: "🔙 جزئیات سرویس", callback_data: `mysvc:${panelUserId}` }],
    [{ text: "🏠 منو", callback_data: "user_home" }],
  ]);
}

async function requestRenew(chatId, tgUserId, panelUserId, env, msgId) {
  const user = await getUserById(env, panelUserId);
  if (!user) {
    return edit(chatId, msgId, "سرویس پیدا نشد.", env, [
      [{ text: "🔙", callback_data: "user_my_services" }],
    ]);
  }

  const plans = await listPlans(env, true);
  if (!plans.length) {
    return edit(chatId, msgId, "فعلاً پلنی برای تمدید وجود ندارد.", env, [
      [{ text: "🔙", callback_data: `mysvc:${panelUserId}` }],
    ]);
  }

  await setUserState(env, tgUserId, {
    step: "renew_select_plan",
    panelUserId,
  });

  let text =
    `♻️ <b>تمدید سرویس</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `سرویس: <b>${escape(user.name)}</b>\n` +
    `🔑 UUID شما حفظ می‌شود.\n\n` +
    `یک پلن انتخاب کنید:`;

  const kb = [];
  for (const p of plans) {
    const daysFa = faNum(p.days);
    const priceFa = Number(p.price).toLocaleString("fa-IR");
    const quotaFa = p.quota_gb > 0 ? `${faNum(p.quota_gb)} گیگ` : "نامحدود";
    kb.push([
      {
        text: `✨ ${p.name} · ${daysFa}روز · ${quotaFa} · ${priceFa}ت`,
        callback_data: `renew_plan:${panelUserId}:${p.id}`,
      },
    ]);
  }
  kb.push([{ text: "🔙 بازگشت", callback_data: `mysvc:${panelUserId}` }]);

  return edit(chatId, msgId, text, env, kb);
}

async function showShopPlansAdmin(chatId, env, msgId = null) {
  const plans = await listPlans(env, false);
  let text = `📦 <b>مدیریت پلن‌ها</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  const kb = [];
  if (!plans.length) text += "هنوز پلنی ساخته نشده.\n";
  for (const p of plans) {
    const st = p.enabled ? "🟢" : "🔴";
    const daysFa = faNum(p.days);
    const quotaFa = p.quota_gb > 0 ? `${faNum(p.quota_gb)} گیگ` : "∞";
    const priceFa = Number(p.price).toLocaleString("fa-IR");
    text += `${st} <b>${escape(p.name)}</b>\n   ${daysFa} روز · ${quotaFa} · ${priceFa} ت\n\n`;
    kb.push([
      { text: `${p.enabled ? "🔴" : "🟢"} ${p.name}`, callback_data: `shop_plan_toggle:${p.id}` },
      { text: "🗑", callback_data: `shop_plan_del:${p.id}` },
    ]);
  }
  kb.push([{ text: "➕ پلن جدید", callback_data: "shop_plan_add" }]);
  kb.push([{ text: "🔙 تنظیمات فروش", callback_data: "shop_admin" }]);
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showPendingOrders(chatId, env, msgId = null) {
  let rows = [];
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM shop_orders WHERE status = 'pending' ORDER BY created_at DESC LIMIT 20"
    ).all();
    rows = r.results || [];
  } catch {}

  let text = `🧾 <b>سفارش‌های در انتظار</b>\n\n`;
  const kb = [];
  if (!rows.length) text += "موردی نیست.";
  for (const o of rows) {
    text += `• <code>${o.id}</code> | ${escape(o.plan_name)} | ${o.user_id}\n`;
    kb.push([
      { text: `✅ ${o.id}`, callback_data: `order_approve:${o.id}` },
      { text: `❌`, callback_data: `order_reject:${o.id}` },
    ]);
  }
  kb.push([{ text: "🔙 تنظیمات فروش", callback_data: "shop_admin" }]);

  if (msgId) {
    try {
      await edit(chatId, msgId, text, env, kb);
      return;
    } catch (e) {}
  }
  return send(chatId, text, env, kb);
}

async function setUserState(env, userId, data) {
  await setShopSetting(env, `ustate:${userId}`, JSON.stringify(data || {}));
}
async function getUserState(env, userId) {
  const raw = await getShopSetting(env, `ustate:${userId}`, "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function clearUserState(env, userId) {
  await setShopSetting(env, `ustate:${userId}`, "");
}

async function showMyServices(chatId, tgUserId, env, msgId = null) {
  let orders = [];
  try {
    const r = await env.DB.prepare(
      "SELECT * FROM shop_orders WHERE user_id = ? AND status = 'approved' ORDER BY approved_at DESC"
    )
      .bind(tgUserId)
      .all();
    orders = r.results || [];
  } catch {}

  const allUsers = await getUsers(env);
  const linked = allUsers.filter((u) => {
    const n = String(u.name || "");
    const notes = String(u.notes || "");
    return (
      n === `test-${tgUserId}` ||
      n.startsWith(`shop-${tgUserId}`) ||
      notes.includes(`tg:${tgUserId}`) ||
      notes.includes(`order:`)
    );
  });

  const panelIds = new Set(orders.map((o) => o.panel_user_id).filter(Boolean));
  for (const u of linked) panelIds.add(u.id);

  if (!panelIds.size) {
    const text = `📦 سرویسی ندارید.\n\nاز منو می‌توانید خرید کنید یا اکانت تست بگیرید.`;
    const kb = [[{ text: "🔙 منو", callback_data: "user_home" }]];
    return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
  }

  let text = `📦 <b>سرویس‌های شما</b>\n\nروی هر سرویس بزنید:`;
  const kb = [];
  for (const pid of panelIds) {
    const u = await getUserById(env, pid);
    if (!u) continue;
    const full = await buildFullUser(env, u);
    const emoji = full.status === "active" ? "🟢" : "🔴";
    kb.push([{ text: `${emoji} ${u.name}`, callback_data: `mysvc:${u.id}` }]);
  }
  kb.push([{ text: "🔙 منو", callback_data: "user_home" }]);
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showShopAdmin(chatId, env, msgId = null) {
  const cfg = await getShopConfig(env);
  const text =
    `🛍 <b>تنظیمات فروش</b>\n\n` +
    `فروش: ${cfg.enabled ? "🟢 روشن" : "🔴 خاموش / تعطیل"}\n` +
    `قفل کانال: ${cfg.forceJoin ? "🟢 روشن" : "🔴 خاموش"}\n` +
    `کارت: <code>${escape(cfg.cardNumber || "—")}</code>\n` +
    `به نام: ${escape(cfg.cardName || "—")}\n` +
    `پشتیبانی: ${escape(cfg.supportId || "—")}\n` +
    `کانال: ${escape(cfg.channelId || "—")}\n` +
    `لینک کانال: ${escape(cfg.channelLink || "—")}`;

  const kb = [
    [
      { text: cfg.enabled ? "🔴 تعطیل فروش" : "🟢 باز کردن فروش", callback_data: "shop_toggle" },
      { text: cfg.forceJoin ? "🔓 خاموش قفل" : "🔒 روشن قفل", callback_data: "shop_force_toggle" },
    ],
    [
      { text: "💳 کارت", callback_data: "shop_set_card" },
      { text: "💬 پشتیبانی", callback_data: "shop_support" },
    ],
    [
      { text: "📢 آیدی کانال", callback_data: "shop_channel" },
      { text: "🔗 لینک کانال", callback_data: "shop_channel_link" },
    ],
    [
      { text: "📦 پلن‌ها", callback_data: "shop_plans" },
      { text: "🎁 اکانت تست", callback_data: "shop_test" },
    ],
    [
      { text: "🧾 سفارش‌ها", callback_data: "shop_orders" },
      { text: "📝 متن‌ها", callback_data: "shop_texts" },
    ],
    [{ text: "🔙 منو ادمین", callback_data: "main" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function giveTestAccount(chatId, userId, env, msgId = null, fromUser = null) {
  const cfg = await getShopConfig(env);
  if (!cfg.testEnabled) {
    return send(chatId, "اکانت تست فعلاً غیرفعال است.", env);
  }
  const flag = await getShopSetting(env, `test_used:${userId}`, "0");
  if (flag === "1") {
    return send(chatId, "شما قبلاً اکانت تست دریافت کرده‌اید.", env);
  }

  const id = generateId();
  const uuid = generateUuid();
  const expiry = new Date(Date.now() + cfg.testDays * 86400000).toISOString();
  const quotaBytes = Math.floor(cfg.testQuotaMb * 1024 * 1024);

  const uname = fromUser?.username ? `@${fromUser.username}` : "—";
  const fname = [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(" ") || "—";
  const notes = `test | tg:${userId} | ${uname} | ${fname}`.slice(0, 200);

  await upsertUser(env, {
    id,
    name: `test-${userId}`.slice(0, 32),
    uuid,
    enabled: true,
    expiry,
    quotaBytes,
    dailyQuotaBytes: 0,
    speedLimitKBps: 0,
    ipLimit: 1,
    cleanIp: "",
    blockAds: true,
    notes,
  });
  await setShopSetting(env, `test_used:${userId}`, "1");
  triggerSync(env);

  const subUrl = `${env.MOTHER_URL || env._SELF_URL}/pull?token=${uuid}`;
  const text =
    `🎁 <b>اکانت تست فعال شد</b>\n\n` +
    `حجم: ${cfg.testQuotaMb}MB\n` +
    `مدت: ${cfg.testDays} روز\n\n` +
    `🔗 ساب:\n<code>${subUrl}</code>`;
  return msgId ? edit(chatId, msgId, text, env) : send(chatId, text, env);
}

async function approveOrder(chatId, orderId, env, msgId) {
  const order = await env.DB.prepare("SELECT * FROM shop_orders WHERE id = ?").bind(orderId).first();
  if (!order) {
    return edit(chatId, msgId, "سفارش پیدا نشد.", env, [
      [{ text: "🔙", callback_data: "shop_orders" }],
    ]);
  }
  if (order.status !== "pending") {
    return edit(chatId, msgId, `قبلاً پردازش شده: <b>${order.status}</b>`, env, [
      [{ text: "🔙", callback_data: "shop_orders" }],
    ]);
  }

  const plan = (await listPlans(env, false)).find((p) => p.id === order.plan_id);
  if (!plan) return edit(chatId, msgId, "پلن پیدا نشد.", env);

  const orderType = await getShopSetting(env, `order_type:${orderId}`, "new");
  const isRenew = orderType === "renew" || (order.panel_user_id && String(order.plan_name || "").startsWith("تمدید"));

  let panelUserId = order.panel_user_id;
  let uuid;
  let id;

  if (isRenew) {
    if (!panelUserId) {
      panelUserId = await getShopSetting(env, `order_renew_panel:${orderId}`, "");
    }
    const existing = await getUserById(env, panelUserId);
    if (!existing) {
      return edit(chatId, msgId, "سرویس برای تمدید پیدا نشد.", env);
    }

    id = existing.id;
    uuid = existing.uuid;

    const base =
      existing.expiry && Date.parse(existing.expiry) > Date.now()
        ? Date.parse(existing.expiry)
        : Date.now();
    const expiry = plan.days > 0 ? new Date(base + plan.days * 86400000).toISOString() : null;

    const quotaBytes = plan.quota_gb > 0 ? Math.floor(plan.quota_gb * 1073741824) : 0;
    const dailyQuotaBytes = plan.daily_gb > 0 ? Math.floor(plan.daily_gb * 1073741824) : 0;

    await upsertUser(env, {
      ...existing,
      uuid,
      enabled: true,
      expiry,
      quotaBytes: quotaBytes || existing.quotaBytes,
      dailyQuotaBytes: dailyQuotaBytes || existing.dailyQuotaBytes,
      ipLimit: plan.ip_limit || existing.ipLimit,
      notes: `${existing.notes || ""} | تمدید | order:${orderId} | tg:${order.user_id} | @${order.username || "-"}`.slice(0, 200),
    });
  } else {
    id = generateId();
    uuid = generateUuid();
    const expiry = plan.days > 0 ? new Date(Date.now() + plan.days * 86400000).toISOString() : null;
    const quotaBytes = plan.quota_gb > 0 ? Math.floor(plan.quota_gb * 1073741824) : 0;
    const dailyQuotaBytes = plan.daily_gb > 0 ? Math.floor(plan.daily_gb * 1073741824) : 0;
    const name = `shop-${order.user_id}-${plan.name}`.slice(0, 32);

    await upsertUser(env, {
      id,
      name,
      uuid,
      enabled: true,
      expiry,
      quotaBytes,
      dailyQuotaBytes,
      speedLimitKBps: 0,
      ipLimit: plan.ip_limit || 1,
      cleanIp: "",
      blockAds: true,
      notes: `خرید | order:${orderId} | tg:${order.user_id} | @${order.username || "-"} | ${plan.name}`.slice(0, 200),
    });
    panelUserId = id;
  }

  await env.DB.prepare(`
    UPDATE shop_orders SET status = 'approved', approved_at = ?, panel_user_id = ? WHERE id = ?
  `)
    .bind(Date.now(), panelUserId, orderId)
    .run();

  triggerSync(env);

  const baseUrl = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");
  const subUrl = `${baseUrl}/pull?token=${uuid}`;

  const userMsg = isRenew
    ? `✅ <b>سرویس شما تمدید شد</b>\n\n` +
      `📦 پلن: ${escape(plan.name)}\n` +
      `🔑 UUID (بدون تغییر):\n<code>${uuid}</code>\n\n` +
      `🔗 ساب:\n<code>${subUrl}</code>`
    : `✅ <b>سرویس شما فعال شد</b>\n\n` +
      `📦 ${escape(plan.name)}\n` +
      `🔑 UUID:\n<code>${uuid}</code>\n\n` +
      `🔗 لینک ساب:\n<code>${subUrl}</code>`;

  await send(order.user_id, userMsg, env, [
    [{ text: "📦 سرویس‌های من", callback_data: "user_my_services" }],
    [{ text: "🏠 منو", callback_data: "user_home" }],
  ]);

  const adminCaption =
    `✅ <b>${isRenew ? "تمدید تأیید شد" : "اکانت ساخته شد"}</b>\n\n` +
    `🆔 <code>${orderId}</code>\n` +
    `👤 tg:<code>${order.user_id}</code>\n` +
    `📦 ${escape(plan.name)}\n` +
    `پنل: <code>${panelUserId}</code>\n` +
    `UUID: <code>${uuid}</code>`;

  try {
    await fetch(`${TG}/bot${env.BOT_TOKEN}/editMessageCaption`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: msgId,
        caption: adminCaption,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "🔙 سفارش‌ها", callback_data: "shop_orders" }]],
        },
      }),
    });
  } catch {
    await edit(chatId, msgId, adminCaption, env, [
      [{ text: "🔙 سفارش‌ها", callback_data: "shop_orders" }],
    ]);
  }
}

async function rejectOrder(chatId, orderId, env, msgId) {
  const order = await env.DB.prepare("SELECT * FROM shop_orders WHERE id = ?").bind(orderId).first();
  if (!order) return edit(chatId, msgId, "سفارش پیدا نشد.", env);
  await env.DB.prepare("UPDATE shop_orders SET status = 'rejected' WHERE id = ?").bind(orderId).run();
  await send(
    order.user_id,
    `❌ سفارش <code>${orderId}</code> رد شد.\nدر صورت نیاز به پشتیبانی پیام دهید.`,
    env,
    [[{ text: "🏠 منو", callback_data: "user_home" }]]
  );
  try {
    await fetch(`${TG}/bot${env.BOT_TOKEN}/editMessageCaption`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: msgId,
        caption: `❌ سفارش <code>${orderId}</code> رد شد.`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🔙", callback_data: "shop_orders" }]] },
      }),
    });
  } catch {
    await edit(chatId, msgId, `❌ سفارش رد شد.`, env, [[{ text: "🔙", callback_data: "shop_orders" }]]);
  }
}

async function handlePaymentScreenshot(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (isAdmin(userId, env)) return;

  const state = await getUserState(env, userId);
  if (!state || !state.planId) {
    return send(chatId, "سفارش فعالی نیست. از منو خرید یا تمدید را شروع کنید.\n/start", env, [
      [{ text: "🏠 منو", callback_data: "user_home" }],
    ]);
  }

  const isRenew = state.step === "waiting_receipt_renew";
  const isBuy = state.step === "waiting_receipt";

  if (!isRenew && !isBuy) {
    return send(chatId, "سفارش فعالی نیست.\n/start", env, [
      [{ text: "🏠 منو", callback_data: "user_home" }],
    ]);
  }

  const plans = await listPlans(env, false);
  const plan = plans.find((p) => p.id === state.planId);
  if (!plan) return send(chatId, "پلن نامعتبر است.", env);

  if (isRenew) {
    const existing = await getUserById(env, state.panelUserId);
    if (!existing) return send(chatId, "سرویس برای تمدید پیدا نشد.", env);
  }

  const orderId = "o" + Math.random().toString(36).slice(2, 10);
  const orderType = isRenew ? "renew" : "new";

  await env.DB.prepare(`
    INSERT INTO shop_orders (id, user_id, username, plan_id, plan_name, price, status, created_at, panel_user_id)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `)
    .bind(
      orderId,
      userId,
      msg.from.username || "",
      plan.id,
      `${isRenew ? "تمدید: " : ""}${plan.name}`,
      plan.price,
      Date.now(),
      isRenew ? state.panelUserId : null
    )
    .run();

  await setShopSetting(env, `order_type:${orderId}`, orderType);
  if (isRenew) {
    await setShopSetting(env, `order_renew_panel:${orderId}`, state.panelUserId);
  }

  await clearUserState(env, userId);

  const photo = msg.photo[msg.photo.length - 1];
  const adminIds = (env.ADMIN_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  const caption =
    `${isRenew ? "♻️" : "🧾"} <b>${isRenew ? "درخواست تمدید" : "سفارش جدید"}</b>\n\n` +
    `🆔 سفارش: <code>${orderId}</code>\n` +
    `👤 کاربر: <code>${userId}</code> @${msg.from.username || "—"}\n` +
    `📦 پلن: ${escape(plan.name)}\n` +
    `💰 مبلغ: ${Number(plan.price).toLocaleString("fa-IR")} تومان` +
    (isRenew ? `\n🔗 پنل: <code>${state.panelUserId}</code>\n⚠️ UUID حفظ می‌شود` : "");

  for (const adminId of adminIds) {
    await fetch(`${TG}/bot${env.BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminId,
        photo: photo.file_id,
        caption,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: isRenew ? "✅ تأیید تمدید" : "✅ تأیید و ساخت اکانت",
                callback_data: `order_approve:${orderId}`,
              },
              { text: "❌ رد", callback_data: `order_reject:${orderId}` },
            ],
          ],
        },
      }),
    });
  }

  return send(
    chatId,
    `✅ رسید دریافت شد.\nشماره: <code>${orderId}</code>\n\nپس از تأیید ادمین، سرویس ${isRenew ? "تمدید" : "فعال"} می‌شود.`,
    env,
    [
      [{ text: "📦 سرویس‌های من", callback_data: "user_my_services" }],
      [{ text: "🏠 منو", callback_data: "user_home" }],
    ]
  );
}

async function listPlans(env, onlyEnabled = true) {
  if (!(await d1Ready(env))) return [];
  const sql = onlyEnabled
    ? "SELECT * FROM shop_plans WHERE enabled = 1 ORDER BY sort_order, price"
    : "SELECT * FROM shop_plans ORDER BY sort_order, price";
  try {
    const rows = await env.DB.prepare(sql).all();
    return rows.results || [];
  } catch {
    return [];
  }
}

async function showBuyPlans(chatId, env, msgId = null) {
  const plans = await listPlans(env, true);
  if (!plans.length) {
    return msgId
      ? edit(chatId, msgId, "فعلاً پلنی برای فروش وجود ندارد.", env, [[{ text: "🔙", callback_data: "user_home" }]])
      : send(chatId, "فعلاً پلنی برای فروش وجود ندارد.", env);
  }
  let text =
    `🛒 <b>انتخاب پلن</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n`;
  const kb = [];
  for (const p of plans) {
    const daysFa = faNum(p.days);
    const priceFa = Number(p.price).toLocaleString("fa-IR");
    const quotaFa = p.quota_gb > 0 ? `${faNum(p.quota_gb)} گیگ` : "نامحدود";
    const dailyFa =
      p.daily_gb > 0 ? `\n   📅 روزانه: <b>${faNum(p.daily_gb)} گیگ</b>` : "";
    text +=
      `▫️ <b>${escape(p.name)}</b>\n` +
      `   ⏱ ${daysFa} روز  ·  📦 ${quotaFa}${dailyFa}\n` +
      `   💰 <b>${priceFa} تومان</b>\n\n`;
    kb.push([
      {
        text: `✨ ${p.name}  ·  ${priceFa} ت`,
        callback_data: `user_plan:${p.id}`,
      },
    ]);
  }
  text += `━━━━━━━━━━━━━━━━━━━━\nروی پلن مورد نظر بزنید.`;
  kb.push([{ text: "🔙 بازگشت", callback_data: "user_home" }]);
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showPayInfo(chatId, userId, planId, env, msgId = null) {
  const plans = await listPlans(env, false);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return send(chatId, "پلن پیدا نشد.", env);

  const cfg = await getShopConfig(env);
  if (!cfg.cardNumber) {
    return send(chatId, "اطلاعات پرداخت هنوز توسط ادمین تنظیم نشده.", env);
  }

  await setUserState(env, userId, { step: "waiting_receipt", planId });

  const text =
    `💳 <b>پرداخت</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `پلن: <b>${escape(plan.name)}</b>\n` +
    `مدت: <b>${faNum(plan.days)} روز</b>\n` +
    `مبلغ: <b>${Number(plan.price).toLocaleString("fa-IR")} تومان</b>\n\n` +
    `به این کارت واریز کنید:\n` +
    `💳 <code>${escape(cfg.cardNumber)}</code>\n` +
    `👤 ${escape(cfg.cardName)}\n\n` +
    `بعد از پرداخت، <b>اسکرین‌شات رسید</b> را همین‌جا ارسال کنید.`;

  const kb = [[{ text: "❌ انصراف", callback_data: "user_home" }]];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showUserHome(chatId, env, msgId = null) {
  const cfg = await getShopConfig(env);
  const text = cfg.welcomeText || "به ربات خوش آمدید 👋";
  const kb = [
    [{ text: "🛒 خرید سرویس جدید", callback_data: "user_buy" }],
    [{ text: "🎁 اکانت تست ۱۰۰ مگ", callback_data: "user_test" }],
    [{ text: "📦 سرویس‌های من", callback_data: "user_my_services" }],
    [{ text: "📖 آموزش استفاده", callback_data: "user_guide" }],
    [{ text: "💬 پشتیبانی", callback_data: "user_support" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function checkChannelMember(env, userId) {
  const cfg = await getShopConfig(env);
  if (!cfg.forceJoin || !cfg.channelId) return true;
  try {
    const res = await fetch(`${TG}/bot${env.BOT_TOKEN}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.channelId, user_id: userId }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.log("getChatMember fail:", JSON.stringify(data));
      return false;
    }
    const status = data.result?.status;
    return ["creator", "administrator", "member", "restricted"].includes(status);
  } catch (e) {
    console.log("checkChannelMember error:", e?.message);
    return false;
  }
}

async function sendForceJoin(chatId, env, msgId = null) {
  const cfg = await getShopConfig(env);
  const kb = [];
  if (cfg.channelLink) {
    kb.push([{ text: "📢 عضویت در کانال", url: cfg.channelLink }]);
  } else if (cfg.channelId && String(cfg.channelId).startsWith("@")) {
    kb.push([{ text: "📢 عضویت در کانال", url: `https://t.me/${String(cfg.channelId).replace("@", "")}` }]);
  }
  kb.push([{ text: "✅ عضو شدم — ادامه", callback_data: "user_check_join" }]);
  const text = `🔒 برای استفاده از ربات باید در کانال عضو باشید.\n\nبعد از عضویت روی «عضو شدم» بزنید.`;
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function getShopSetting(env, key, def = "") {
  if (!(await d1Ready(env))) return def;
  try {
    const row = await env.DB.prepare("SELECT value FROM shop_settings WHERE key = ?").bind(key).first();
    return row?.value ?? def;
  } catch {
    return def;
  }
}

async function setShopSetting(env, key, value) {
  if (!(await d1Ready(env))) return;
  await env.DB.prepare(`
    INSERT INTO shop_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
    .bind(key, String(value))
    .run();
}

async function getShopConfig(env) {
  return {
    enabled: (await getShopSetting(env, "enabled", "0")) === "1",
    cardNumber: await getShopSetting(env, "card_number", ""),
    cardName: await getShopSetting(env, "card_name", ""),
    supportId: await getShopSetting(env, "support_id", ""),
    channelId: await getShopSetting(env, "channel_id", ""),
    channelLink: await getShopSetting(env, "channel_link", ""),
    forceJoin: (await getShopSetting(env, "force_join", "0")) === "1",
    testEnabled: (await getShopSetting(env, "test_enabled", "1")) === "1",
    testQuotaMb: parseInt(await getShopSetting(env, "test_quota_mb", "100"), 10) || 100,
    testDays: parseInt(await getShopSetting(env, "test_days", "1"), 10) || 1,
    guideText: await getShopSetting(env, "guide_text", "آموزش استفاده به‌زودی..."),
    welcomeText: await getShopSetting(env, "welcome_text", "به ربات خوش آمدید 👋"),
    sponsorText: await getShopSetting(env, "sponsor_text", ""),
  };
}

async function expiryMenu(chatId, id, env, msgId) {
  const text =
    `⏰ <b>تاریخ انقضا</b>\n\n` +
    `کاربر: <code>${id}</code>\n\n` +
    `یکی از گزینه‌ها را انتخاب کنید یا تاریخ دستی بفرستید.`;
  const kb = [
    [
      { text: "∞ نامحدود", callback_data: `expiry:${id}:0` },
      { text: "۱ روز", callback_data: `expiry:${id}:1` },
    ],
    [
      { text: "۷ روز", callback_data: `expiry:${id}:7` },
      { text: "۳۰ روز", callback_data: `expiry:${id}:30` },
    ],
    [
      { text: "۹۰ روز", callback_data: `expiry:${id}:90` },
      { text: "۱۸۰ روز", callback_data: `expiry:${id}:180` },
    ],
    [{ text: "۳۶۵ روز", callback_data: `expiry:${id}:365` }],
    [{ text: "✏️ ورود دستی", callback_data: `expirymanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}

async function setExpiry(chatId, id, days, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);

  let expiry = null;
  if (days > 0) {
    expiry = new Date(Date.now() + days * 86400000).toISOString();
  }
  await upsertUser(env, { ...user, expiry });
  triggerSync(env);
  return showUser(chatId, id, env, msgId);
}

async function handleTelegramUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message) return handleMessage(update.message, env);
}

function isAdmin(id, env) {
  return (env.ADMIN_IDS || "")
    .split(",")
    .map((x) => x.trim())
    .includes(String(id));
}

async function confirmDeleteNode(chatId, nodeId, env, msgId) {
  const node = await getManagedNode(env, nodeId);
  if (!node) {
    return edit(chatId, msgId, "❌ نود پیدا نشد.", env, [[{ text: "🔙", callback_data: "nodes" }]]);
  }
  const text =
    `🗑 <b>حذف نود</b>\n\n` +
    `نام: <code>${escape(node.script_name)}</code>\n` +
    `آدرس: <code>${escape(node.url || "—")}</code>\n\n` +
    `آیا مطمئن هستید؟ این کار غیرقابل بازگشت است.`;
  return edit(chatId, msgId, text, env, [
    [
      { text: "✅ بله، حذف کن", callback_data: `del_node_confirm:${nodeId}` },
      { text: "❌ انصراف", callback_data: "nodes" },
    ],
  ]);
}

// async function getAccountRequestsToday(token, accountId) {
//   try {
//     const today = new Date();
//     const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
//       .toISOString()
//       .slice(0, 10);
//     const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
//       .toISOString()
//       .slice(0, 10);

//     const gqlQuery = {
//       query: `query {
//         viewer {
//           accounts(filter: {accountTag: "${accountId}"}) {
//             httpRequests1dGroups(limit: 1, filter: {date_geq: "${start}", date_lt: "${end}"}) {
//               sum { requests }
//             }
//           }
//         }
//       }`,
//     };
//     const gqlRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
//       method: "POST",
//       headers: {
//         Authorization: `Bearer ${token}`,
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify(gqlQuery),
//     });
//     const gqlJson = await gqlRes.json();
//     const groups = gqlJson?.data?.viewer?.accounts?.[0]?.httpRequests1dGroups;
//     if (groups && groups[0]?.sum?.requests != null) {
//       return groups[0].sum.requests;
//     }
//   } catch {}
//   return null;
// }

async function showMotherAccountStatus(chatId, env, msgId) {
  try {
    const token = env.CF_TOKEN;
    const accountId = env.MOTHER_ACCOUNT_ID;
    if (!token || !accountId) {
      return edit(chatId, msgId, "❌ CF_TOKEN یا MOTHER_ACCOUNT_ID تنظیم نشده.", env, [
        [{ text: "🔙", callback_data: "nodes_manage" }],
      ]);
    }

    await edit(chatId, msgId, "⏳ در حال دریافت اطلاعات اکانت مادر...", env);

    let email = "—";
    try {
      const userRes = await cfFetch("/user", token);
      if (userRes.success && userRes.result) email = userRes.result.email || "—";
    } catch {}

    const requests = await getAccountRequestsToday(token, accountId);
    const requestsText = requests != null ? requests.toLocaleString("fa-IR") : "—";

    const text =
      `📈 <b>وضعیت اکانت مادر</b>\n\n` +
      `📧 ایمیل: <code>${escape(email)}</code>\n` +
      `🆔 Account ID: <code>${escape(accountId)}</code>\n` +
      `📦 Worker: <code>${escape(env.WORKER_NAME || "—")}</code>\n` +
      `🌐 URL: <code>${escape(env.MOTHER_URL || "—")}</code>\n` +
      `📊 درخواست امروز: <b>${requestsText}</b>\n\n` +
      `📅 ${new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`;

    return edit(chatId, msgId, text, env, [
      [{ text: "🔄 بروزرسانی", callback_data: "mother_account_status" }],
      [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
    ]);
  } catch (err) {
    return edit(chatId, msgId, `❌ خطا:\n<code>${escape(err.message)}</code>`, env, [
      [{ text: "🔙", callback_data: "nodes_manage" }],
    ]);
  }
}

async function showNodeAccountStatus(chatId, nodeId, env, msgId) {
  try {
    const node = await getManagedNode(env, nodeId);
    if (!node || !node.token_encrypted) {
      return edit(chatId, msgId, "❌ نود یا توکن پیدا نشد.", env, [
        [{ text: "🔙", callback_data: "nodes" }],
      ]);
    }

    await edit(chatId, msgId, "⏳ در حال دریافت اطلاعات اکانت نود...", env);

    const token = node.token_encrypted;
    const accountId = node.account_id;

    let email = "—";
    try {
      const userRes = await cfFetch("/user", token);
      if (userRes.success && userRes.result) email = userRes.result.email || "—";
    } catch {}

    const requests = await getAccountRequestsToday(token, accountId);
    const requestsText = requests != null ? requests.toLocaleString("fa-IR") : "—";

    const text =
      `📈 <b>وضعیت اکانت نود</b>\n\n` +
      `📛 نود: <code>${escape(node.script_name)}</code>\n` +
      `🔗 <code>${escape(node.url || "—")}</code>\n` +
      `📧 ایمیل: <code>${escape(email)}</code>\n` +
      `🆔 Account ID: <code>${escape(accountId)}</code>\n` +
      `📊 درخواست امروز: <b>${requestsText}</b>\n\n` +
      `📅 ${new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`;

    return edit(chatId, msgId, text, env, [
      [{ text: "🔄 بروزرسانی", callback_data: `node_acc:${nodeId}` }],
      [{ text: "🔙 لیست نودها", callback_data: "nodes" }],
    ]);
  } catch (err) {
    return edit(chatId, msgId, `❌ خطا:\n<code>${escape(err.message)}</code>`, env, [
      [{ text: "🔙", callback_data: "nodes" }],
    ]);
  }
}

async function doDeleteNode(chatId, nodeId, env, msgId) {
  await edit(chatId, msgId, "⏳ در حال حذف نود...", env);
  try {
    const node = await getManagedNode(env, nodeId);
    if (!node || !node.token_encrypted) {
      return edit(chatId, msgId, "❌ اطلاعات نود یا توکن پیدا نشد.", env, [[{ text: "🔙", callback_data: "nodes" }]]);
    }

    const token = node.token_encrypted;
    const accountId = node.account_id;
    const scriptName = node.script_name;

    await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}`, token, { method: "DELETE" });

    if (node.db_id) {
      try {
        await cfFetch(`/accounts/${accountId}/d1/database/${node.db_id}`, token, { method: "DELETE" });
      } catch {}
    }

    await removeChildByScriptName(env, scriptName);
    await removeManagedNode(env, nodeId);

    return edit(chatId, msgId, `✅ نود <code>${escape(scriptName)}</code> با موفقیت حذف شد.`, env, [
      [{ text: "📊 وضعیت نودها", callback_data: "nodes" }],
      [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
    ]);
  } catch (err) {
    return edit(chatId, msgId, `❌ خطا در حذف:\n<code>${escape(err.message)}</code>`, env, [
      [{ text: "🔙", callback_data: "nodes" }],
    ]);
  }
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  const isAdminUser = isAdmin(userId, env);

  if (msg.photo && msg.photo.length && !isAdminUser) {
    return handlePaymentScreenshot(msg, env);
  }

  if (isAdminUser) {
    const replyText = msg.reply_to_message?.text || "";


    if (msg.document && isAdminUser) {
      const state = await getUserState(env, userId);
      if (state?.step === "waiting_backup_import") {
        return handleBackupImport(msg, env);
      }
    }

    if (replyText.includes("حجم اکانت تست را به")) {
      const mb = parseInt(text, 10);
      if (!mb || mb < 1 || mb > 10240) return send(chatId, "❌ عدد بین ۱ تا ۱۰۲۴۰", env);
      await setShopSetting(env, "test_quota_mb", String(mb));
      await send(chatId, `✅ حجم تست: ${mb} MB`, env);
      return showShopAdmin(chatId, env);
    }
    if (replyText.includes("مدت اکانت تست را به")) {
      const days = parseInt(text, 10);
      if (!days || days < 1 || days > 365) return send(chatId, "❌ عدد بین ۱ تا ۳۶۵", env);
      await setShopSetting(env, "test_days", String(days));
      await send(chatId, `✅ مدت تست: ${days} روز`, env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("نام کاربر جدید را ارسال کنید")) {
      const name = text.slice(0, 32).trim();
      if (!name) return send(chatId, "❌ نام نمی‌تواند خالی باشد.", env);
      const id = generateId();
      const uuid = generateUuid();
      const ok = await upsertUser(env, {
        id,
        name,
        uuid,
        enabled: true,
        expiry: null,
        quotaBytes: 0,
        dailyQuotaBytes: 0,
        speedLimitKBps: 0,
        ipLimit: 1,
        cleanIp: "",
        blockAds: true,
        notes: "created via telegram bot",
      });
      if (!ok) return send(chatId, "❌ خطا در ساخت کاربر", env);
      triggerSync(env);
      await send(chatId, `✅ کاربر <b>${escape(name)}</b> ساخته شد\n🆔 <code>${id}</code>`, env);
      return showUser(chatId, id, env);
    }

    if (replyText.includes("تاریخ انقضا را ارسال کنید")) {
      const id = extractIdFromReply(replyText) || (replyText.match(/کاربر: (\S+)/) || [])[1];
      if (!id) return send(chatId, "❌ خطا در شناسایی کاربر", env);
      const raw = text.trim();
      const user = await getUserById(env, id);
      if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
      let expiry = null;
      if (raw === "0" || raw === "∞" || raw.toLowerCase() === "unlimited") {
        expiry = null;
      } else if (/^\d+$/.test(raw)) {
        const days = parseInt(raw, 10);
        if (days < 0 || days > 3650) return send(chatId, "❌ تعداد روز بین ۰ تا ۳۶۵۰", env);
        expiry = days === 0 ? null : new Date(Date.now() + days * 86400000).toISOString();
      } else if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const t = Date.parse(raw);
        if (!Number.isFinite(t)) return send(chatId, "❌ تاریخ نامعتبر است", env);
        expiry = new Date(t).toISOString();
      } else {
        return send(chatId, "❌ فرمت نامعتبر. مثال: <code>30</code> یا <code>2026-12-31</code>", env);
      }
      await upsertUser(env, { ...user, expiry });
      triggerSync(env);
      await send(chatId, "✅ تاریخ انقضا تنظیم شد", env);
      return showUser(chatId, id, env);
    }

    if (replyText.includes("یادداشت جدید را ارسال کنید")) {
      const id = extractIdFromReply(replyText);
      if (!id) return send(chatId, "❌ خطا در شناسایی کاربر", env);
      const user = await getUserById(env, id);
      if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
      await upsertUser(env, { ...user, notes: text.slice(0, 200) });
      await send(chatId, "✅ یادداشت بروزرسانی شد", env);
      return showUser(chatId, id, env);
    }

    if (replyText.includes("حجم کل را به گیگابایت ارسال کنید")) {
      const id = extractIdFromReply(replyText);
      const gb = parseFloat(text.replace(",", "."));
      if (isNaN(gb) || gb < 0) return send(chatId, "❌ عدد معتبر وارد کنید", env);
      const user = await getUserById(env, id);
      if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
      await upsertUser(env, { ...user, quotaBytes: gb === 0 ? 0 : Math.floor(gb * 1073741824) });
      triggerSync(env);
      await send(chatId, "✅ حجم کل تنظیم شد", env);
      return showUser(chatId, id, env);
    }

    if (replyText.includes("حجم روزانه را به گیگابایت ارسال کنید")) {
      const id = extractIdFromReply(replyText);
      const gb = parseFloat(text.replace(",", "."));
      if (isNaN(gb) || gb < 0) return send(chatId, "❌ عدد معتبر وارد کنید", env);
      const user = await getUserById(env, id);
      if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
      await upsertUser(env, { ...user, dailyQuotaBytes: gb === 0 ? 0 : Math.floor(gb * 1073741824) });
      triggerSync(env);
      await send(chatId, "✅ حجم روزانه تنظیم شد", env);
      return showUser(chatId, id, env);
    }

    if (replyText.includes("محدودیت IP را ارسال کنید")) {
      const id = extractIdFromReply(replyText);
      const limit = parseInt(text);
      if (isNaN(limit) || limit < 1 || limit > 100) return send(chatId, "❌ عدد بین ۱ تا ۱۰۰", env);
      const user = await getUserById(env, id);
      if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
      await upsertUser(env, { ...user, ipLimit: limit });
      triggerSync(env);
      await send(chatId, "✅ محدودیت IP تنظیم شد", env);
      return showUser(chatId, id, env);
    }

    if (replyText.includes("توکن API کلودفلر را ارسال کنید") || replyText.includes("توکن کلودفلر را ارسال کنید")) {
      const token = text.trim();
      if (!token || token.length < 30) return send(chatId, "❌ توکن نامعتبر است.", env);
      await send(chatId, "⏳ در حال ساخت نود... لطفاً صبر کنید.", env);
      return createCloudflareNode(chatId, token, env);
    }

    if (replyText.includes("نام نود و توکن را ارسال کنید")) {
      const parts = text.trim().split(/\s+/);
      if (parts.length < 2) {
        return send(chatId, "❌ فرمت نادرست.\nمثال:\n<code>wk-12345 YOUR_TOKEN</code>", env);
      }
      const scriptName = parts[0];
      const token = parts.slice(1).join(" ").trim();
      if (!token || token.length < 30) return send(chatId, "❌ توکن نامعتبر است.", env);
      await send(chatId, "⏳ در حال حذف نود...", env);
      return deleteCloudflareNode(chatId, scriptName, token, env);
    }

    if (replyText.includes("توکن را برای مشاهده وضعیت اکانت ارسال کنید")) {
      const token = text.trim();
      if (!token || token.length < 30) return send(chatId, "❌ توکن نامعتبر است.", env);
      await send(chatId, "⏳ در حال دریافت اطلاعات...", env);
      return showAccountStatus(chatId, token, env);
    }

    if (replyText.includes("شماره کارت و نام صاحب حساب را ارسال کنید")) {
      const parts = text.trim().split(/\s+/);
      if (parts.length < 2) {
        return send(chatId, "❌ فرمت: <code>شماره‌کارت نام صاحب</code>", env);
      }
      const cardNumber = parts[0].replace(/\D/g, "");
      const cardName = parts.slice(1).join(" ");
      if (cardNumber.length < 16) return send(chatId, "❌ شماره کارت نامعتبر است.", env);
      await setShopSetting(env, "card_number", cardNumber);
      await setShopSetting(env, "card_name", cardName);
      await send(chatId, `✅ کارت ذخیره شد.\n<code>${cardNumber}</code>\n${escape(cardName)}`, env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("آیدی یا لینک پشتیبانی را ارسال کنید")) {
      await setShopSetting(env, "support_id", text.slice(0, 120));
      await send(chatId, "✅ پشتیبانی ذخیره شد.", env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("آیدی کانال را ارسال کنید")) {
      await setShopSetting(env, "channel_id", text.trim());
      await send(chatId, "✅ آیدی کانال ذخیره شد. اگر لینک عضویت هم دارید ارسال کنید یا از منو لینک را جدا تنظیم کنید.", env);
      return showShopAdmin(chatId, env);
    }
    if (replyText.includes("لینک عضویت کانال را ارسال کنید")) {
      await setShopSetting(env, "channel_link", text.trim());
      await send(chatId, "✅ لینک کانال ذخیره شد.", env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("متن خوش‌آمدگویی را ارسال کنید")) {
      await setShopSetting(env, "welcome_text", text.slice(0, 1000));
      await send(chatId, "✅ متن خوش‌آمد ذخیره شد.", env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("متن آموزش استفاده را ارسال کنید")) {
      await setShopSetting(env, "guide_text", text.slice(0, 3000));
      await send(chatId, "✅ متن آموزش ذخیره شد.", env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("متن اسپانسر") || replyText.includes("متن اسپانسر / تبلیغ")) {
      const val = text.trim() === "-" ? "" : text.slice(0, 200);
      await setShopSetting(env, "sponsor_text", val);
      await send(chatId, val ? "✅ متن اسپانسر ذخیره شد." : "✅ متن اسپانسر پاک شد.", env);
      return showShopAdmin(chatId, env);
    }

    if (replyText.includes("اطلاعات پلن را ارسال کنید")) {
      const parts = text.split("|").map((x) => x.trim());
      if (parts.length < 5) {
        return send(
          chatId,
          "❌ فرمت:\n<code>نام|روز|حجم‌کل‌GB|حجم‌روزانه‌GB|قیمت|IP</code>\nمثال:\n<code>برنزی|30|50|0|150000|2</code>",
          env
        );
      }
      const [name, daysS, quotaS, dailyS, priceS, ipS] = parts;
      const plan = {
        id: "p" + Math.random().toString(36).slice(2, 9),
        name: name.slice(0, 40),
        days: parseInt(daysS, 10) || 30,
        quota_gb: parseFloat(quotaS) || 0,
        daily_gb: parseFloat(dailyS) || 0,
        price: parseInt(priceS, 10) || 0,
        ip_limit: parseInt(ipS, 10) || 1,
        enabled: 1,
        sort_order: 0,
      };
      await env.DB.prepare(`
        INSERT INTO shop_plans (id, name, days, quota_gb, daily_gb, price, ip_limit, enabled, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)
      `)
        .bind(plan.id, plan.name, plan.days, plan.quota_gb, plan.daily_gb, plan.price, plan.ip_limit)
        .run();
      await send(chatId, `✅ پلن <b>${escape(plan.name)}</b> ساخته شد.`, env);
      return showShopPlansAdmin(chatId, env);
    }

    if (text && !text.startsWith("/")) {
      const uuid = extractUuidFromText(text);
      if (uuid) {
        const user = await getUserByUuid(env, uuid);
        if (user) return showUser(chatId, user.id, env);
      }

      const found = await findUserByText(text, env);
      if (found) return showUser(chatId, found, env);

      const looksLikeVless = /^vless:\/\//i.test(text.trim());
      if (!looksLikeVless) {
        const node = await findManagedNodeByText(text, env);
        if (node) return showNodeDetail(chatId, node, env);
      }
    }

    if (text === "/start" || text === "/menu" || text === "منو") {
      return showMain(chatId, env);
    }
    if (text === "/node" || text === "/nodes") {
      return showNodesManage(chatId, env);
    }
    if (text === "/users") {
      return showUsers(chatId, 0, env);
    }
    if (text === "/status") {
      return showStatus(chatId, env);
    }

    return send(
      chatId,
      "از دکمه‌های شیشه‌ای استفاده کنید.\n" +
        "دستورات: /status · /users · /node\n" +
        "می‌توانید UUID، لینک کانفیگ، <b>نام نود</b> یا <b>آدرس نود</b> بفرستید.\n/start",
      env
    );
  }

  // کاربر عادی
  const cfg = await getShopConfig(env);

  if (!cfg.enabled) {
    return send(chatId, "⛔️ ربات فعلاً در دسترس نیست.", env);
  }

  if (!(await checkChannelMember(env, userId))) {
    return sendForceJoin(chatId, env);
  }

  const state = await getUserState(env, userId);
  if (state?.step === "waiting_receipt" || state?.step === "waiting_receipt_renew") {
    return send(
      chatId,
      "لطفاً <b>اسکرین‌شات رسید</b> را به‌صورت عکس بفرستید.\nانصراف: /start",
      env,
      [[{ text: "🏠 منو", callback_data: "user_home" }]]
    );
  }

  if (text === "/start" || text === "/menu" || text === "منو" || !text) {
    return showUserHome(chatId, env);
  }

  // لینک vless یا UUID → نمایش اطلاعات سرویس کاربر
  const uuidFromText = extractUuidFromText(text);
  if (uuidFromText) {
    const u = await getUserByUuid(env, uuidFromText);
    if (u) {
      const notes = String(u.notes || "");
      const name = String(u.name || "");
      const owns =
        name === `test-${userId}` ||
        name.startsWith(`shop-${userId}`) ||
        notes.includes(`tg:${userId}`);
      if (owns || isAdmin(userId, env)) {
        return showMyServiceDetail(chatId, userId, u.id, env);
      }
      // ادمین در شاخه بالا هندل شده؛ برای دیگران فقط سرویس خودشان
      return send(chatId, "این سرویس متعلق به شما نیست.", env, [
        [{ text: "🏠 منو", callback_data: "user_home" }],
      ]);
    }
  }

  return showUserHome(chatId, env);
}

function extractIdFromReply(replyText) {
  const match = replyText.match(/کاربر: (\S+)/);
  return match ? match[1] : null;
}

async function findUserByText(text, env) {
  let uuid = null;
  if (text.startsWith("vless://")) {
    const match = text.match(/vless:\/\/([0-9a-fA-F-]{36})@/);
    if (match) uuid = match[1];
  }
  if (!uuid) {
    const uuidMatch = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
    if (uuidMatch) uuid = uuidMatch[0];
  }
  if (uuid) {
    const user = await getUserByUuid(env, uuid);
    if (user) return user.id;
  }
  const user = await getUserById(env, text);
  if (user) return user.id;
  return null;
}

// ====================== Callback ======================
async function handleCallback(cq, env) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const data = cq.data;
  const userId = cq.from.id;
  const admin = isAdmin(userId, env);

  console.log("CALLBACK:", { data, userId, admin, ADMIN_IDS: env.ADMIN_IDS });

  // همیشه اول answer بزن
  await answer(cq.id, "", env);

  // ==================== Backup / Import / Update All ====================
  if (data === "backup_db") {
    try {
      await edit(chatId, msgId, "⏳ در حال ساخت بکاپ کامل...", env);
      const backup = await createFullBackup(env);
      const jsonStr = JSON.stringify(backup, null, 2);
      const fileName = `saow-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;

      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("document", new Blob([jsonStr], { type: "application/json" }), fileName);
      form.append("caption", `✅ بکاپ کامل\n📅 ${backup.created_at_tehran}\n📦 نسخه: ${VERSION}`);
      form.append("parse_mode", "HTML");

      const res = await fetch(`${TG}/bot${env.BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const dataRes = await res.json();
      if (!dataRes.ok) throw new Error(dataRes.description || "sendDocument failed");

      return edit(chatId, msgId, `✅ بکاپ ارسال شد.\nفایل: <code>${escape(fileName)}</code>`, env, [
        [{ text: "🔙 منو", callback_data: "main" }],
      ]);
    } catch (e) {
      return edit(chatId, msgId, `❌ خطا در بکاپ:\n<code>${escape(e.message)}</code>`, env, [
        [{ text: "🔙", callback_data: "main" }],
      ]);
    }
  }

  if (data === "import_backup") {
    await setUserState(env, userId, { step: "waiting_backup_import" });
    return edit(chatId, msgId, "📁 فایل بکاپ JSON را همین‌جا ارسال کنید.\n\nانصراف: /start", env, [
      [{ text: "❌ انصراف", callback_data: "main" }],
    ]);
  }

  if (data === "update_all_nodes") {
    return updateAllChildNodes(chatId, env, msgId);
  }

  // ==================== User-safe callbacks (حتی برای ادمین) ====================
  if (data === "user_home") return showUserHome(chatId, env, msgId);

  if (data === "user_buy") {
    if (!admin) {
      const cfg = await getShopConfig(env);
      if (!cfg.enabled) {
        return edit(chatId, msgId, "⛔️ فروش فعلاً تعطیل است.\n/start", env, [
          [{ text: "🏠 منو", callback_data: "user_home" }],
        ]);
      }
      if (!(await checkChannelMember(env, userId))) {
        return sendForceJoin(chatId, env, msgId);
      }
    }
    return showBuyPlans(chatId, env, msgId);
  }

  if (data.startsWith("user_plan:")) {
    return showPayInfo(chatId, userId, data.split(":")[1], env, msgId);
  }

  if (data === "user_test") return giveTestAccount(chatId, userId, env, msgId, cq.from);

  if (data === "user_guide") {
    const cfg = await getShopConfig(env);
    return edit(chatId, msgId, cfg.guideText || "—", env, [
      [{ text: "🔙 منو", callback_data: "user_home" }],
    ]);
  }

  if (data === "user_support") {
    const cfg = await getShopConfig(env);
    const t = cfg.supportId ? `💬 پشتیبانی:\n${cfg.supportId}` : "آیدی پشتیبانی تنظیم نشده.";
    return edit(chatId, msgId, t, env, [
      [{ text: "🔙 منو", callback_data: "user_home" }],
    ]);
  }

  if (data === "user_check_join") {
    if (await checkChannelMember(env, userId)) return showUserHome(chatId, env, msgId);
    return sendForceJoin(chatId, env, msgId);
  }

  if (data === "user_my_services") return showMyServices(chatId, userId, env, msgId);

  if (data.startsWith("mysvc:")) {
    return showMyServiceDetail(chatId, userId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("revoke_uuid:")) {
    return revokeUserUuid(chatId, userId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("renew_req:")) {
    return requestRenew(chatId, userId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("renew_plan:")) {
    const parts = data.split(":");
    return showRenewPayInfo(chatId, userId, parts[1], parts[2], env, msgId);
  }

  // ==================== از اینجا فقط ادمین ====================
  if (!admin) return;

  // ----- Orders -----
  if (data.startsWith("order_approve:")) {
    return approveOrder(chatId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("order_reject:")) {
    return rejectOrder(chatId, data.split(":")[1], env, msgId);
  }

  // ----- Shop -----
  if (data === "shop_admin") return showShopAdmin(chatId, env, msgId);

  if (data === "shop_toggle") {
    const cfg = await getShopConfig(env);
    await setShopSetting(env, "enabled", cfg.enabled ? "0" : "1");
    return showShopAdmin(chatId, env, msgId);
  }

  if (data === "shop_force_toggle") {
    const cfg = await getShopConfig(env);
    await setShopSetting(env, "force_join", cfg.forceJoin ? "0" : "1");
    return showShopAdmin(chatId, env, msgId);
  }

  if (data === "shop_set_card") {
    return send(
      chatId,
      `✏️ <b>شماره کارت و نام صاحب حساب را ارسال کنید</b>\n\nمثال:\n<code>6037997123456789 علی رضایی</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_admin" }]],
      true
    );
  }

  if (data === "shop_support") {
    return send(
      chatId,
      `✏️ <b>آیدی یا لینک پشتیبانی را ارسال کنید</b>\n\nمثال: <code>@support</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_admin" }]],
      true
    );
  }

  if (data === "shop_channel") {
    return send(
      chatId,
      `✏️ <b>آیدی کانال را ارسال کنید</b>\n\nمثال: <code>@mychannel</code> یا <code>-100123...</code>\n\nبعد از ذخیره، از منو «🔒 روشن قفل» را بزنید.\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_admin" }]],
      true
    );
  }

  if (data === "shop_channel_link") {
    return send(
      chatId,
      `✏️ <b>لینک عضویت کانال را ارسال کنید</b>\n\nمثال: <code>https://t.me/mychannel</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_admin" }]],
      true
    );
  }

  if (data === "shop_welcome") {
    return send(
      chatId,
      `✏️ <b>متن خوش‌آمدگویی را ارسال کنید</b>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_admin" }]],
      true
    );
  }

  if (data === "shop_guide") {
    return send(
      chatId,
      `✏️ <b>متن آموزش استفاده را ارسال کنید</b>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_admin" }]],
      true
    );
  }

  if (data === "shop_texts") {
    return edit(chatId, msgId, `📝 <b>متن‌های ربات</b>`, env, [
      [
        { text: "👋 خوش‌آمد", callback_data: "shop_welcome" },
        { text: "📖 آموزش", callback_data: "shop_guide" },
      ],
      [{ text: "📢 متن اسپانسر", callback_data: "shop_sponsor" }],
      [{ text: "🔙 تنظیمات فروش", callback_data: "shop_admin" }],
    ]);
  }

  if (data === "shop_sponsor") {
    return send(
      chatId,
      `✏️ <b>متن اسپانسر / تبلیغ را ارسال کنید</b>\n\n` +
        `این متن در بنر اتمام حجم/زمان و داخل کانفیگ‌های ساب نمایش داده می‌شود.\n` +
        `برای پاک کردن: <code>-</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_texts" }]],
      true
    );
  }

  if (data === "shop_test") {
    const cfg = await getShopConfig(env);
    const text =
      `🎁 <b>تنظیم اکانت تست</b>\n\n` +
      `وضعیت: ${cfg.testEnabled ? "🟢 فعال" : "🔴 غیرفعال"}\n` +
      `حجم: <b>${cfg.testQuotaMb}</b> MB\n` +
      `مدت: <b>${cfg.testDays}</b> روز`;
    return edit(chatId, msgId, text, env, [
      [
        {
          text: cfg.testEnabled ? "🔴 خاموش کردن" : "🟢 روشن کردن",
          callback_data: "shop_test_toggle",
        },
      ],
      [
        { text: "✏️ حجم (MB)", callback_data: "shop_test_quota" },
        { text: "✏️ روز", callback_data: "shop_test_days" },
      ],
      [{ text: "🔙 تنظیمات فروش", callback_data: "shop_admin" }],
    ]);
  }

  if (data === "shop_test_toggle") {
    const cfg = await getShopConfig(env);
    await setShopSetting(env, "test_enabled", cfg.testEnabled ? "0" : "1");
    const cfg2 = await getShopConfig(env);
    const text =
      `🎁 <b>تنظیم اکانت تست</b>\n\n` +
      `وضعیت: ${cfg2.testEnabled ? "🟢 فعال" : "🔴 غیرفعال"}\n` +
      `حجم: <b>${cfg2.testQuotaMb}</b> MB\n` +
      `مدت: <b>${cfg2.testDays}</b> روز`;
    return edit(chatId, msgId, text, env, [
      [
        {
          text: cfg2.testEnabled ? "🔴 خاموش کردن" : "🟢 روشن کردن",
          callback_data: "shop_test_toggle",
        },
      ],
      [
        { text: "✏️ حجم (MB)", callback_data: "shop_test_quota" },
        { text: "✏️ روز", callback_data: "shop_test_days" },
      ],
      [{ text: "🔙 تنظیمات فروش", callback_data: "shop_admin" }],
    ]);
  }

  if (data === "shop_test_quota") {
    return send(
      chatId,
      `✏️ حجم اکانت تست را به <b>مگابایت</b> بفرست\nمثال: <code>100</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_test" }]],
      true
    );
  }

  if (data === "shop_test_days") {
    return send(
      chatId,
      `✏️ مدت اکانت تست را به <b>روز</b> بفرست\nمثال: <code>1</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_test" }]],
      true
    );
  }

  if (data === "shop_plans") return showShopPlansAdmin(chatId, env, msgId);

  if (data === "shop_plan_add") {
    return send(
      chatId,
      `✏️ <b>اطلاعات پلن را ارسال کنید</b>\n\n` +
        `فرمت:\n<code>نام|روز|حجم‌کل‌GB|حجم‌روزانه‌GB|قیمت|IP</code>\n` +
        `مثال:\n<code>برنزی|30|50|0|150000|2</code>\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: "shop_plans" }]],
      true
    );
  }

  if (data.startsWith("shop_plan_del:")) {
    const pid = data.split(":")[1];
    try {
      await env.DB.prepare("DELETE FROM shop_plans WHERE id = ?").bind(pid).run();
    } catch {}
    return showShopPlansAdmin(chatId, env, msgId);
  }

  if (data.startsWith("shop_plan_toggle:")) {
    const pid = data.split(":")[1];
    try {
      const row = await env.DB.prepare("SELECT enabled FROM shop_plans WHERE id = ?").bind(pid).first();
      if (row) {
        await env.DB.prepare("UPDATE shop_plans SET enabled = ? WHERE id = ?")
          .bind(row.enabled ? 0 : 1, pid)
          .run();
      }
    } catch {}
    return showShopPlansAdmin(chatId, env, msgId);
  }

  if (data === "shop_orders") {
    try {
      await showPendingOrders(chatId, env, msgId);
    } catch {
      await showPendingOrders(chatId, env, null);
    }
    return;
  }

  // ----- Main / Status -----
  if (data === "main") return showMain(chatId, env, msgId);
  if (data === "status") return showStatus(chatId, env, msgId);

  // ----- Nodes -----
  if (data === "nodes_manage") {
    try {
      return await showNodesManage(chatId, env, msgId);
    } catch (e) {
      console.error("showNodesManage CRASH:", e?.message || e, e?.stack);
      return edit(chatId, msgId, `❌ خطا در مدیریت نودها:\n<code>${escape(String(e?.message || e))}</code>`, env, [
        [{ text: "🔙 منو", callback_data: "main" }],
      ]);
    }
  }

  if (data === "nodes") {
    try {
      return await showNodes(chatId, env, msgId);
    } catch (e) {
      console.error("showNodes CRASH:", e?.message || e);
      return edit(chatId, msgId, `❌ خطا:\n<code>${escape(String(e?.message || e))}</code>`, env, [
        [{ text: "🔙", callback_data: "nodes_manage" }],
      ]);
    }
  }

  if (data === "node_create") return showNodeCreate(chatId, env, msgId);

  if (data.startsWith("node_detail:")) {
    const nodeId = data.slice("node_detail:".length);
    const node = await getManagedNode(env, nodeId);
    return showNodeDetail(chatId, node, env, msgId);
  }

  if (data.startsWith("toggle_node:")) {
    return toggleNodeStatus(chatId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("toggle_sub:")) {
    return toggleNodeExcludeSub(chatId, data.split(":")[1], env, msgId);
  }

  if (data === "node_create_token") {
    return send(
      chatId,
      `🔑 <b>ساخت نود جدید</b>\n\n` +
        `۱. روی دکمه زیر کلیک کنید و توکن بسازید.\n` +
        `۲. توکن را کپی کرده و اینجا ارسال کنید.\n\n` +
        `⚠️ <b>توجه:</b> نود بچه نمی‌تواند روی همان اکانت نود مادر ساخته شود.\n\n` +
        `✏️ <b>توکن API کلودفلر را ارسال کنید:</b>\n\nبرای بازگشت /start`,
      env,
      [
        [{ text: "🔗 ساخت توکن کلودفلر", url: CF_TOKEN_URL }],
        [{ text: "❌ انصراف", callback_data: "nodes_manage" }],
      ],
      true
    );
  }

  if (data.startsWith("del_node:")) {
    return confirmDeleteNode(chatId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("del_node_confirm:")) {
    return doDeleteNode(chatId, data.split(":")[1], env, msgId);
  }

  if (data === "update_mother") return doUpdateMother(chatId, env, msgId);
  if (data === "mother_account_status") return showMotherAccountStatus(chatId, env, msgId);

  if (data.startsWith("node_acc:")) {
    return showNodeAccountStatus(chatId, data.split(":")[1], env, msgId);
  }

  if (data.startsWith("update_child:")) {
    return updateChildNode(chatId, data.split(":")[1], env, msgId);
  }

  // ----- Users -----
  if (data.startsWith("users:")) {
    const page = parseInt(data.split(":")[1]) || 0;
    return showUsers(chatId, page, env, msgId);
  }

  if (data.startsWith("expirymenu:")) return expiryMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("expiry:")) {
    const parts = data.split(":");
    return setExpiry(chatId, parts[1], parseInt(parts[2], 10), env, msgId);
  }
  if (data.startsWith("expirymanual:")) {
    const id = data.split(":")[1];
    return send(
      chatId,
      `✏️ <b>تاریخ انقضا را ارسال کنید</b>\n\n` +
        `کاربر: ${id}\n\n` +
        `فرمت‌های مجاز:\n` +
        `• تعداد روز: <code>30</code>\n` +
        `• تاریخ: <code>2026-12-31</code>\n` +
        `• یا <code>0</code> برای نامحدود\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: `user:${id}` }]],
      true
    );
  }

  if (data.startsWith("user:")) return showUser(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("toggle:")) return doToggle(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("reset:")) return doReset(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("clearips:")) return doClearIPs(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("sub:")) return showSub(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("qr:")) return sendQR(chatId, data.split(":")[1], env);
  if (data.startsWith("delc:")) return confirmDelete(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("del:")) return doDelete(chatId, data.split(":")[1], env, msgId);

  if (data === "create") {
    return send(
      chatId,
      "✏️ <b>نام کاربر جدید را ارسال کنید:</b>\n\n(حداکثر ۳۲ کاراکتر)\n\nبرای بازگشت /start",
      env,
      [[{ text: "❌ انصراف", callback_data: "main" }]],
      true
    );
  }

  if (data.startsWith("notes:")) {
    const id = data.split(":")[1];
    return send(
      chatId,
      `✏️ <b>یادداشت جدید را ارسال کنید</b>\n\nکاربر: ${id}\n\n(حداکثر ۲۰۰ کاراکتر)\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: `user:${id}` }]],
      true
    );
  }

  if (data.startsWith("iplimit:")) {
    const [, id, val] = data.split(":");
    return setField(chatId, id, { ipLimit: parseInt(val) }, env, msgId);
  }
  if (data.startsWith("ipmenu:")) return ipLimitMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("ipmanual:")) {
    const id = data.split(":")[1];
    return send(
      chatId,
      `✏️ <b>محدودیت IP را ارسال کنید</b>\n\nکاربر: ${id}\n\nعدد بین ۱ تا ۱۰۰\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: `user:${id}` }]],
      true
    );
  }

  if (data.startsWith("speed:")) {
    const [, id, val] = data.split(":");
    return setField(chatId, id, { speedLimitKBps: parseInt(val) }, env, msgId);
  }
  if (data.startsWith("speedmenu:")) return speedMenu(chatId, data.split(":")[1], env, msgId);

  if (data.startsWith("quota:")) {
    const [, id, val] = data.split(":");
    return setField(chatId, id, { quotaBytes: parseInt(val) }, env, msgId);
  }
  if (data.startsWith("quotamenu:")) return quotaMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("quotamanual:")) {
    const id = data.split(":")[1];
    return send(
      chatId,
      `✏️ <b>حجم کل را به گیگابایت ارسال کنید</b>\n\nکاربر: ${id}\n\nمثال: 10 یا 0 برای نامحدود\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: `user:${id}` }]],
      true
    );
  }

  if (data.startsWith("daily:")) {
    const [, id, val] = data.split(":");
    return setField(chatId, id, { dailyQuotaBytes: parseInt(val) }, env, msgId);
  }
  if (data.startsWith("dailymenu:")) return dailyMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("dailymanual:")) {
    const id = data.split(":")[1];
    return send(
      chatId,
      `✏️ <b>حجم روزانه را به گیگابایت ارسال کنید</b>\n\nکاربر: ${id}\n\nمثال: 2 یا 0 برای نامحدود\n\nبرای بازگشت /start`,
      env,
      [[{ text: "❌ انصراف", callback_data: `user:${id}` }]],
      true
    );
  }

  if (data.startsWith("ads:")) return toggleAds(chatId, data.split(":")[1], env, msgId);

  if (data.startsWith("forcenode:")) {
    return forceNodeMenu(chatId, data.split(":")[1], env, msgId);
  }
  if (data.startsWith("setforce:")) {
    const parts = data.split(":");
    const uid = parts[1];
    const nodeKey = parts.slice(2).join(":") || "";
    return setForcedNode(chatId, uid, nodeKey, env, msgId);
  }

  // ----- Legacy renew_do -----
  if (data.startsWith("renew_do:")) {
    const parts = data.split(":");
    const pid = parts[1];
    const days = parseInt(parts[2], 10) || 30;
    const user = await getUserById(env, pid);
    if (!user) {
      return edit(chatId, msgId, "کاربر پیدا نشد.", env, [
        [{ text: "🔙", callback_data: "main" }],
      ]);
    }
    const base =
      user.expiry && Date.parse(user.expiry) > Date.now()
        ? Date.parse(user.expiry)
        : Date.now();
    const expiry = new Date(base + days * 86400000).toISOString();
    await upsertUser(env, { ...user, expiry, enabled: true });
    triggerSync(env);
    await edit(
      chatId,
      msgId,
      `✅ ${days} روز به <code>${pid}</code> اضافه شد.\n📅 تا: ${new Date(expiry).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
      env,
      [[{ text: "🔙 منو", callback_data: "main" }]]
    );
    const m = String(user.notes || "").match(/tg:(\d+)/);
    if (m) {
      await send(
        m[1],
        `✅ سرویس شما ${days} روز تمدید شد.\n📅 تا: ${new Date(expiry).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`,
        env,
        [[{ text: "📦 سرویس‌های من", callback_data: "user_my_services" }]]
      );
    }
    return;
  }
}

// ====================== UI ======================
async function showMain(chatId, env, msgId = null) {
  const motherToken = env.CF_TOKEN;
  const motherAccountId = env.MOTHER_ACCOUNT_ID;

  const [statusData, nodes, motherReqs] = await Promise.all([
    getStatusData(env),
    getHealthyChildren(env),
    motherToken && motherAccountId
      ? getAccountRequestsToday(motherToken, motherAccountId)
      : Promise.resolve(null),
  ]);

  const alive = nodes.length;
  const reqsText =
    motherReqs != null
      ? Number(motherReqs).toLocaleString("fa-IR")
      : "—";

  const text =
    `🎛️ <b>پنل مدیریت Mother (Push Mode)</b>\n\n` +
    `🤖 نسخه ربات: <code>${BOT_VERSION}</code>\n` +
    `🖥 نسخه پنل: <code>${VERSION}</code>\n` +
    `🖥 نودها: 🟢 ${alive} فعال\n` +
    `📈 درخواست امروز مادر: <b>${reqsText}(۱۰۰٬۰۰۰)</b>\n\n` +
    `از دکمه‌های شیشه‌ای استفاده کنید.\nمی‌توانید UUID یا لینک vless ارسال کنید.`;

  const kb = [
    [
      { text: "📊 وضعیت سیستم", callback_data: "status" },
      { text: "👥 کاربران", callback_data: "users:0" },
    ],
    [
      { text: "➕ ساخت کاربر جدید", callback_data: "create" },
      { text: "🖥 مدیریت نودها", callback_data: "nodes_manage" },
    ],
    [
      { text: "💾 بکاپ دیتابیس", callback_data: "backup_db" },
      { text: "📥 ایمپورت بکاپ", callback_data: "import_backup" },
    ],
    [
      { text: "♻️ آپدیت همه نودها", callback_data: "update_all_nodes" },
    ],
    [{ text: "🛍 تنظیمات فروش", callback_data: "shop_admin" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showStatus(chatId, env, msgId = null) {
  const res = await getStatusData(env);
  const realOnline = (res.live || []).filter((u) => u.activeIPs > 0);
  let liveText = "";
  if (realOnline.length) {
    liveText = "\n\n🟢 <b>کاربران واقعاً آنلاین:</b>\n";
    for (const u of realOnline) {
      liveText += `• <b>${escape(u.name)}</b> — ${u.activeIPs} IP | ${u.usageGB} GB\n`;
    }
  } else {
    liveText = "\n\n🟢 هیچ کاربر آنلاینی وجود ندارد.";
  }

  // درخواست‌های امروز مادر + نودها
  let motherReqs = null;
  try {
    if (env.CF_TOKEN && env.MOTHER_ACCOUNT_ID) {
      motherReqs = await getAccountRequestsToday(env.CF_TOKEN, env.MOTHER_ACCOUNT_ID);
    }
  } catch {}

  const managed = await getManagedNodes(env);
  const alive = await getHealthyChildren(env);
  let nodesReqSum = 0;
  let nodesReqKnown = 0;
  let nodesSummary = "";
  if (managed.length) {
    const lines = [];
    await Promise.all(
      managed.map(async (m) => {
        let reqs = null;
        try {
          const token = await resolveNodeToken(env, m);
          if (token && m.account_id) {
            const r = await getAccountRequestsToday(token, m.account_id);
            if (typeof r === "number") {
              reqs = r;
              nodesReqSum += r;
              nodesReqKnown++;
            }
          }
        } catch {}
        const live = alive.find(
          (a) =>
            a.id.includes(m.script_name) ||
            (m.url && a.url && String(a.url).includes(m.script_name))
        );
        const st =
          m.is_disabled === 1
            ? "🔒"
            : live
              ? "🟢"
              : "🔴";
        const users = live?.activeUsers != null ? faNum(live.activeUsers) : "—";
        const reqTxt = reqs != null ? formatReqShort(reqs) : "—";
        const sub = m.exclude_sub === 1 ? " 🚫ساب" : "";
        lines.push(
          `${st} <code>${escape(m.script_name)}</code> · 👥${users} · 📈${reqTxt}${sub}`
        );
      })
    );
    nodesSummary =
      "\n\n🖥 <b>خلاصه نودها:</b>\n" + lines.join("\n");
  }

  const motherTxt =
    motherReqs != null ? Number(motherReqs).toLocaleString("fa-IR") : "—";
  const nodesReqTxt =
    nodesReqKnown > 0 ? Number(nodesReqSum).toLocaleString("fa-IR") : "—";
  const totalReq =
    (typeof motherReqs === "number" ? motherReqs : 0) +
    (nodesReqKnown > 0 ? nodesReqSum : 0);
  const totalReqTxt =
    motherReqs != null || nodesReqKnown > 0
      ? Number(totalReq).toLocaleString("fa-IR")
      : "—";

  const text =
    `📊 <b>وضعیت سیستم</b>\n\n` +
    `🔖 نسخه: <code>${VERSION}</code>\n\n` +
    `👥 <b>کل کاربران:</b> ${res.users}\n` +
    `✅ <b>فعال:</b> ${res.activeUsers}\n` +
    `🟢 <b>آنلاین:</b> ${res.onlineUsers}\n` +
    `🖥 <b>نودها:</b> ${res.nodes}\n` +
    `📈 <b>ترافیک کل:</b> ${res.totalTrafficGB} GB\n\n` +
    `📡 <b>درخواست امروز:</b>\n` +
    `• مادر: <b>${motherTxt}</b>\n` +
    `• نودها: <b>${nodesReqTxt}</b>\n` +
    `• مجموع: <b>${totalReqTxt}</b>` +
    nodesSummary +
    liveText;
  const kb = [
    [
      { text: "🔄 بروزرسانی", callback_data: "status" },
      { text: "🔙 بازگشت", callback_data: "main" },
    ],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showUsers(chatId, page, env, msgId = null) {
  const users = await getUsers(env);
  const full = await Promise.all(users.map((u) => buildFullUser(env, u)));
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(full.length / perPage));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = full.slice(page * perPage, (page + 1) * perPage);

  let text = `👥 <b>لیست کاربران</b> (${full.length} نفر)\nصفحه ${page + 1} از ${totalPages}\n\n🟢 فعال 🟡 محدودیت حجم 🔴 غیرفعال\n\n`;
  const kb = [];
  for (let i = 0; i < slice.length; i += 2) {
    const row = [];
    const u1 = slice[i];
    const num1 = page * perPage + i + 1;
    const emoji1 = u1.status === "active" ? "🟢" : u1.status === "disabled" ? "🔴" : "🟡";
    row.push({ text: `${num1}. ${emoji1} ${u1.name}`, callback_data: `user:${u1.id}` });
    if (slice[i + 1]) {
      const u2 = slice[i + 1];
      const num2 = page * perPage + i + 2;
      const emoji2 = u2.status === "active" ? "🟢" : u2.status === "disabled" ? "🔴" : "🟡";
      row.push({ text: `${num2}. ${emoji2} ${u2.name}`, callback_data: `user:${u2.id}` });
    }
    kb.push(row);
  }
  const nav = [];
  if (page > 0) nav.push({ text: "◀️ قبلی", callback_data: `users:${page - 1}` });
  nav.push({ text: `${page + 1}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages - 1) nav.push({ text: "بعدی ▶️", callback_data: `users:${page + 1}` });
  if (nav.length) kb.push(nav);
  kb.push([
    { text: "🔄 بروزرسانی", callback_data: `users:${page}` },
    { text: "🔙 منو اصلی", callback_data: "main" },
  ]);
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showUser(chatId, id, env, msgId = null) {
  const user = await getUserById(env, id);
  if (!user) {
    return msgId
      ? edit(chatId, msgId, "❌ کاربر پیدا نشد", env, [[{ text: "🔙", callback_data: "users:0" }]])
      : send(chatId, "❌ کاربر پیدا نشد", env);
  }
  const u = await buildFullUser(env, user);
  const emoji = u.status === "active" ? "🟢" : u.status === "disabled" ? "🔴" : "🟡";
  const quota = u.quotaBytes === 0 ? "∞" : (u.quotaBytes / 1073741824).toFixed(2) + " GB";
  const daily = u.dailyQuotaBytes === 0 ? "∞" : (u.dailyQuotaBytes / 1073741824).toFixed(2) + " GB";
  const speed = u.speedLimitKBps === 0 ? "∞" : u.speedLimitKBps + " KB/s";
  const expiryText = u.expiry
    ? new Date(u.expiry).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
    : "∞ نامحدود";
  let devices = "";
  if (u.activeDevices?.length) {
    devices = "\n\n📱 <b>IPهای فعال:</b>\n";
    for (const d of u.activeDevices) {
      devices += `• <code>${d.ip}</code> (${d.ageSec} ثانیه پیش)\n`;
    }
  } else {
    devices = "\n\n📱 هیچ IP فعالی وجود ندارد.";
  }
  const forcedLabel = u.forcedNode
    ? `🔒 قفل روی نود: <code>${escape(u.forcedNode)}</code>`
    : "🔓 نود آزاد (لود بالانس)";
  const text =
    `${emoji} <b>${escape(u.name)}</b>\n` +
    `🆔 <code>${u.id}</code>\n` +
    `🔑 <code>${u.uuid}</code>\n\n` +
    `📊 وضعیت: <b>${u.status}</b>\n` +
    `📈 مصرف: <b>${u.usage?.totalGB || 0} GB</b> (روزانه ${u.usage?.dailyGB || 0})\n` +
    `📦 حجم کل: ${quota}\n` +
    `📅 حجم روزانه: ${daily}\n` +
    `📅 انقضا: <b>${expiryText}</b>\n` +
    `⚡ سرعت: ${speed}\n` +
    `🌐 IP همزمان: <b>${u.activeIPs}/${u.ipLimit}</b>\n` +
    `🖥 ${forcedLabel}\n` +
    `🛡 بلاک تبلیغات: ${u.blockAds ? "✅" : "❌"}\n` +
    `📝 ${escape(u.notes || "-")}` +
    devices;
  const kb = [
    [
      { text: u.enabled ? "🔴 غیرفعال" : "🟢 فعال", callback_data: `toggle:${u.id}` },
      { text: "🔄 رفرش", callback_data: `user:${u.id}` },
    ],
    [{ text: "⏰ تاریخ انقضا", callback_data: `expirymenu:${u.id}` }],
    [
      { text: "🌐 محدودیت IP", callback_data: `ipmenu:${u.id}` },
      { text: "⚡ سرعت", callback_data: `speedmenu:${u.id}` },
    ],
    [
      { text: "📦 حجم کل", callback_data: `quotamenu:${u.id}` },
      { text: "📅 حجم روزانه", callback_data: `dailymenu:${u.id}` },
    ],
    [{ text: "🖥 قفل روی نود", callback_data: `forcenode:${u.id}` }],
    [
      { text: u.blockAds ? "🛡 تبلیغات: روشن" : "🛡 تبلیغات: خاموش", callback_data: `ads:${u.id}` },
      { text: "📝 یادداشت", callback_data: `notes:${u.id}` },
    ],
    [
      { text: "🔄 ریست حجم", callback_data: `reset:${u.id}` },
      { text: "🧹 پاک کردن IP", callback_data: `clearips:${u.id}` },
    ],
    [
      { text: "🔗 لینک ساب", callback_data: `sub:${u.id}` },
      { text: "🗑 حذف", callback_data: `delc:${u.id}` },
    ],
    [{ text: "🔙 لیست کاربران", callback_data: "users:0" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function forceNodeMenu(chatId, userId, env, msgId) {
  const user = await getUserById(env, userId);
  if (!user) {
    return edit(chatId, msgId, "❌ کاربر پیدا نشد", env, [[{ text: "🔙", callback_data: "users:0" }]]);
  }
  const managed = await getManagedNodes(env);
  let text =
    `🖥 <b>قفل کاربر روی نود</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `کاربر: <b>${escape(user.name)}</b>\n` +
    `فعلی: ${user.forcedNode ? `<code>${escape(user.forcedNode)}</code>` : "آزاد (لود بالانس)"}\n\n` +
    `با انتخاب نود، لینک ساب فقط به همان نود اشاره می‌کند.`;
  const kb = [[{ text: "🔓 آزاد (لود بالانس)", callback_data: `setforce:${userId}:` }]];
  for (const m of managed) {
    if (m.is_disabled === 1) continue;
    const mark = user.forcedNode === m.script_name || user.forcedNode === m.id ? "✅ " : "";
    const sub = m.exclude_sub === 1 ? " 🚫ساب" : "";
    kb.push([
      {
        text: `${mark}${shortChildId(m.script_name)} · ${m.script_name}${sub}`.slice(0, 60),
        callback_data: `setforce:${userId}:${m.script_name}`,
      },
    ]);
  }
  kb.push([{ text: "🔙 جزئیات کاربر", callback_data: `user:${userId}` }]);
  return edit(chatId, msgId, text, env, kb);
}

async function setForcedNode(chatId, userId, nodeKey, env, msgId) {
  const user = await getUserById(env, userId);
  if (!user) {
    return edit(chatId, msgId, "❌ کاربر پیدا نشد", env, [[{ text: "🔙", callback_data: "users:0" }]]);
  }
  const forcedNode = nodeKey && nodeKey.length ? nodeKey : "";
  await upsertUser(env, { ...user, forcedNode });
  triggerSync(env);
  return showUser(chatId, userId, env, msgId);
}

async function ipLimitMenu(chatId, id, env, msgId) {
  const text = `🌐 <b>محدودیت IP همزمان</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [
      { text: "۱", callback_data: `iplimit:${id}:1` },
      { text: "۲", callback_data: `iplimit:${id}:2` },
      { text: "۳", callback_data: `iplimit:${id}:3` },
    ],
    [
      { text: "۵", callback_data: `iplimit:${id}:5` },
      { text: "۱۰", callback_data: `iplimit:${id}:10` },
      { text: "۲۰", callback_data: `iplimit:${id}:20` },
    ],
    [{ text: "✏️ ورود دستی", callback_data: `ipmanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function speedMenu(chatId, id, env, msgId) {
  const text = `⚡ <b>محدودیت سرعت</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [
      { text: "∞ نامحدود", callback_data: `speed:${id}:0` },
      { text: "۱۰۰", callback_data: `speed:${id}:100` },
    ],
    [
      { text: "۲۰۰", callback_data: `speed:${id}:200` },
      { text: "۵۰۰", callback_data: `speed:${id}:500` },
    ],
    [
      { text: "۱ MB", callback_data: `speed:${id}:1024` },
      { text: "۲ MB", callback_data: `speed:${id}:2048` },
    ],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function quotaMenu(chatId, id, env, msgId) {
  const text = `📦 <b>حجم کل</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [
      { text: "∞ نامحدود", callback_data: `quota:${id}:0` },
      { text: "۱ GB", callback_data: `quota:${id}:1073741824` },
    ],
    [
      { text: "۵ GB", callback_data: `quota:${id}:5368709120` },
      { text: "۱۰ GB", callback_data: `quota:${id}:10737418240` },
    ],
    [
      { text: "۲۰ GB", callback_data: `quota:${id}:21474836480` },
      { text: "۵۰ GB", callback_data: `quota:${id}:53687091200` },
    ],
    [{ text: "✏️ ورود دستی (گیگابایت)", callback_data: `quotamanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function dailyMenu(chatId, id, env, msgId) {
  const text = `📅 <b>حجم روزانه</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [
      { text: "∞ نامحدود", callback_data: `daily:${id}:0` },
      { text: "۵۰۰ MB", callback_data: `daily:${id}:524288000` },
    ],
    [
      { text: "۱ GB", callback_data: `daily:${id}:1073741824` },
      { text: "۲ GB", callback_data: `daily:${id}:2147483648` },
    ],
    [
      { text: "۵ GB", callback_data: `daily:${id}:5368709120` },
      { text: "۱۰ GB", callback_data: `daily:${id}:10737418240` },
    ],
    [{ text: "✏️ ورود دستی (گیگابایت)", callback_data: `dailymanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}

async function setField(chatId, id, fields, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);
  await upsertUser(env, { ...user, ...fields });
  triggerSync(env);
  return showUser(chatId, id, env, msgId);
}
async function doToggle(chatId, id, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);
  await upsertUser(env, { ...user, enabled: !user.enabled });
  triggerSync(env);
  return showUser(chatId, id, env, msgId);
}
async function toggleAds(chatId, id, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);
  return setField(chatId, id, { blockAds: !user.blockAds }, env, msgId);
}
async function doReset(chatId, id, env, msgId) {
  const ok = await resetUsage(env, id);
  const text = ok ? "✅ حجم مصرف صفر شد" : "❌ خطا در ریست";
  triggerSync(env);
  return edit(chatId, msgId, text, env, [[{ text: "🔙 جزئیات", callback_data: `user:${id}` }]]);
}
async function doClearIPs(chatId, id, env, msgId) {
  const ok = await clearActiveIps(env, id);
  const text = ok ? "✅ IPهای فعال پاک شدند" : "❌ خطا";
  return edit(chatId, msgId, text, env, [[{ text: "🔙 جزئیات", callback_data: `user:${id}` }]]);
}
async function showSub(chatId, id, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);
  const url = `${env._SELF_URL || env.MOTHER_URL}/pull?token=${user.uuid}`;
  const text = `🔗 <b>لینک سابسکریپشن</b>\n\nکاربر: <b>${escape(user.name)}</b>\n\n<code>${url}</code>`;
  const kb = [
    [
      { text: "📱 دریافت QR Code", callback_data: `qr:${id}` },
      { text: "🔙 جزئیات", callback_data: `user:${id}` },
    ],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function sendQR(chatId, id, env) {
  const user = await getUserById(env, id);
  if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
  const url = `${env._SELF_URL || env.MOTHER_URL}/pull?token=${user.uuid}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
  await fetch(`${TG}/bot${env.BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: qrUrl,
      caption: `📱 QR Code\nکاربر: <b>${escape(user.name)}</b>\n\n<code>${url}</code>`,
      parse_mode: "HTML",
    }),
  });
}
async function confirmDelete(chatId, id, env, msgId) {
  const text = `⚠️ آیا از حذف کاربر <code>${id}</code> مطمئن هستید؟\n\nاین عمل غیرقابل بازگشت است.`;
  const kb = [
    [
      { text: "✅ بله، حذف شود", callback_data: `del:${id}` },
      { text: "❌ انصراف", callback_data: `user:${id}` },
    ],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function doDelete(chatId, id, env, msgId) {
  const ok = await deleteUser(env, id);
  triggerSync(env);
  const text = ok ? `✅ کاربر <code>${id}</code> حذف شد` : "❌ خطا در حذف";
  return edit(chatId, msgId, text, env, [[{ text: "🔙 لیست کاربران", callback_data: "users:0" }]]);
}

// ====================== Nodes UI ======================
async function showNodesManage(chatId, env, msgId = null) {
  try {
    const [alive, managed] = await Promise.all([
      getHealthyChildren(env),
      getManagedNodes(env),
    ]);

    const text =
      `🖥 <b>مدیریت نودها (Push Mode)</b>\n\n` +
      `🟢 آنلاین: <b>${alive.length}</b>\n` +
      `📦 ثبت‌شده: <b>${managed.length}</b>\n\n` +
      `از این بخش نودها را مدیریت کنید.\n` +
      `همگام‌سازی هر دقیقه توسط مادر انجام می‌شود.`;

    const kb = [
      [{ text: "📊 وضعیت / حذف / آپدیت نودها", callback_data: "nodes" }],
      [{ text: "➕ ساخت نود جدید", callback_data: "node_create" }],
      [{ text: "🔄 آپدیت نود مادر", callback_data: "update_mother" }],
      [{ text: "📈 وضعیت اکانت مادر", callback_data: "mother_account_status" }],
      [{ text: "🔙 بازگشت", callback_data: "main" }],
    ];

    return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
  } catch (e) {
    console.error("showNodesManage error:", e);
    const errText = `❌ خطا در بارگذاری مدیریت نودها:\n<code>${escape(e.message)}</code>`;
    return msgId
      ? edit(chatId, msgId, errText, env, [[{ text: "🔙 منو", callback_data: "main" }]])
      : send(chatId, errText, env);
  }
}

async function showNodeCreate(chatId, env, msgId = null) {
  const text =
    `➕ <b>ساخت نود جدید</b>\n\n` +
    `۱. با دکمه زیر توکن کلودفلر بساز\n` +
    `۲. بعد روی «ارسال توکن» بزن و توکن را بفرست\n\n` +
    `⚠️ نود بچه روی اکانت مادر ساخته نمی‌شود.\n` +
    `نود باید endpoint /sync را پشتیبانی کند (معماری Push).`;

  const kb = [
    [{ text: "🔗 ساخت توکن کلودفلر", url: CF_TOKEN_URL }],
    [{ text: "📤 ارسال توکن", callback_data: "node_create_token" }],
    [{ text: "🔙 بازگشت", callback_data: "nodes_manage" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function probeNodeHealth(url) {
  if (!url) return { ok: false, statusCode: 0, error: "no url" };
  try {
    const u = new URL(url);
    u.pathname = "/health";
    u.search = "";
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: { "User-Agent": "saow-mother/probe" },
      signal: AbortSignal.timeout(6000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {}
    if (!res.ok) {
      return { ok: false, statusCode: res.status, error: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      statusCode: res.status,
      version: body?.version,
      activeUsers: body?.activeUsers ?? body?.active_users,
      capacity: body?.capacity,
      id: body?.id,
      lastSeen: Date.now(),
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: 0,
      error: (e?.message || "network error").slice(0, 120),
    };
  }
}

/**
 * ایمیل + تعداد درخواست امروز اکانت CF مربوط به نود
 * از token ذخیره‌شده در managed_nodes / cf_accounts استفاده می‌کند
 */
/**
 * ایمیل + تعداد درخواست امروز اکانت CF مربوط به نود
 * + اطلاعات دیباگ برای نمایش خطا
 */
async function getNodeAccountInfo(env, node) {
  const result = {
    email: null,
    requestsToday: null,
    token: null,
    error: null,
  };

  try {
    const token = await resolveNodeToken(env, node);
    if (!token) {
      result.error = "توکن پیدا نشد";
      return result;
    }
    result.token = token;

    // ---------- ایمیل ----------
    try {
      // ۱. اول از دیتابیس محلی
      if (node.account_id) {
        const row = await env.DB.prepare(
          "SELECT email FROM cf_accounts WHERE account_id = ?"
        )
          .bind(node.account_id)
          .first();
        if (row?.email) result.email = row.email;
      }

      // ۲. اگر نبود، از /user (بعضی توکن‌ها دسترسی دارن)
      if (!result.email) {
        try {
          const u = await cfFetch("/user", token);
          if (u?.success && u.result?.email) {
            result.email = u.result.email;
          }
        } catch {}
      }

      // ۳. روش اصلی که با این توکن کار می‌کنه: اعضای اکانت
      if (!result.email && node.account_id) {
        try {
          const membersRes = await cfFetch(
            `/accounts/${node.account_id}/members?per_page=5`,
            token
          );
          if (membersRes?.success && Array.isArray(membersRes.result) && membersRes.result.length) {
            // معمولاً اولین عضو، صاحب اکانت است
            const member = membersRes.result[0];
            result.email =
              member.email ||
              member.user?.email ||
              null;
          }
        } catch (e) {
          result.error = (result.error ? result.error + " | " : "") + "members: " + (e?.message || "خطا");
        }
      }

      // ذخیره در دیتابیس برای دفعات بعد
      if (result.email && node.account_id) {
        try {
          await saveCfAccount(env, {
            account_id: node.account_id,
            token,
            email: result.email,
            name: "",
          });
        } catch {}
      }
    } catch (e) {
      result.error = (result.error ? result.error + " | " : "") + "ایمیل: " + (e?.message || "خطا");
    }

    // ---------- درخواست امروز ----------
    try {
      if (node.account_id) {
        const reqs = await getAccountRequestsToday(token, node.account_id);
        result.requestsToday = reqs;
      } else {
        result.error = (result.error ? result.error + " | " : "") + "account_id موجود نیست";
      }
    } catch (e) {
      result.error = (result.error ? result.error + " | " : "") + "Analytics: " + (e?.message || "خطا");
    }
  } catch (e) {
    result.error = e?.message || "خطای ناشناخته در دریافت اطلاعات اکانت";
  }

  return result;
}

async function resolveNodeToken(env, node) {
  // اگر توکن روی خود نود است
  if (node.token_encrypted) {
    // اگر رمزنگاری واقعی داری اینجا decrypt کن؛ فعلاً فرض plaintext/stored
    return node.token_encrypted;
  }
  // از cf_accounts
  if (node.account_id) {
    try {
      const row = await env.DB.prepare(
        "SELECT token FROM cf_accounts WHERE account_id = ?"
      )
        .bind(node.account_id)
        .first();
      if (row?.token) return row.token;
    } catch {}
  }
  return null;
}

/** تعداد درخواست‌های امروز اکانت (GraphQL Analytics) */
async function getAccountRequestsToday(token, accountId) {
  if (!token || !accountId) return null;

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();

  const query = `
    query {
      viewer {
        accounts(filter: { accountTag: "${accountId}" }) {
          workersInvocationsAdaptive(
            limit: 1
            filter: { datetime_geq: "${start}", datetime_leq: "${end}" }
          ) {
            sum { requests }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    const sum = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum?.requests;
    return typeof sum === "number" ? sum : 0;
  } catch {
    return null;
  }
}

async function showNodes(chatId, env, msgId = null) {
  const alive = await getHealthyChildren(env);
  const managed = await getManagedNodes(env);

  let text = `🖥 <b>نودهای فرزند</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;

  if (!managed.length && !alive.length) {
    text += "هیچ نودی ثبت نشده.";
  } else {
    // probe موازی فقط برای نودهای آفلاین
    const offline = managed.filter((m) => {
      const live = alive.find(
        (a) =>
          a.id.includes(m.script_name) ||
          (m.url && a.id.includes(String(m.script_name || "").replace(/-/g, ""))) ||
          (m.url && a.url && a.url.includes(m.script_name))
      );
      return !live && m.url && m.is_disabled !== 1;
    });

    const probeMap = new Map();
    if (offline.length) {
      const results = await Promise.allSettled(
        offline.map(async (m) => {
          const p = await probeNodeHealth(m.url);
          return { id: m.id, probe: p };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") probeMap.set(r.value.id, r.value.probe);
      }
    }

    // درخواست امروز برای همه نودهای مدیریت‌شده (موازی)
    const reqMap = new Map();
    await Promise.allSettled(
      managed.map(async (m) => {
        try {
          const token = await resolveNodeToken(env, m);
          if (token && m.account_id) {
            const r = await getAccountRequestsToday(token, m.account_id);
            if (typeof r === "number") reqMap.set(m.id, r);
          }
        } catch {}
      })
    );

    let i = 0;
    for (const m of managed) {
      i++;
      const live = alive.find(
        (a) =>
          a.id.includes(m.script_name) ||
          (m.url && a.id.includes(String(m.script_name || "").replace(/-/g, ""))) ||
          (m.url && a.url && a.url.includes(m.script_name))
      );
      const reqs = reqMap.has(m.id) ? formatReqShort(reqMap.get(m.id)) : "—";
      const users = live?.activeUsers != null ? faNum(live.activeUsers) : "—";
      const cap = live?.capacity != null ? faNum(live.capacity) : "—";
      const subOff = m.exclude_sub === 1 ? " · 🚫ساب" : "";

      if (m.is_disabled === 1) {
        text += `${faNum(i)}. 🔒 <code>${escape(m.script_name)}</code> · قفل · 📈${reqs}${subOff}\n`;
        continue;
      }

      if (live) {
        text += `${faNum(i)}. 🟢 <code>${escape(m.script_name)}</code> · 👥${users}/${cap} · 📈${reqs}${subOff}\n`;
        continue;
      }

      const p = probeMap.get(m.id);
      let reason = "آفلاین";
      if (p) {
        if (p.statusCode && p.statusCode !== 0) {
          reason = `HTTP ${p.statusCode}`;
        } else if (p.error) {
          const err = String(p.error);
          if (/timeout|aborted/i.test(err)) reason = "timeout";
          else if (/ENOTFOUND|DNS/i.test(err)) reason = "DNS";
          else if (/ECONNREFUSED/i.test(err)) reason = "refused";
          else reason = err.slice(0, 40);
        }
      }

      text += `${faNum(i)}. 🔴 <code>${escape(m.script_name)}</code> · ${escape(reason)} · 📈${reqs}${subOff}\n`;
    }

    for (const n of alive) {
      const known = managed.some(
        (m) =>
          n.id.includes(m.script_name) ||
          n.id.includes(String(m.script_name || "").replace(/-/g, ""))
      );
      if (known) continue;
      i++;
      text += `${faNum(i)}. 🟢 <code>${escape(n.id)}</code> (ثبت‌نشده) · 👥${faNum(n.activeUsers ?? 0)}\n`;
    }
  }

  const kb = [];
  let row = [];
  for (const m of managed) {
    let icon = "📦";
    if (m.is_disabled === 1) icon = "🔒";
    else if (m.exclude_sub === 1) icon = "🚫";
    const short = shortChildId(m.script_name || m.id);
    row.push({
      text: `${icon} ${short}`,
      callback_data: `node_detail:${m.id}`,
    });
    if (row.length === 3) {
      kb.push(row);
      row = [];
    }
  }
  if (row.length) kb.push(row);

  kb.push([
    { text: "🔄 بروزرسانی", callback_data: "nodes" },
    { text: "🔙 مدیریت", callback_data: "nodes_manage" },
  ]);

  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

// ====================== Cloudflare Node Ops ======================
async function createCloudflareNode(chatId, token, env) {
  try {
    const accountsRes = await cfFetch("/accounts?per_page=5", token);
    if (!accountsRes.success || !accountsRes.result?.length) {
      return send(chatId, `❌ خطا در دریافت اکانت:\n<code>${escape(JSON.stringify(accountsRes.errors || accountsRes))}</code>`, env);
    }
    const accountId = accountsRes.result[0].id;
    const accountName = accountsRes.result[0].name || "—";

    const motherAccountId = await getMotherAccountId(env);
    if (motherAccountId && motherAccountId === accountId) {
      return send(
        chatId,
        `❌ <b>خطا: ساخت نود بچه روی اکانت مادر ممنوع است!</b>\n\n` +
          `نود مادر نباید در معرض دسترسی مستقیم کاربران قرار بگیرد و فیلتر نشود.\n` +
          `لطفاً از اکانت Cloudflare دیگری استفاده کنید.`,
        env,
        [[{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }]]
      );
    }

    let accountSubdomain = null;
    try {
      const subRes = await cfFetch(`/accounts/${accountId}/workers/subdomain`, token);
      if (subRes.success && subRes.result?.subdomain) {
        accountSubdomain = subRes.result.subdomain;
      }
    } catch {}

    if (!accountSubdomain) {
      const randomSub = "saow" + Math.floor(1000 + Math.random() * 9000);
      try {
        const createRes = await cfFetch(`/accounts/${accountId}/workers/subdomain`, token, {
          method: "PUT",
          body: JSON.stringify({ subdomain: randomSub }),
        });
        if (createRes.success && createRes.result?.subdomain) {
          accountSubdomain = createRes.result.subdomain;
        } else if (createRes.errors?.[0]?.code === 10036) {
          try {
            const retry = await cfFetch(`/accounts/${accountId}/workers/subdomain`, token);
            if (retry.success && retry.result?.subdomain) {
              accountSubdomain = retry.result.subdomain;
            }
          } catch {}
        }
      } catch {}
    }

    if (!accountSubdomain) {
      return send(
        chatId,
        `❌ این اکانت هنوز زیردامنه <b>workers.dev</b> ندارد.\n\n` +
          `لطفاً یک‌بار با همین اکانت وارد داشبورد Cloudflare شوید و به بخش <b>Workers & Pages</b> بروید تا subdomain ساخته شود، سپس دوباره توکن را بفرستید.\n\n` +
          `لینک مستقیم:\n<code>https://dash.cloudflare.com/?to=/:account/workers</code>`,
        env,
        [[{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }]]
      );
    }

    const codeRes = await fetch(CHILD_WORKER_URL);
    if (!codeRes.ok) return send(chatId, `❌ خطا در دریافت کد ورکر فرزند`, env);
    let workerCode = await codeRes.text();

    // سازگاری با کدهای قدیمی (MOTHER_URL دیگر لازم نیست اما binding را نگه می‌داریم)
    workerCode = workerCode.replace(
      /(?:const|let|var)\s+MOTHER_URL\s*=\s*[^;]+;?/,
      `let MOTHER_URL = null;`
    );
    workerCode = workerCode.replace(
      /(export\s+default\s*\{\s*async\s+fetch\s*\(\s*request\s*,\s*env\s*,\s*ctx\s*\)\s*\{)/,
      `$1\n    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";\n`
    );

    const randomNum = Math.floor(10000 + Math.random() * 90000);
    const scriptName = `wk-${randomNum}`;
    const dbName = `db-${randomNum}`;
    const nodeUrl = `https://${scriptName}.${accountSubdomain}.workers.dev`;

    const dbRes = await cfFetch(`/accounts/${accountId}/d1/database`, token, {
      method: "POST",
      body: JSON.stringify({ name: dbName }),
    });
    if (!dbRes.success) {
      return send(chatId, `❌ خطا در ساخت D1:\n<code>${escape(JSON.stringify(dbRes.errors || dbRes))}</code>`, env);
    }
    const databaseId = dbRes.result.uuid || dbRes.result.id;

    const motherUrl = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");

    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2024-09-23",
      bindings: [
        { type: "d1", name: "DB", database_id: databaseId },
        { type: "plain_text", name: "MOTHER_URL", text: motherUrl },
        { type: "plain_text", name: "API_SECRET", text: API_SECRET },
      ],
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");

    const uploadRes = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const uploadJson = await uploadRes.json();

    if (!uploadJson.success) {
      try {
        await cfFetch(`/accounts/${accountId}/d1/database/${databaseId}`, token, { method: "DELETE" });
      } catch {}
      return send(chatId, `❌ خطا در آپلود ورکر:\n<code>${escape(JSON.stringify(uploadJson.errors || uploadJson))}</code>`, env);
    }

    try {
      await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, token, {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      });
    } catch {}

    // دیگر نیازی به Cron روی فرزند نیست (فرزند ساکت است)

    await saveManagedNode(env, {
      id: scriptName,
      script_name: scriptName,
      account_id: accountId,
      db_id: databaseId,
      db_name: dbName,
      token_encrypted: token,
      url: nodeUrl,
      created_at: Date.now(),
    });
    await saveCfAccount(env, { account_id: accountId, token, email: "", name: accountName });

    // اولین sync را فوری انجام بده
    triggerSync(env);

    const successText =
      `✅ <b>نود با موفقیت ساخته شد!</b>\n\n` +
      `📛 نام: <code>${scriptName}</code>\n` +
      `🗄 دیتابیس: <code>${dbName}</code>\n` +
      `🏷 اکانت: ${escape(accountName)}\n` +
      `🔗 آدرس نود:\n<code>${nodeUrl}</code>\n\n` +
      `معماری Push فعال است. مادر هر دقیقه همگام‌سازی می‌کند.\n` +
      `اگر نود تا چند دقیقه دیگر آنلاین نشد، یک‌بار URL نود را باز کنید تا Worker گرم شود.`;

    return send(chatId, successText, env, [
      [{ text: "🌐 باز کردن نود", url: nodeUrl }],
      [{ text: "📊 وضعیت نودها", callback_data: "nodes" }],
      [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
    ]);
  } catch (err) {
    console.error("createCloudflareNode error:", err);
    return send(chatId, `❌ خطای غیرمنتظره:\n<code>${escape(err.message)}</code>`, env);
  }
}

async function deleteCloudflareNode(chatId, scriptName, token, env) {
  try {
    const accountsRes = await cfFetch("/accounts?per_page=5", token);
    if (!accountsRes.success || !accountsRes.result?.length) {
      return send(chatId, `❌ خطا در دریافت اکانت`, env);
    }
    const accountId = accountsRes.result[0].id;

    const delRes = await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}`, token, { method: "DELETE" });
    if (!delRes.success) {
      return send(chatId, `❌ خطا در حذف نود:\n<code>${escape(JSON.stringify(delRes.errors || delRes))}</code>`, env);
    }

    try {
      const dbsRes = await cfFetch(`/accounts/${accountId}/d1/database`, token);
      if (dbsRes.success && dbsRes.result) {
        const match = dbsRes.result.find((db) => {
          const n = db.name || "";
          if (!n) return false;
          if (n.includes(scriptName.replace("wk-", "db-"))) return true;
          if (n.includes(scriptName.replace("saow-child-", "saow-db-"))) return true;
          if (n === scriptName) return true;
          return false;
        });
        if (match) {
          await cfFetch(`/accounts/${accountId}/d1/database/${match.uuid || match.id}`, token, {
            method: "DELETE",
          });
        }
      }
    } catch {}

    await removeManagedNode(env, scriptName);
    await removeChildByScriptName(env, scriptName);

    return send(chatId, `✅ نود <code>${escape(scriptName)}</code> با موفقیت حذف شد.`, env, [
      [{ text: "📊 وضعیت نودها", callback_data: "nodes" }],
      [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
    ]);
  } catch (err) {
    return send(chatId, `❌ خطا:\n<code>${escape(err.message)}</code>`, env);
  }
}

async function showAccountStatus(chatId, token, env) {
  try {
    const userRes = await cfFetch("/user", token);
    let email = "—";
    if (userRes.success && userRes.result) email = userRes.result.email || "—";

    const accountsRes = await cfFetch("/accounts?per_page=5", token);
    if (!accountsRes.success || !accountsRes.result?.length) {
      return send(chatId, `❌ خطا در دریافت اکانت`, env);
    }
    const accountId = accountsRes.result[0].id;
    const accountName = accountsRes.result[0].name || "—";

    let requestsToday = "—";
    try {
      const today = new Date();
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
        .toISOString()
        .slice(0, 10);
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
        .toISOString()
        .slice(0, 10);
      const gqlQuery = {
        query: `query {
          viewer {
            accounts(filter: {accountTag: "${accountId}"}) {
              httpRequests1dGroups(limit: 1, filter: {date_geq: "${start}", date_lt: "${end}"}) {
                sum { requests }
              }
            }
          }
        }`,
      };
      const gqlRes = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(gqlQuery),
      });
      const gqlJson = await gqlRes.json();
      const groups = gqlJson?.data?.viewer?.accounts?.[0]?.httpRequests1dGroups;
      if (groups && groups[0]?.sum?.requests != null) {
        requestsToday = groups[0].sum.requests.toLocaleString("fa-IR");
      }
    } catch {}

    const text =
      `📊 <b>وضعیت اکانت کلودفلر</b>\n\n` +
      `📧 ایمیل: <code>${escape(email)}</code>\n` +
      `🏷 نام: ${escape(accountName)}\n` +
      `🆔 Account ID: <code>${accountId}</code>\n` +
      `📈 درخواست‌های امروز: <b>${requestsToday}</b>\n\n` +
      `تاریخ: ${new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })}`;

    return send(chatId, text, env, [[{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }]]);
  } catch (err) {
    return send(chatId, `❌ خطا:\n<code>${escape(err.message)}</code>`, env);
  }
}

async function doUpdateMother(chatId, env, msgId) {
  try {
    const token = env.CF_TOKEN;
    const accountId = env.MOTHER_ACCOUNT_ID;
    const scriptName = env.WORKER_NAME;
    const selfUrl = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");

    if (!token || !accountId || !scriptName) {
      return edit(
        chatId,
        msgId,
        `❌ برای آپدیت مادر این متغیرها لازم است:\n` +
          `• CF_TOKEN\n• MOTHER_ACCOUNT_ID\n• WORKER_NAME\n\n` +
          `اگر پنل با اینستالر جدید ساخته نشده، این‌ها را دستی در Worker ست کن.`,
        env,
        [[{ text: "🔙", callback_data: "nodes_manage" }]]
      );
    }

    await edit(chatId, msgId, "⏳ در حال دریافت کد جدید از گیت‌هاب و آپلود...", env);

    const codeRes = await fetch(MOTHER_CODE_URL, {
      headers: { "User-Agent": "Saow-Mother-Updater" },
    });
    if (!codeRes.ok) throw new Error(`GitHub HTTP ${codeRes.status}`);
    const workerCode = await codeRes.text();
    if (!workerCode || workerCode.length < 500) throw new Error("کد گیت‌هاب نامعتبر است");

    let existingBindings = [];
    try {
      const settingsRes = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const settingsData = await settingsRes.json();
      if (settingsData.success && settingsData.result?.bindings) {
        existingBindings = settingsData.result.bindings;
      }
    } catch {}

    if (!existingBindings.length) {
      existingBindings = [
        { type: "plain_text", name: "BOT_TOKEN", text: env.BOT_TOKEN || "" },
        { type: "plain_text", name: "ADMIN_IDS", text: env.ADMIN_IDS || "" },
        { type: "plain_text", name: "MOTHER_URL", text: selfUrl },
        { type: "plain_text", name: "MOTHER_ACCOUNT_ID", text: accountId },
        { type: "plain_text", name: "CF_TOKEN", text: token },
        { type: "plain_text", name: "WORKER_NAME", text: scriptName },
      ];
    }

    const metadata = {
      main_module: "worker.js",
      compatibility_date: "2024-09-23",
      bindings: existingBindings,
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");

    const uploadRes = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.success) {
      throw new Error(uploadData.errors?.[0]?.message || JSON.stringify(uploadData));
    }

    return edit(
      chatId,
      msgId,
      `✅ <b>نود مادر آپدیت شد</b>\n\n📦 <code>${escape(scriptName)}</code>\n🌐 <code>${escape(selfUrl)}</code>`,
      env,
      [
        [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
        [{ text: "🏠 منو", callback_data: "main" }],
      ]
    );
  } catch (err) {
    return edit(chatId, msgId, `❌ خطا در آپدیت مادر:\n<code>${escape(err.message)}</code>`, env, [
      [{ text: "🔙", callback_data: "nodes_manage" }],
    ]);
  }
}

async function updateChildNode(chatId, nodeId, env, msgId) {
  await edit(chatId, msgId, `⏳ در حال آپدیت نود <code>${escape(nodeId)}</code>...`, env);
  try {
    const node = await getManagedNode(env, nodeId);
    if (!node || !node.token_encrypted) {
      return edit(chatId, msgId, "❌ اطلاعات نود یا توکن پیدا نشد.", env, [
        [{ text: "🔙", callback_data: "nodes" }],
      ]);
    }

    const token = node.token_encrypted;
    const accountId = node.account_id;
    const oldScript = node.script_name;
    const oldDbId = node.db_id;
    const oldDbName = node.db_name;

    try {
      await cfFetch(`/accounts/${accountId}/workers/scripts/${oldScript}`, token, { method: "DELETE" });
    } catch (e) {
      console.log("delete worker warning:", e?.message);
    }

    if (oldDbId) {
      try {
        await cfFetch(`/accounts/${accountId}/d1/database/${oldDbId}`, token, { method: "DELETE" });
      } catch (e) {
        console.log("delete D1 by id failed:", e?.message);
      }
    }

    try {
      const dbsRes = await cfFetch(`/accounts/${accountId}/d1/database`, token);
      if (dbsRes.success && Array.isArray(dbsRes.result)) {
        for (const db of dbsRes.result) {
          const name = db.name || "";
          const id = db.uuid || db.id;
          if (oldDbName && name === oldDbName) {
            await cfFetch(`/accounts/${accountId}/d1/database/${id}`, token, { method: "DELETE" });
          }
          if (name === oldScript || name === `db-${oldScript.replace("wk-", "").replace("saow-child-", "")}` || name === `saow-db-${oldScript.replace("saow-child-", "").replace("wk-", "")}`) {
            await cfFetch(`/accounts/${accountId}/d1/database/${id}`, token, { method: "DELETE" });
          }
        }
      }
    } catch (e) {
      console.log("cleanup D1 by list failed:", e?.message);
    }

    await removeChildByScriptName(env, oldScript);
    await removeManagedNode(env, nodeId);

    await new Promise((r) => setTimeout(r, 2000));

    await edit(chatId, msgId, "⏳ نود قدیمی حذف شد. در حال نصب نسخه جدید...", env);
    return createCloudflareNode(chatId, token, env);
  } catch (e) {
    return edit(chatId, msgId, `❌ خطا: ${escape(e.message)}`, env, [
      [{ text: "🔙", callback_data: "nodes" }],
    ]);
  }
}

// ====================== D1 Helpers for Managed Nodes ======================
async function saveManagedNode(env, data) {
  if (!(await d1Ready(env))) return;
  await env.DB.prepare(`
    INSERT INTO managed_nodes (id, script_name, account_id, db_id, db_name, token_encrypted, url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      script_name=excluded.script_name, account_id=excluded.account_id,
      db_id=excluded.db_id, db_name=excluded.db_name, token_encrypted=excluded.token_encrypted,
      url=excluded.url
  `)
    .bind(
      data.id,
      data.script_name,
      data.account_id,
      data.db_id,
      data.db_name,
      data.token_encrypted,
      data.url,
      data.created_at
    )
    .run();
}

async function getManagedNodes(env) {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM managed_nodes ORDER BY id ASC").all();
    return results || [];
  } catch (err) {
    if (err.message && err.message.includes("no such column: is_disabled")) {
      try {
        await env.DB.prepare("ALTER TABLE managed_nodes ADD COLUMN is_disabled INTEGER DEFAULT 0;").run();
        const { results } = await env.DB.prepare("SELECT * FROM managed_nodes ORDER BY id ASC").all();
        return results || [];
      } catch (alterErr) {
        console.error("خطا در اضافه کردن ستون is_disabled:", alterErr);
        return [];
      }
    }
    throw err;
  }
}

async function getManagedNode(env, id) {
  if (!(await d1Ready(env))) return null;
  try {
    return await env.DB.prepare("SELECT * FROM managed_nodes WHERE id = ?").bind(id).first();
  } catch {
    return null;
  }
}

async function removeManagedNode(env, id) {
  if (!(await d1Ready(env))) return;
  try {
    await env.DB.prepare("DELETE FROM managed_nodes WHERE id = ? OR script_name = ?").bind(id, id).run();
  } catch {}
}

async function saveCfAccount(env, data) {
  if (!(await d1Ready(env))) return;
  await env.DB.prepare(`
    INSERT INTO cf_accounts (account_id, token, email, name, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET token=excluded.token, email=excluded.email, name=excluded.name, updated_at=excluded.updated_at
  `)
    .bind(data.account_id, data.token, data.email || "", data.name || "", Date.now())
    .run();
}

async function getMotherAccountId(env) {
  return env.MOTHER_ACCOUNT_ID || null;
}

// ====================== Core Mother Logic (D1 + Users + Nodes) ======================
let dbInitialized = false;

async function d1Ready(env) {
  if (!env.DB) return false;
  if (dbInitialized) return true;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT, uuid TEXT UNIQUE, enabled INTEGER DEFAULT 1,
        expiry TEXT, quota_bytes INTEGER DEFAULT 0, daily_quota_bytes INTEGER DEFAULT 0,
        speed_limit_kbps INTEGER DEFAULT 0, ip_limit INTEGER DEFAULT 1, clean_ip TEXT DEFAULT '',
        block_ads INTEGER DEFAULT 1, notes TEXT, forced_node TEXT DEFAULT '',
        created_at INTEGER, updated_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage (
        user_id TEXT PRIMARY KEY, up INTEGER DEFAULT 0, down INTEGER DEFAULT 0, total INTEGER DEFAULT 0, updated_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS usage_daily (
        user_id TEXT, day TEXT, up INTEGER DEFAULT 0, down INTEGER DEFAULT 0, total INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, day)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS children (
        id TEXT PRIMARY KEY, url TEXT, version TEXT, capacity INTEGER DEFAULT 50,
        last_seen INTEGER, active_users INTEGER DEFAULT 0, healthy INTEGER DEFAULT 1, meta TEXT
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS active_ips (
        user_id TEXT NOT NULL, ip TEXT NOT NULL, last_seen INTEGER NOT NULL, child_id TEXT DEFAULT '',
        PRIMARY KEY (user_id, ip)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS managed_nodes (
        id TEXT PRIMARY KEY, script_name TEXT, account_id TEXT, db_id TEXT, db_name TEXT,
        token_encrypted TEXT, url TEXT, is_disabled INTEGER DEFAULT 0,
        exclude_sub INTEGER DEFAULT 0, created_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS cf_accounts (
        account_id TEXT PRIMARY KEY, token TEXT, email TEXT, name TEXT, updated_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS shop_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS shop_plans (
        id TEXT PRIMARY KEY,
        name TEXT,
        days INTEGER DEFAULT 30,
        quota_gb REAL DEFAULT 0,
        daily_gb REAL DEFAULT 0,
        price INTEGER DEFAULT 0,
        ip_limit INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS shop_orders (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        username TEXT,
        plan_id TEXT,
        plan_name TEXT,
        price INTEGER,
        status TEXT DEFAULT 'pending',
        created_at INTEGER,
        approved_at INTEGER,
        panel_user_id TEXT
      )`),
    ]);

    const alters = [
      `ALTER TABLE users ADD COLUMN speed_limit_kbps INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN daily_quota_bytes INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN clean_ip TEXT DEFAULT ''`,
      `ALTER TABLE users ADD COLUMN block_ads INTEGER DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN notes TEXT`,
      `ALTER TABLE users ADD COLUMN created_at INTEGER`,
      `ALTER TABLE users ADD COLUMN updated_at INTEGER`,
      `ALTER TABLE users ADD COLUMN ip_limit INTEGER DEFAULT 1`,
      `ALTER TABLE users ADD COLUMN quota_bytes INTEGER DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN expiry TEXT`,
      `ALTER TABLE users ADD COLUMN forced_node TEXT DEFAULT ''`,
      `ALTER TABLE managed_nodes ADD COLUMN is_disabled INTEGER DEFAULT 0`,
      `ALTER TABLE managed_nodes ADD COLUMN exclude_sub INTEGER DEFAULT 0`,
    ];

    for (const sql of alters) {
      try {
        await env.DB.prepare(sql).run();
      } catch {}
    }

    dbInitialized = true;
    return true;
  } catch (e) {
    console.error("d1Ready error:", e);
    return false;
  }
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function generateId() {
  return "u" + Math.random().toString(36).slice(2, 10);
}
function generateUuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function extractSecret(request) {
  const h = request.headers;
  const auth = h.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (h.get("x-api-key") || h.get("x-secret") || "").trim();
}
function requireAuth(request) {
  const secret = extractSecret(request);
  if (!secret || secret !== API_SECRET) return json({ ok: false, err: "unauthorized" }, 401);
  return null;
}

async function getUsers(env) {
  if (!(await d1Ready(env))) return [];
  try {
    const rows = await env.DB.prepare("SELECT * FROM users").all();
    return (rows.results || []).map(mapUserRow);
  } catch {
    return [];
  }
}
async function getUserByUuid(env, uuid) {
  if (!(await d1Ready(env))) return null;
  try {
    const row = await env.DB.prepare("SELECT * FROM users WHERE uuid = ? COLLATE NOCASE").bind(uuid).first();
    return row ? mapUserRow(row) : null;
  } catch {
    return null;
  }
}
async function getUserById(env, id) {
  if (!(await d1Ready(env))) return null;
  try {
    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return row ? mapUserRow(row) : null;
  } catch {
    return null;
  }
}
function mapUserRow(row) {
  return {
    id: row.id,
    name: row.name,
    uuid: row.uuid,
    enabled: !!row.enabled,
    expiry: row.expiry,
    quotaBytes: row.quota_bytes || 0,
    dailyQuotaBytes: row.daily_quota_bytes || 0,
    speedLimitKBps: row.speed_limit_kbps || 0,
    ipLimit: row.ip_limit || 1,
    cleanIp: row.clean_ip || "",
    blockAds: !!row.block_ads,
    notes: row.notes || "",
    forcedNode: row.forced_node || "",
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
  };
}
async function upsertUser(env, data) {
  if (!(await d1Ready(env))) return false;
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO users
      (id, name, uuid, enabled, expiry, quota_bytes, daily_quota_bytes, speed_limit_kbps, ip_limit, clean_ip, block_ads, notes, forced_node, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, uuid=excluded.uuid, enabled=excluded.enabled, expiry=excluded.expiry,
        quota_bytes=excluded.quota_bytes, daily_quota_bytes=excluded.daily_quota_bytes,
        speed_limit_kbps=excluded.speed_limit_kbps, ip_limit=excluded.ip_limit,
        clean_ip=excluded.clean_ip, block_ads=excluded.block_ads, notes=excluded.notes,
        forced_node=excluded.forced_node, updated_at=excluded.updated_at
    `)
      .bind(
        data.id,
        data.name,
        data.uuid,
        data.enabled ? 1 : 0,
        data.expiry || null,
        data.quotaBytes || 0,
        data.dailyQuotaBytes || 0,
        data.speedLimitKBps || 0,
        data.ipLimit ?? 1,
        data.cleanIp || "",
        data.blockAds ? 1 : 0,
        data.notes || "",
        data.forcedNode || "",
        now,
        now
      )
      .run();
    return true;
  } catch (e) {
    console.error("upsertUser", e);
    return false;
  }
}
async function deleteUser(env, id) {
  if (!(await d1Ready(env))) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
      env.DB.prepare("DELETE FROM usage WHERE user_id = ?").bind(id),
      env.DB.prepare("DELETE FROM usage_daily WHERE user_id = ?").bind(id),
      env.DB.prepare("DELETE FROM active_ips WHERE user_id = ?").bind(id),
    ]);
    return true;
  } catch {
    return false;
  }
}
async function resetUsage(env, userId) {
  if (!(await d1Ready(env))) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM usage_daily WHERE user_id = ?").bind(userId),
    ]);
    return true;
  } catch {
    return false;
  }
}
async function addUsage(env, userId, up, down) {
  if (!(await d1Ready(env)) || up + down <= 0) return;
  const now = Date.now();
  const day = todayKey();
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO usage (user_id, up, down, total, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          up = up + excluded.up, down = down + excluded.down, total = total + excluded.total, updated_at = excluded.updated_at
      `).bind(userId, up, down, up + down, now),
      env.DB.prepare(`
        INSERT INTO usage_daily (user_id, day, up, down, total) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, day) DO UPDATE SET
          up = up + excluded.up, down = down + excluded.down, total = total + excluded.total
      `).bind(userId, day, up, down, up + down),
    ]);
  } catch {}
}
async function getUsage(env, userId) {
  try {
    if (!(await d1Ready(env))) return { up: 0, down: 0, total: 0 };
    const row = await env.DB.prepare("SELECT up, down, total FROM usage WHERE user_id = ?").bind(userId).first();
    return row || { up: 0, down: 0, total: 0 };
  } catch {
    return { up: 0, down: 0, total: 0 };
  }
}
async function getDailyUsage(env, userId) {
  try {
    if (!(await d1Ready(env))) return { up: 0, down: 0, total: 0 };
    const row = await env.DB.prepare("SELECT up, down, total FROM usage_daily WHERE user_id = ? AND day = ?")
      .bind(userId, todayKey())
      .first();
    return row || { up: 0, down: 0, total: 0 };
  } catch {
    return { up: 0, down: 0, total: 0 };
  }
}

async function getHealthyChildren(env) {
  try {
    if (!(await d1Ready(env))) return [];
    await purgeUnknownChildren(env);
    const now = Date.now();
    const rows = await env.DB.prepare(`
      SELECT * FROM children WHERE last_seen > ? ORDER BY active_users ASC
    `)
      .bind(now - NODE_TTL)
      .all();
    return (rows.results || []).map((r) => ({
      id: r.id,
      url: r.url,
      version: r.version,
      capacity: r.capacity,
      lastSeen: r.last_seen,
      activeUsers: r.active_users,
    }));
  } catch {
    return [];
  }
}

async function getActiveIPCount(env, userId) {
  if (!(await d1Ready(env))) return 0;
  try {
    const now = Date.now();
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?")
      .bind(userId, now - IP_IDLE_MS)
      .run();
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM active_ips WHERE user_id = ?").bind(userId).first();
    return (row && row.c) || 0;
  } catch {
    return 0;
  }
}
async function listActiveIps(env, userId) {
  if (!(await d1Ready(env))) return [];
  try {
    const now = Date.now();
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?")
      .bind(userId, now - IP_IDLE_MS)
      .run();
    const rows = await env.DB.prepare(
      "SELECT ip, last_seen, child_id FROM active_ips WHERE user_id = ? ORDER BY last_seen DESC"
    )
      .bind(userId)
      .all();
    return (rows.results || []).map((r) => ({
      ip: r.ip,
      lastSeen: r.last_seen,
      ageSec: Math.floor((now - r.last_seen) / 1000),
      childId: r.child_id || "",
    }));
  } catch {
    return [];
  }
}
async function clearActiveIps(env, userId) {
  if (!(await d1Ready(env))) return false;
  try {
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ?").bind(userId).run();
    return true;
  } catch {
    return false;
  }
}

async function buildFullUser(env, user) {
  const total = await getUsage(env, user.id);
  const daily = await getDailyUsage(env, user.id);
  const activeCount = await getActiveIPCount(env, user.id);
  const activeDevices = await listActiveIps(env, user.id);
  const now = Date.now();
  const expired = user.expiry ? now > Date.parse(user.expiry) : false;
  let status = "active";
  if (!user.enabled) status = "disabled";
  else if (expired) status = "expired";
  else if (user.quotaBytes > 0 && total.total >= user.quotaBytes) status = "quota-exceeded";
  else if (user.dailyQuotaBytes > 0 && daily.total >= user.dailyQuotaBytes) status = "daily-quota-exceeded";
  return {
    ...user,
    status,
    usage: {
      total: total.total || 0,
      up: total.up || 0,
      down: total.down || 0,
      daily: daily.total || 0,
      totalGB: +((total.total || 0) / 1073741824).toFixed(3),
      dailyGB: +((daily.total || 0) / 1073741824).toFixed(3),
    },
    activeIPs: activeCount,
    activeDevices,
    subscription: `${SUB_PATH}?token=${user.uuid}`,
  };
}

async function getStatusData(env) {
  const users = await getUsers(env);
  const full = await Promise.all(users.map((u) => buildFullUser(env, u)));
  const nodes = await getHealthyChildren(env);
  const totalTraffic = full.reduce((s, u) => s + (u.usage.total || 0), 0);
  return {
    version: VERSION,
    users: full.length,
    activeUsers: full.filter((u) => u.status === "active").length,
    onlineUsers: full.filter((u) => u.activeIPs > 0).length,
    nodes: nodes.length,
    totalTrafficGB: +(totalTraffic / 1073741824).toFixed(3),
    live: full.map((u) => ({
      id: u.id,
      name: u.name,
      status: u.status,
      activeIPs: u.activeIPs,
      usageGB: u.usage.totalGB,
      ipLimit: u.ipLimit,
    })),
  };
}

// Domains / IRCF / Subscription
const DOMAINS_URL = "https://raw.githubusercontent.com/isfwic10-arch/cf-domains/refs/heads/main/domains.txt";
const DOMAINS_TTL_MS = 30 * 60 * 1000;
let domainsList = null,
  domainsListAt = 0,
  domainsLoading = null;
const IRCF_DOMAINS = [
  { domain: "ipv4.ircf.space", name: "عمومی" },
  { domain: "mcic.ircf.space", name: "همراه‌اول" },
  { domain: "mtnc.ircf.space", name: "ایرانسل" },
  { domain: "mkhc.ircf.space", name: "مخابرات" },
  { domain: "rtlc.ircf.space", name: "رایتل" },
  { domain: "hwb.ircf.space", name: "های‌وب" },
  { domain: "ast.ircf.space", name: "آسیاتک" },
  { domain: "sht.ircf.space", name: "شاتل" },
  { domain: "prs.ircf.space", name: "پارس‌آنلاین" },
  { domain: "mbt.ircf.space", name: "مبین‌نت" },
  { domain: "ask.ircf.space", name: "اندیشه‌سبز" },
  { domain: "rsp.ircf.space", name: "رسپینا" },
  { domain: "afn.ircf.space", name: "افرانت" },
  { domain: "ztl.ircf.space", name: "زی‌تل" },
  { domain: "psm.ircf.space", name: "پیشگامان" },
  { domain: "arx.ircf.space", name: "آراکس" },
  { domain: "smt.ircf.space", name: "سامانتل" },
  { domain: "shm.ircf.space", name: "شاتل‌موبایل" },
  { domain: "fnv.ircf.space", name: "فن‌آوا" },
  { domain: "dbn.ircf.space", name: "دیده‌بان‌نت" },
  { domain: "apt.ircf.space", name: "آپتل" },
  { domain: "fnp.ircf.space", name: "فناپ‌تلکام" },
  { domain: "ryn.ircf.space", name: "رای‌نت" },
  { domain: "sbn.ircf.space", name: "صبانت" },
  { domain: "ptk.ircf.space", name: "پتیاک" },
  { domain: "atc.ircf.space", name: "عصر تلکام" },
];
const IRCF_CACHE_TTL = 5 * 60 * 1000;
let ircfCache = null,
  ircfCacheAt = 0,
  ircfLoading = null;

function parseDomainsText(text) {
  const list = [];
  const seen = new Set();
  for (let p of String(text || "")
    .replace(/\r/g, "\n")
    .split(/[\n,;]+/)) {
    p = p.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (p.length >= 3 && p.length <= 253 && !/[^a-z0-9.:-]/i.test(p) && !seen.has(p)) {
      seen.add(p);
      list.push(p);
    }
  }
  return list;
}
async function ensureDomainsList() {
  const now = Date.now();
  if (domainsList && now - domainsListAt < DOMAINS_TTL_MS) return domainsList;
  if (domainsLoading) return domainsLoading;
  domainsLoading = (async () => {
    try {
      const r = await fetch(DOMAINS_URL, { cf: { cacheTtl: 1800, cacheEverything: true } });
      if (r.ok) {
        const list = parseDomainsText(await r.text());
        if (list.length) {
          domainsList = list;
          domainsListAt = Date.now();
          return list;
        }
      }
    } catch {}
    return domainsList || [];
  })();
  try {
    return await domainsLoading;
  } finally {
    domainsLoading = null;
  }
}
async function resolveDomain(domain) {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
      headers: { Accept: "application/dns-json" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answers = (data.Answer || []).filter((a) => a.type === 1 && a.data);
    if (!answers.length) return null;
    return answers[Math.floor(Math.random() * answers.length)].data;
  } catch {
    return null;
  }
}
async function ensureIrcfResolved() {
  const now = Date.now();
  if (ircfCache && now - ircfCacheAt < IRCF_CACHE_TTL) return ircfCache;
  if (ircfLoading) return ircfLoading;
  ircfLoading = (async () => {
    const results = await Promise.all(
      IRCF_DOMAINS.map(async (item) => {
        const ip = await resolveDomain(item.domain);
        return { ...item, ip };
      })
    );
    const map = {};
    for (const r of results) if (r.ip) map[r.domain] = r.ip;
    if (Object.keys(map).length >= 2) {
      ircfCache = map;
      ircfCacheAt = Date.now();
    }
    return ircfCache || map;
  })();
  try {
    return await ircfLoading;
  } finally {
    ircfLoading = null;
  }
}

function formatBytesShort(n) {
  n = Number(n) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + "GB";
  if (n >= 1048576) return (n / 1048576).toFixed(0) + "MB";
  return (n / 1024).toFixed(0) + "KB";
}
/** اعداد را با ارقام فارسی برمی‌گرداند */
function faNum(n) {
  if (n == null || n === "") return "—";
  const s = typeof n === "number" ? String(n) : String(n);
  return s.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
}
/** خلاصه درخواست: 716 → 716 ، 1200 → 1.2K ، 1500000 → 1.5M */
function formatReqShort(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  n = Number(n);
  if (n >= 1e6) return faNum((n / 1e6).toFixed(n >= 1e7 ? 0 : 1)) + "M";
  if (n >= 1000) return faNum((n / 1000).toFixed(n >= 10000 ? 0 : 1)) + "K";
  return faNum(n);
}
function shortChildId(scriptName) {
  const s = String(scriptName || "");
  const m = s.match(/(\d{4,})$/);
  if (m) return m[1];
  return s.replace(/^saow-child-/, "").replace(/^wk-/, "").slice(0, 8) || "—";
}
function daysRemaining(expiry) {
  if (!expiry) return "∞";
  const ms = Date.parse(expiry) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "۰";
  return faNum(Math.ceil(ms / 86400000));
}
function buildVlessLink({ ip, port, uuid, host, path, name, fp = "chrome" }) {
  const qs = new URLSearchParams({
    security: "tls",
    sni: host,
    fp,
    type: "ws",
    path: path || "/",
    host,
    encryption: "none",
    alpn: "http/1.1",
  });
  return `vless://${uuid}@${ip}:${port}?${qs.toString()}#${encodeURIComponent(name)}`;
}
function buildInfoLink(uuid, host, title) {
  return buildVlessLink({ ip: "127.0.0.1", port: 1, uuid, host, path: "/", name: title });
}
async function generateSubscription(env, user, motherHost) {
  const links = [];
  const total = await getUsage(env, user.id);
  const daily = await getDailyUsage(env, user.id);
  const base = user.name || user.id;
  const isExpired = user.expiry && Date.parse(user.expiry) <= Date.now();
  const isQuotaExceeded = user.quotaBytes > 0 && total.total >= user.quotaBytes;
  const isDailyExceeded = user.dailyQuotaBytes > 0 && daily.total >= user.dailyQuotaBytes;
  const isDisabled = !user.enabled;

  let sponsorText = "";
  try {
    const cfg = await getShopConfig(env);
    sponsorText = (cfg.sponsorText || "").trim();
  } catch {}

  if (isDisabled || isExpired || isQuotaExceeded || isDailyExceeded) {
    if (isDisabled) links.push(buildInfoLink(user.uuid, motherHost, `🚫 حساب شما غیرفعال شده است`));
    if (isExpired) links.push(buildInfoLink(user.uuid, motherHost, `⏰ زمان اشتراک به پایان رسیده`));
    if (isQuotaExceeded) links.push(buildInfoLink(user.uuid, motherHost, `📦 حجم کل تمام شده`));
    if (isDailyExceeded) links.push(buildInfoLink(user.uuid, motherHost, `📅 حجم روزانه تمام شده`));
    if (sponsorText) {
      // چند خط اسپانسر را به صورت بنر جداگانه
      for (const line of sponsorText.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 4)) {
        links.push(buildInfoLink(user.uuid, motherHost, line.slice(0, 64)));
      }
    } else {
      links.push(buildInfoLink(user.uuid, motherHost, `🔄 برای تمدید با پشتیبانی در ارتباط باشید`));
    }
    return links.join("\n");
  }

  const rawManaged = await getManagedNodes(env);
  const managed = rawManaged.filter((m) => m.is_disabled !== 1);
  const alive = await getHealthyChildren(env);

  function hostFromUrl(u) {
    try {
      return new URL(u).hostname;
    } catch {
      return null;
    }
  }

  function isAliveMatch(m, a) {
    if (!m) return false;
    const script = m.script_name || "";
    const mHost = hostFromUrl(m.url || "");
    if (script && a.id && a.id.includes(script)) return true;
    if (mHost && a.id && a.id.includes(mHost.split(".")[0])) return true;
    if (mHost && a.url && a.url.includes(mHost)) return true;
    if (script && a.url && a.url.includes(script)) return true;
    return false;
  }

  // ---------- انتخاب نود ----------
  // 1) اگر کاربر قفل روی نود خاص باشد → همان
  // 2) وگرنه بین نودهای سالم که exclude_sub=0 نیستند، کم‌بارترین (کمترین درخواست امروز)
  let selectedUrl = null;
  let selectedNode = null;

  if (user.forcedNode) {
    const forced = managed.find(
      (m) =>
        m.script_name === user.forcedNode ||
        m.id === user.forcedNode ||
        (m.url && m.url.includes(user.forcedNode))
    );
    if (forced && forced.url) {
      selectedNode = forced;
      selectedUrl = forced.url;
    }
  }

  if (!selectedUrl) {
    const healthyManaged = [];
    for (const m of managed) {
      if (!m.url || m.is_disabled === 1) continue;
      if (m.exclude_sub === 1) continue; // خارج از چرخه ساب
      if (alive.some((a) => isAliveMatch(m, a))) {
        healthyManaged.push(m);
      }
    }

    if (healthyManaged.length) {
      const scored = await Promise.all(
        healthyManaged.map(async (m) => {
          let reqs = Number.MAX_SAFE_INTEGER;
          try {
            const token = await resolveNodeToken(env, m);
            if (token && m.account_id) {
              const r = await getAccountRequestsToday(token, m.account_id);
              if (typeof r === "number") reqs = r;
            }
          } catch {}
          return { node: m, reqs };
        })
      );
      scored.sort((a, b) => a.reqs - b.reqs);
      selectedNode = scored[0].node;
      selectedUrl = selectedNode.url;
    }
  }

  if (!selectedUrl) {
    // fallback: هر نود مدیریت‌شده غیرقفل (حتی exclude_sub) با url
    const withUrl = managed.find((m) => m.url && m.is_disabled !== 1 && m.exclude_sub !== 1);
    if (withUrl) {
      selectedNode = withUrl;
      selectedUrl = withUrl.url;
    }
  }

  if (!selectedUrl && alive.length && alive[0].url) {
    selectedUrl = alive[0].url;
  }

  let childHost = hostFromUrl(selectedUrl);
  if (!selectedUrl) {
    links.push(buildInfoLink(user.uuid, motherHost, `⚠️ هیچ نود فعالی وجود ندارد`));
    return links.join("\n");
  }

  if (!childHost) {
    links.push(buildInfoLink(user.uuid, motherHost, `⚠️ نود نامعتبر`));
    return links.join("\n");
  }

  const activeCount = await getActiveIPCount(env, user.id);
  const childNo = shortChildId(
    selectedNode?.script_name || selectedNode?.id || childHost.split(".")[0] || ""
  );
  const usedStr = formatBytesShort(total.total);
  const quotaStr = user.quotaBytes > 0 ? formatBytesShort(user.quotaBytes) : "∞";
  const daysStr = daysRemaining(user.expiry);
  // بنر خلاصه + شماره child
  links.push(
    buildVlessLink({
      ip: "127.0.0.1",
      port: 1,
      uuid: user.uuid,
      host: motherHost,
      path: "/",
      name: `📋 #${childNo} │ ${usedStr}/${quotaStr} │ ${daysStr}روز │ IP ${faNum(activeCount)}/${faNum(user.ipLimit)}`,
    })
  );

  if (sponsorText) {
    for (const line of sponsorText.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 3)) {
      links.push(buildInfoLink(user.uuid, motherHost, line.slice(0, 64)));
    }
  }

  // دامنه‌های گیت‌هاب (ترجیحاً IP رزولوشن‌شده)
  let gh = [];
  try {
    gh = await ensureDomainsList();
  } catch {}
  const preferred = (gh || []).slice(0, 5);
  const ports = [443, 8443, 2053, 2083, 2087];
  const fps = ["chrome", "firefox", "safari", "edge", "random"];
  for (let i = 0; i < preferred.length; i++) {
    let addr = preferred[i];
    // اگر دامنه است، IP بگیر (در غیر این صورت همان IP/رشته)
    if (addr && !/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
      try {
        const resolvedIp = await resolveDomain(addr);
        if (resolvedIp) addr = resolvedIp;
      } catch {}
    }
    links.push(
      buildVlessLink({
        ip: addr,
        port: ports[i % ports.length],
        uuid: user.uuid,
        host: childHost,
        path: `/?u=${user.id}`,
        name: `⭐ ${base} | P${i + 1}`,
        fp: fps[i % fps.length],
      })
    );
  }

  // دامنه‌های IRCF (همیشه IP با TTL ۵ دقیقه)
  let resolved = {};
  try {
    resolved = await ensureIrcfResolved();
  } catch {}
  let idx = 0;
  const ircfFps = ["chrome", "firefox", "safari", "edge", "random"];
  for (const item of IRCF_DOMAINS) {
    const ip = resolved[item.domain];
    if (!ip) continue;
    links.push(
      buildVlessLink({
        ip,
        port: 443,
        uuid: user.uuid,
        host: childHost,
        path: `/?u=${user.id}`,
        name: `⚡ ${base} | ${item.name}`,
        fp: ircfFps[idx % ircfFps.length],
      })
    );
    idx++;
  }

  return links.join("\n");
}

// ====================== API (دیگر برای گزارش از فرزند استفاده نمی‌شود) ======================
async function handleApi(request, env, path) {
  try {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization,x-api-key,x-secret",
        },
      });
    }

    // در معماری جدید فرزند هیچ درخواستی به مادر نمی‌زند.
    // اگر هنوز درخواست قدیمی آمد، رد می‌کنیم.
    if (path === "/node/report") {
      return json({ ok: false, err: "push-mode: children must not initiate requests" }, 403);
    }

    const authErr = requireAuth(request);
    if (authErr) return authErr;

    if (path === "/status" || path === "/info") {
      return json({ ok: true, ...(await getStatusData(env)) });
    }
    if (path === "/nodes") {
      const alive = await getHealthyChildren(env);
      return json({ ok: true, alive, all: alive });
    }
    if (path === "/users" && request.method === "GET") {
      const url = new URL(request.url);
      const id = url.searchParams.get("id");
      const uuid = url.searchParams.get("uuid");
      if (id || uuid) {
        const user = id ? await getUserById(env, id) : await getUserByUuid(env, uuid);
        if (!user) return json({ ok: false, err: "not found" }, 404);
        return json({ ok: true, user: await buildFullUser(env, user) });
      }
      const users = await getUsers(env);
      const list = await Promise.all(users.map((u) => buildFullUser(env, u)));
      return json({ ok: true, users: list, total: list.length, version: VERSION });
    }

    return json({ ok: false, err: "not found" }, 404);
  } catch (e) {
    console.error("api error", e);
    return json({ ok: false, err: "internal" }, 500);
  }
}

// ====================== Helpers ======================
async function serveStatusPage(request, env) {
  try {
    const res = await fetch(STATUS_HTML_URL, {
      headers: { "User-Agent": "Saow-Mother/3.6" },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) throw new Error("fetch status html failed");

    let html = await res.text();

    const inject = `<script>window.__SAOW_VERSION__=${JSON.stringify(VERSION)};</script>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", inject + "</head>");
    } else {
      html = inject + html;
    }

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (e) {
    return new Response(
      `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>Saow Panel</title></head>
       <body style="background:#05060f;color:#e2e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">
         <div style="text-align:center">
           <h1 style="font-size:2.5rem;letter-spacing:.15em">SAOW</h1>
           <p>Mother Panel (Push Mode)</p>
           <p style="opacity:.7">Version: <b>${VERSION}</b></p>
         </div>
       </body></html>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }
}

async function removeChildByScriptName(env, scriptName) {
  if (!(await d1Ready(env)) || !scriptName) return;
  try {
    await env.DB.prepare(`DELETE FROM children WHERE id LIKE ? OR id LIKE ? OR url LIKE ?`)
      .bind(`%${scriptName}%`, `%${scriptName.replace(/-/g, "")}%`, `%${scriptName}%`)
      .run();
  } catch (e) {
    console.log("removeChildByScriptName:", e?.message);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type,authorization,x-api-key,x-secret",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "cache-control": "no-store",
    },
  });
}

async function cfFetch(path, token, options = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  return res.json();
}

const TG_MAX_LEN = 4000; // کمی کمتر از 4096 برای حاشیه امن

function truncateTg(text) {
  const s = String(text || "");
  if (s.length <= TG_MAX_LEN) return s;
  return s.slice(0, TG_MAX_LEN - 30) + "\n\n… (متن کوتاه شد)";
}

async function send(chatId, text, env, keyboard = null, forceReply = false) {
  const body = {
    chat_id: chatId,
    text: truncateTg(text),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (forceReply) body.reply_markup = { force_reply: true, selective: true };
  else if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  try {
    const res = await fetch(`${TG}/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("sendMessage FAILED:", JSON.stringify(data));
      // اگر HTML خراب بود، بدون parse_mode یک‌بار دیگر تلاش کن
      if (String(data.description || "").includes("parse")) {
        const body2 = { ...body, parse_mode: undefined, text: truncateTg(text.replace(/<[^>]+>/g, "")) };
        await fetch(`${TG}/bot${env.BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body2),
        });
      }
    }
  } catch (e) {
    console.error("send exception:", e?.message || e);
  }
}

async function edit(chatId, msgId, text, env, keyboard = null) {
  const safeText = truncateTg(text);
  const body = {
    chat_id: chatId,
    message_id: msgId,
    text: safeText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  try {
    const res = await fetch(`${TG}/bot${env.BOT_TOKEN}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();

    if (!data.ok) {
      const desc = data.description || "";
      console.error("editMessageText FAILED:", JSON.stringify(data));

      if (desc.includes("message is not modified")) return;

      // پیام خیلی بلند یا خطای دیگر → پیام جدید (از قبل truncate شده)
      await send(chatId, safeText, env, keyboard);
    }
  } catch (e) {
    console.error("edit exception:", e?.message || e);
    await send(chatId, safeText, env, keyboard);
  }
}
async function answer(id, text, env, alert = false) {
  await fetch(`${TG}/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text: text || "", show_alert: alert }),
  });
}
function escape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
