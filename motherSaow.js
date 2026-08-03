/**
 * Saow Mother Worker + Telegram Bot (Unified)
 * Version: mother-bot-3.5
 * - Direct D1 access (no self-API)
 * - CF tokens & nodes stored in D1
 * - Child node cannot be created on same account as Mother
 * - Update Mother (code only) / Update Child (delete + reinstall)
 */

const VERSION = "mother-bot-3.5";
const BOT_VERSION = "3.5";
const TG = "https://api.telegram.org";
const CF_API = "https://api.cloudflare.com/client/v4";
const CHILD_WORKER_URL = "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/childWorker.js";
const MOTHER_CODE_URL = "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/motherSaow.js"; // یا همین فایل
const CF_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Saow%20Installer";

const API_ROOT = "/api";
const SUB_PATH = "/pull";
const NODE_TTL = 6 * 60 * 1000;
const IP_IDLE_MS = 90 * 1000;
const API_SECRET = "saow-pan"; // برای گزارش نودهای بچه

// ====================== Main Entry ======================
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Telegram Webhook
      if (request.method === "POST" && (path === "/" || path === "/webhook")) {
        const update = await request.json();
        env._SELF_URL = url.origin;
        ctx.waitUntil(handleTelegramUpdate(update, env));
        return new Response("OK");
      }

      // Manual setWebhook helper
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

      // API for child nodes (heartbeat / connect / usage)
      if (path.startsWith(API_ROOT)) {
        return handleApi(request, env, path.slice(API_ROOT.length) || "/");
      }

      // Subscription
      if (path === SUB_PATH || path === SUB_PATH + "/") {
        const token = url.searchParams.get("token") || "";
        if (!token) return new Response("token required", { status: 401 });
        const user = await getUserByUuid(env, token);
        if (!user) return new Response("invalid", { status: 404 });
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

      if (path === "/" || path === "/version") {
        return json({ v: VERSION, r: "core+bot" });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e) {
      console.error("main error", e);
      return new Response("Error", { status: 500 });
    }
  },
};

// ====================== Telegram Handlers ======================
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
    [
      { text: "۳۶۵ روز", callback_data: `expiry:${id}:365` },
    ],
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


async function getAccountRequestsToday(token, accountId) {
  try {
    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
      .toISOString().slice(0, 10);
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1))
      .toISOString().slice(0, 10);

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
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(gqlQuery),
    });
    const gqlJson = await gqlRes.json();
    const groups = gqlJson?.data?.viewer?.accounts?.[0]?.httpRequests1dGroups;
    if (groups && groups[0]?.sum?.requests != null) {
      return groups[0].sum.requests;
    }
  } catch {}
  return null;
}

async function showMotherAccountStatus(chatId, env, msgId) {
  try {
    const token = env.CF_TOKEN;
    const accountId = env.MOTHER_ACCOUNT_ID;
    if (!token || !accountId) {
      return edit(chatId, msgId,
        "❌ CF_TOKEN یا MOTHER_ACCOUNT_ID تنظیم نشده.",
        env,
        [[{ text: "🔙", callback_data: "nodes_manage" }]]
      );
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

    // حذف Worker
    const delRes = await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}`, token, { method: "DELETE" });
    // حتی اگر Worker از قبل حذف شده باشد، ادامه می‌دهیم

    // حذف D1
    if (node.db_id) {
      try {
        await cfFetch(`/accounts/${accountId}/d1/database/${node.db_id}`, token, { method: "DELETE" });
      } catch {}
    }

    // حذف از دیتابیس پنل
    await removeChildByScriptName(env, scriptName);
    await removeManagedNode(env, nodeId);

    return edit(chatId, msgId,
      `✅ نود <code>${escape(scriptName)}</code> با موفقیت حذف شد.`,
      env,
      [
        [{ text: "📊 وضعیت نودها", callback_data: "nodes" }],
        [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
      ]
    );
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

  if (!isAdmin(userId, env)) {
    return send(chatId, "⛔️ شما دسترسی ادمین ندارید.", env);
  }

  const replyText = msg.reply_to_message?.text || "";

  // ----- ساخت کاربر -----
  if (replyText.includes("نام کاربر جدید را ارسال کنید")) {
    const name = text.slice(0, 32).trim();
    if (!name) return send(chatId, "❌ نام نمی‌تواند خالی باشد.", env);
    const id = generateId();
    const uuid = generateUuid();
    const ok = await upsertUser(env, {
      id, name, uuid, enabled: true, expiry: null,
      quotaBytes: 0, dailyQuotaBytes: 0, speedLimitKBps: 0,
      ipLimit: 1, cleanIp: "", blockAds: true, notes: "created via telegram bot",
    });
    if (!ok) return send(chatId, "❌ خطا در ساخت کاربر", env);
    await send(chatId, `✅ کاربر <b>${escape(name)}</b> ساخته شد\n🆔 <code>${id}</code>`, env);
    return showUser(chatId, id, env);
  }

  // ----- تاریخ انقضا -----
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
      // تعداد روز از الان
      const days = parseInt(raw, 10);
      if (days < 0 || days > 3650) return send(chatId, "❌ تعداد روز بین ۰ تا ۳۶۵۰", env);
      if (days === 0) expiry = null;
      else expiry = new Date(Date.now() + days * 86400000).toISOString();
    } else if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      // تاریخ میلادی
      const t = Date.parse(raw);
      if (!Number.isFinite(t)) return send(chatId, "❌ تاریخ نامعتبر است", env);
      expiry = new Date(t).toISOString();
    } else {
      return send(chatId, "❌ فرمت نامعتبر. مثال: <code>30</code> یا <code>2026-12-31</code>", env);
    }

    await upsertUser(env, { ...user, expiry });
    await send(chatId, "✅ تاریخ انقضا تنظیم شد", env);
    return showUser(chatId, id, env);
  }
  // ----- ویرایش یادداشت -----
  if (replyText.includes("یادداشت جدید را ارسال کنید")) {
    const id = extractIdFromReply(replyText);
    if (!id) return send(chatId, "❌ خطا در شناسایی کاربر", env);
    const user = await getUserById(env, id);
    if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
    await upsertUser(env, { ...user, notes: text.slice(0, 200) });
    await send(chatId, "✅ یادداشت بروزرسانی شد", env);
    return showUser(chatId, id, env);
  }

  // ----- حجم کل -----
  if (replyText.includes("حجم کل را به گیگابایت ارسال کنید")) {
    const id = extractIdFromReply(replyText);
    const gb = parseFloat(text.replace(",", "."));
    if (isNaN(gb) || gb < 0) return send(chatId, "❌ عدد معتبر وارد کنید", env);
    const user = await getUserById(env, id);
    if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
    await upsertUser(env, { ...user, quotaBytes: gb === 0 ? 0 : Math.floor(gb * 1073741824) });
    await send(chatId, "✅ حجم کل تنظیم شد", env);
    return showUser(chatId, id, env);
  }

  // ----- حجم روزانه -----
  if (replyText.includes("حجم روزانه را به گیگابایت ارسال کنید")) {
    const id = extractIdFromReply(replyText);
    const gb = parseFloat(text.replace(",", "."));
    if (isNaN(gb) || gb < 0) return send(chatId, "❌ عدد معتبر وارد کنید", env);
    const user = await getUserById(env, id);
    if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
    await upsertUser(env, { ...user, dailyQuotaBytes: gb === 0 ? 0 : Math.floor(gb * 1073741824) });
    await send(chatId, "✅ حجم روزانه تنظیم شد", env);
    return showUser(chatId, id, env);
  }

  // ----- محدودیت IP -----
  if (replyText.includes("محدودیت IP را ارسال کنید")) {
    const id = extractIdFromReply(replyText);
    const limit = parseInt(text);
    if (isNaN(limit) || limit < 1 || limit > 100) return send(chatId, "❌ عدد بین ۱ تا ۱۰۰", env);
    const user = await getUserById(env, id);
    if (!user) return send(chatId, "❌ کاربر پیدا نشد", env);
    await upsertUser(env, { ...user, ipLimit: limit });
    await send(chatId, "✅ محدودیت IP تنظیم شد", env);
    return showUser(chatId, id, env);
  }

  // ----- ساخت نود (دریافت توکن) -----
  if (replyText.includes("توکن API کلودفلر را ارسال کنید") || replyText.includes("توکن کلودفلر را ارسال کنید")) {
    const token = text.trim();
    if (!token || token.length < 30) return send(chatId, "❌ توکن نامعتبر است.", env);
    await send(chatId, "⏳ در حال ساخت نود... لطفاً صبر کنید.", env);
    return createCloudflareNode(chatId, token, env);
  }

  // ----- حذف نود -----
  if (replyText.includes("نام نود و توکن را ارسال کنید")) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      return send(chatId, "❌ فرمت نادرست.\nمثال:\n<code>saow-child-12345 YOUR_TOKEN</code>", env);
    }
    const scriptName = parts[0];
    const token = parts.slice(1).join(" ").trim();
    if (!token || token.length < 30) return send(chatId, "❌ توکن نامعتبر است.", env);
    await send(chatId, "⏳ در حال حذف نود...", env);
    return deleteCloudflareNode(chatId, scriptName, token, env);
  }

  // ----- وضعیت اکانت -----
  if (replyText.includes("توکن را برای مشاهده وضعیت اکانت ارسال کنید")) {
    const token = text.trim();
    if (!token || token.length < 30) return send(chatId, "❌ توکن نامعتبر است.", env);
    await send(chatId, "⏳ در حال دریافت اطلاعات...", env);
    return showAccountStatus(chatId, token, env);
  }

  // ----- جستجوی هوشمند -----
  if (text && !text.startsWith("/")) {
    const found = await findUserByText(text, env);
    if (found) return showUser(chatId, found, env);
  }

  if (text === "/start" || text === "/menu" || text === "منو") {
    return showMain(chatId, env);
  }

  return send(chatId, "از دکمه‌های شیشه‌ای استفاده کنید یا UUID / لینک کانفیگ ارسال کنید.\n/start", env);
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

  if (!isAdmin(userId, env)) {
    return answer(cq.id, "⛔️ دسترسی ندارید", env, true);
  }
  await answer(cq.id, "", env);

  if (data === "main") return showMain(chatId, env, msgId);
  if (data === "status") return showStatus(chatId, env, msgId);
  if (data === "nodes") return showNodes(chatId, env, msgId);
  if (data === "nodes_manage") return showNodesManage(chatId, env, msgId);

  if (data.startsWith("users:")) {
    const page = parseInt(data.split(":")[1]) || 0;
    return showUsers(chatId, page, env, msgId);
  }

  if (data.startsWith("expirymenu:")) return expiryMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("expiry:")) {
    // expiry:USERID:DAYS   یا expiry:USERID:0 برای نامحدود
    const parts = data.split(":");
    const id = parts[1];
    const days = parseInt(parts[2], 10);
    return setExpiry(chatId, id, days, env, msgId);
  }
  if (data.startsWith("expirymanual:")) {
    const id = data.split(":")[1];
    return send(chatId,
      `✏️ <b>تاریخ انقضا را ارسال کنید</b>\n\n` +
      `کاربر: ${id}\n\n` +
      `فرمت‌های مجاز:\n` +
      `• تعداد روز: <code>30</code>\n` +
      `• تاریخ: <code>2026-12-31</code>\n` +
      `• یا <code>0</code> برای نامحدود`,
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
    return send(chatId, "✏️ <b>نام کاربر جدید را ارسال کنید:</b>\n\n(حداکثر ۳۲ کاراکتر)", env, [
      [{ text: "❌ انصراف", callback_data: "main" }]
    ], true);
  }

  if (data.startsWith("notes:")) {
    const id = data.split(":")[1];
    return send(chatId, `✏️ <b>یادداشت جدید را ارسال کنید</b>\n\nکاربر: ${id}\n\n(حداکثر ۲۰۰ کاراکتر)`, env, [
      [{ text: "❌ انصراف", callback_data: `user:${id}` }]
    ], true);
  }

  if (data.startsWith("iplimit:")) {
    const [, id, val] = data.split(":");
    return setField(chatId, id, { ipLimit: parseInt(val) }, env, msgId);
  }
  if (data.startsWith("ipmenu:")) return ipLimitMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("ipmanual:")) {
    const id = data.split(":")[1];
    return send(chatId, `✏️ <b>محدودیت IP را ارسال کنید</b>\n\nکاربر: ${id}\n\nعدد بین ۱ تا ۱۰۰`, env, [
      [{ text: "❌ انصراف", callback_data: `user:${id}` }]
    ], true);
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
    return send(chatId, `✏️ <b>حجم کل را به گیگابایت ارسال کنید</b>\n\nکاربر: ${id}\n\nمثال: 10 یا 0 برای نامحدود`, env, [
      [{ text: "❌ انصراف", callback_data: `user:${id}` }]
    ], true);
  }

  if (data.startsWith("daily:")) {
    const [, id, val] = data.split(":");
    return setField(chatId, id, { dailyQuotaBytes: parseInt(val) }, env, msgId);
  }
  if (data.startsWith("dailymenu:")) return dailyMenu(chatId, data.split(":")[1], env, msgId);
  if (data.startsWith("dailymanual:")) {
    const id = data.split(":")[1];
    return send(chatId, `✏️ <b>حجم روزانه را به گیگابایت ارسال کنید</b>\n\nکاربر: ${id}\n\nمثال: 2 یا 0 برای نامحدود`, env, [
      [{ text: "❌ انصراف", callback_data: `user:${id}` }]
    ], true);
  }

  if (data.startsWith("ads:")) return toggleAds(chatId, data.split(":")[1], env, msgId);

  // Nodes
  if (data === "node_create") return showNodeCreate(chatId, env, msgId);
  if (data === "node_create_token") {
    return send(chatId,
      `🔑 <b>ساخت نود جدید</b>\n\n` +
      `۱. روی دکمه زیر کلیک کنید و توکن بسازید.\n` +
      `۲. توکن را کپی کرده و اینجا ارسال کنید.\n\n` +
      `⚠️ <b>توجه:</b> نود بچه نمی‌تواند روی همان اکانت نود مادر ساخته شود.\n\n` +
      `✏️ <b>توکن API کلودفلر را ارسال کنید:</b>`,
      env,
      [
        [{ text: "🔗 ساخت توکن کلودفلر", url: CF_TOKEN_URL }],
        [{ text: "❌ انصراف", callback_data: "nodes_manage" }]
      ],
      true
    );
  }
  if (data === "node_delete") {
    return send(chatId,
      `🗑 <b>حذف نود</b>\n\n` +
      `نام اسکریپت + توکن را با فاصله ارسال کنید.\n\n` +
      `مثال:\n<code>saow-child-98765 YOUR_CF_TOKEN</code>\n\n` +
      `✏️ <b>نام نود و توکن را ارسال کنید:</b>`,
      env,
      [[{ text: "❌ انصراف", callback_data: "nodes_manage" }]],
      true
    );
  }
  if (data === "node_account_status") {
    return send(chatId,
      `📊 <b>وضعیت اکانت کلودفلر</b>\n\n` +
      `توکن API را ارسال کنید.\n\n` +
      `✏️ <b>توکن را برای مشاهده وضعیت اکانت ارسال کنید:</b>`,
      env,
      [[{ text: "❌ انصراف", callback_data: "nodes_manage" }]],
      true
    );
  }

    // حذف نود با دکمه
  if (data.startsWith("del_node:")) {
    const nodeId = data.split(":")[1];
    return confirmDeleteNode(chatId, nodeId, env, msgId);
  }
  if (data.startsWith("del_node_confirm:")) {
    const nodeId = data.split(":")[1];
    return doDeleteNode(chatId, nodeId, env, msgId);
  }

  // آپدیت مادر (با CF_TOKEN ذخیره‌شده)
  if (data === "update_mother") {
    return doUpdateMother(chatId, env, msgId);
  }

  // وضعیت اکانت مادر
  if (data === "mother_account_status") {
    return showMotherAccountStatus(chatId, env, msgId);
  }

  // وضعیت اکانت یک نود فرزند (با توکن ذخیره‌شده)
  if (data.startsWith("node_acc:")) {
    const nodeId = data.split(":")[1];
    return showNodeAccountStatus(chatId, nodeId, env, msgId);
  }
  // Update actions
  
  if (data.startsWith("update_child:")) {
    const nodeId = data.split(":")[1];
    return updateChildNode(chatId, nodeId, env, msgId);
  }
}

// ====================== UI ======================
async function showMain(chatId, env, msgId = null) {
  const [statusData, nodes] = await Promise.all([
    getStatusData(env),
    getHealthyChildren(env),
  ]);
  const alive = nodes.length;
  const text =
    `🎛️ <b>پنل مدیریت Mother</b>\n\n` +
    `🤖 نسخه ربات: <code>${BOT_VERSION}</code>\n` +
    `🖥 نسخه پنل: <code>${VERSION}</code>\n` +
    `🖥 نودها: 🟢 ${alive} فعال\n\n` +
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
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showStatus(chatId, env, msgId = null) {
  const res = await getStatusData(env);
  const realOnline = (res.live || []).filter(u => u.activeIPs > 0);
  let liveText = "";
  if (realOnline.length) {
    liveText = "\n\n🟢 <b>کاربران واقعاً آنلاین:</b>\n";
    for (const u of realOnline) {
      liveText += `• <b>${escape(u.name)}</b> — ${u.activeIPs} IP | ${u.usageGB} GB\n`;
    }
  } else {
    liveText = "\n\n🟢 هیچ کاربر آنلاینی وجود ندارد.";
  }
  const text =
    `📊 <b>وضعیت سیستم</b>\n\n` +
    `🔖 نسخه: <code>${VERSION}</code>\n\n` +
    `👥 <b>کل کاربران:</b> ${res.users}\n` +
    `✅ <b>فعال:</b> ${res.activeUsers}\n` +
    `🟢 <b>آنلاین:</b> ${res.onlineUsers}\n` +
    `🖥 <b>نودها:</b> ${res.nodes}\n` +
    `📈 <b>ترافیک کل:</b> ${res.totalTrafficGB} GB` +
    liveText;
  const kb = [[
    { text: "🔄 بروزرسانی", callback_data: "status" },
    { text: "🔙 بازگشت", callback_data: "main" },
  ]];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showUsers(chatId, page, env, msgId = null) {
  const users = await getUsers(env);
  const full = await Promise.all(users.map(u => buildFullUser(env, u)));
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
    `🛡 بلاک تبلیغات: ${u.blockAds ? "✅" : "❌"}\n` +
    `📝 ${escape(u.notes || "-")}` +
    devices;
  const kb = [
    [
      { text: u.enabled ? "🔴 غیرفعال" : "🟢 فعال", callback_data: `toggle:${u.id}` },
      { text: "🔄 رفرش", callback_data: `user:${u.id}` },
    ],
    [
      { text: "⏰ تاریخ انقضا", callback_data: `expirymenu:${u.id}` },
    ],
    [
      { text: "🌐 محدودیت IP", callback_data: `ipmenu:${u.id}` },
      { text: "⚡ سرعت", callback_data: `speedmenu:${u.id}` },
    ],
    [
      { text: "📦 حجم کل", callback_data: `quotamenu:${u.id}` },
      { text: "📅 حجم روزانه", callback_data: `dailymenu:${u.id}` },
    ],
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

// Submenus (same as before)
async function ipLimitMenu(chatId, id, env, msgId) {
  const text = `🌐 <b>محدودیت IP همزمان</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [{ text: "۱", callback_data: `iplimit:${id}:1` }, { text: "۲", callback_data: `iplimit:${id}:2` }, { text: "۳", callback_data: `iplimit:${id}:3` }],
    [{ text: "۵", callback_data: `iplimit:${id}:5` }, { text: "۱۰", callback_data: `iplimit:${id}:10` }, { text: "۲۰", callback_data: `iplimit:${id}:20` }],
    [{ text: "✏️ ورود دستی", callback_data: `ipmanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function speedMenu(chatId, id, env, msgId) {
  const text = `⚡ <b>محدودیت سرعت</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [{ text: "∞ نامحدود", callback_data: `speed:${id}:0` }, { text: "۱۰۰", callback_data: `speed:${id}:100` }],
    [{ text: "۲۰۰", callback_data: `speed:${id}:200` }, { text: "۵۰۰", callback_data: `speed:${id}:500` }],
    [{ text: "۱ MB", callback_data: `speed:${id}:1024` }, { text: "۲ MB", callback_data: `speed:${id}:2048` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function quotaMenu(chatId, id, env, msgId) {
  const text = `📦 <b>حجم کل</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [{ text: "∞ نامحدود", callback_data: `quota:${id}:0` }, { text: "۱ GB", callback_data: `quota:${id}:1073741824` }],
    [{ text: "۵ GB", callback_data: `quota:${id}:5368709120` }, { text: "۱۰ GB", callback_data: `quota:${id}:10737418240` }],
    [{ text: "۲۰ GB", callback_data: `quota:${id}:21474836480` }, { text: "۵۰ GB", callback_data: `quota:${id}:53687091200` }],
    [{ text: "✏️ ورود دستی (گیگابایت)", callback_data: `quotamanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}
async function dailyMenu(chatId, id, env, msgId) {
  const text = `📅 <b>حجم روزانه</b>\n\nکاربر: <code>${id}</code>`;
  const kb = [
    [{ text: "∞ نامحدود", callback_data: `daily:${id}:0` }, { text: "۵۰۰ MB", callback_data: `daily:${id}:524288000` }],
    [{ text: "۱ GB", callback_data: `daily:${id}:1073741824` }, { text: "۲ GB", callback_data: `daily:${id}:2147483648` }],
    [{ text: "۵ GB", callback_data: `daily:${id}:5368709120` }, { text: "۱۰ GB", callback_data: `daily:${id}:10737418240` }],
    [{ text: "✏️ ورود دستی (گیگابایت)", callback_data: `dailymanual:${id}` }],
    [{ text: "🔙 بازگشت", callback_data: `user:${id}` }],
  ];
  return edit(chatId, msgId, text, env, kb);
}

// Actions
async function setField(chatId, id, fields, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);
  await upsertUser(env, { ...user, ...fields });
  return showUser(chatId, id, env, msgId);
}
async function doToggle(chatId, id, env, msgId) {
  const user = await getUserById(env, id);
  if (!user) return showUser(chatId, id, env, msgId);
  await upsertUser(env, { ...user, enabled: !user.enabled });
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
    [{ text: "📱 دریافت QR Code", callback_data: `qr:${id}` }, { text: "🔙 جزئیات", callback_data: `user:${id}` }],
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
  const kb = [[
    { text: "✅ بله، حذف شود", callback_data: `del:${id}` },
    { text: "❌ انصراف", callback_data: `user:${id}` },
  ]];
  return edit(chatId, msgId, text, env, kb);
}
async function doDelete(chatId, id, env, msgId) {
  const ok = await deleteUser(env, id);
  const text = ok ? `✅ کاربر <code>${id}</code> حذف شد` : "❌ خطا در حذف";
  return edit(chatId, msgId, text, env, [[{ text: "🔙 لیست کاربران", callback_data: "users:0" }]]);
}

// ====================== Nodes UI ======================
async function showNodesManage(chatId, env, msgId = null) {
  const alive = await getHealthyChildren(env);
  const managed = await getManagedNodes(env);
  const text =
    `🖥 <b>مدیریت نودها</b>\n\n` +
    `🟢 آنلاین: ${alive.length}\n` +
    `📦 ثبت‌شده: ${managed.length}\n\n` +
    `از این بخش نودها را مدیریت کنید.`;
  const kb = [
    [{ text: "📊 وضعیت / حذف / آپدیت نودها", callback_data: "nodes" }],
    [{ text: "➕ ساخت نود جدید", callback_data: "node_create" }],
    [{ text: "🔄 آپدیت نود مادر", callback_data: "update_mother" }],
    [{ text: "📈 وضعیت اکانت مادر", callback_data: "mother_account_status" }],
    [{ text: "🔙 بازگشت", callback_data: "main" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showNodeCreate(chatId, env, msgId = null) {
  const text =
    `➕ <b>ساخت نود جدید</b>\n\n` +
    `۱. با دکمه زیر توکن کلودفلر بساز\n` +
    `۲. بعد روی «ارسال توکن» بزن و توکن را بفرست\n\n` +
    `⚠️ نود بچه روی اکانت مادر ساخته نمی‌شود.`;

  const kb = [
    [{ text: "🔗 ساخت توکن کلودفلر", url: CF_TOKEN_URL }],
    [{ text: "📤 ارسال توکن", callback_data: "node_create_token" }],
    [{ text: "🔙 بازگشت", callback_data: "nodes_manage" }],
  ];
  return msgId ? edit(chatId, msgId, text, env, kb) : send(chatId, text, env, kb);
}

async function showNodes(chatId, env, msgId = null) {
  const alive = await getHealthyChildren(env);
  const managed = await getManagedNodes(env);
  const aliveMap = new Map(alive.map(n => [n.id, n]));

  let text = `🖥 <b>وضعیت نودهای فرزند</b>\n\n`;

  if (!managed.length && !alive.length) {
    text += "هیچ نودی ثبت نشده است.";
  } else {
    // اول نودهای مدیریت‌شده (حتی اگر آنلاین نباشن)
    for (const m of managed) {
      const live = alive.find(a =>
        a.id.includes(m.script_name) ||
        (m.url && a.id.includes(m.script_name.replace(/-/g, "")))
      );
      const isOnline = !!live;
      const status = isOnline ? "🟢" : "🔴";
      const lastSeen = live?.lastSeen
        ? new Date(live.lastSeen).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
        : "هنوز آنلاین نشده";

      text += `${status} <b>${escape(m.script_name)}</b>\n`;
      text += ` 🔗 <code>${escape(m.url || "—")}</code>\n`;
      if (isOnline) {
        text += ` نسخه: ${live.version || "—"}\n`;
        text += ` ظرفیت: ${live.capacity ?? "—"}\n`;
        text += ` کاربران فعال: ${live.activeUsers ?? 0}\n`;
      }
      text += ` آخرین آنلاین: ${lastSeen}\n\n`;
    }

    // نودهایی که heartbeat دادن ولی در managed نیستن
    for (const n of alive) {
      const alreadyShown = managed.some(m =>
        n.id.includes(m.script_name) || n.id.includes(m.script_name?.replace(/-/g, ""))
      );
      if (alreadyShown) continue;
      const lastSeen = n.lastSeen
        ? new Date(n.lastSeen).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" })
        : "—";
      text += `🟢 <b>${escape(n.id)}</b> (ثبت‌نشده)\n`;
      text += ` نسخه: ${n.version || "—"}\n`;
      text += ` آخرین آنلاین: ${lastSeen}\n\n`;
    }
  }

  const kb = [];
  for (const m of managed) {
    kb.push([
      { text: `🗑 ${m.script_name}`, callback_data: `del_node:${m.id}` },
      { text: `♻️ نصب مجدد`, callback_data: `update_child:${m.id}` },
      { text: `📈 اکانت`, callback_data: `node_acc:${m.id}` },
    ]);
  }
  kb.push([
    { text: "🔄 بروزرسانی", callback_data: "nodes" },
    { text: "🔙 مدیریت نودها", callback_data: "nodes_manage" },
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
      return send(chatId,
        `❌ <b>خطا: ساخت نود بچه روی اکانت مادر ممنوع است!</b>\n\n` +
        `نود مادر نباید در معرض دسترسی مستقیم کاربران قرار بگیرد و فیلتر نشود.\n` +
        `لطفاً از اکانت Cloudflare دیگری استفاده کنید.`,
        env,
        [[{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }]]
      );
    }

    // دریافت زیردامنه واقعی اکانت
    let accountSubdomain = null;
    try {
      const subRes = await cfFetch(`/accounts/${accountId}/workers/subdomain`, token);
      if (subRes.success && subRes.result?.subdomain) {
        accountSubdomain = subRes.result.subdomain;
      }
    } catch {}
    if (!accountSubdomain) {
      return send(chatId, "❌ نتوانستم زیردامنه workers.dev این اکانت را پیدا کنم.", env);
    }

    // دریافت کد child
    const codeRes = await fetch(CHILD_WORKER_URL);
    if (!codeRes.ok) return send(chatId, `❌ خطا در دریافت کد ورکر فرزند`, env);
    let workerCode = await codeRes.text();

    // Fix MOTHER_URL (هر دو حالت const/let و null/env)
    workerCode = workerCode.replace(
      /(?:const|let|var)\s+MOTHER_URL\s*=\s*[^;]+;?/,
      `let MOTHER_URL = null;`
    );
    workerCode = workerCode.replace(
      /(export\s+default\s*\{\s*async\s+fetch\s*\(\s*request\s*,\s*env\s*,\s*ctx\s*\)\s*\{)/,
      `$1\n    if (!MOTHER_URL) MOTHER_URL = env.MOTHER_URL || "";\n`
    );

    const randomNum = Math.floor(10000 + Math.random() * 90000);
    const scriptName = `saow-child-${randomNum}`;
    const dbName = `saow-db-${randomNum}`;
    const nodeUrl = `https://${scriptName}.${accountSubdomain}.workers.dev`;

    // ساخت D1
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
      return send(chatId, `❌ خطا در آپلود ورکر:\n<code>${escape(JSON.stringify(uploadJson.errors || uploadJson))}</code>`, env);
    }

    // فعال‌سازی subdomain
    try {
      await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, token, {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      });
    } catch {}

    // ذخیره در D1
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

    const successText =
      `✅ <b>نود با موفقیت ساخته شد!</b>\n\n` +
      `📛 نام: <code>${scriptName}</code>\n` +
      `🗄 دیتابیس: <code>${dbName}</code>\n` +
      `🏷 اکانت: ${escape(accountName)}\n` +
      `🔗 آدرس نود:\n<code>${nodeUrl}</code>\n\n` +
      `اگر نود تا چند دقیقه دیگر آنلاین نشد، روی دکمه «باز کردن نود» بزنید تا فعال شود.`;

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

    // حذف D1 مرتبط
    try {
      const dbsRes = await cfFetch(`/accounts/${accountId}/d1/database`, token);
      if (dbsRes.success && dbsRes.result) {
        const match = dbsRes.result.find(db => db.name && db.name.includes(scriptName.replace("saow-child-", "saow-db-")));
        if (match) {
          await cfFetch(`/accounts/${accountId}/d1/database/${match.uuid || match.id}`, token, { method: "DELETE" });
        }
      }
    } catch {}

    // حذف از D1 پنل
    await removeManagedNode(env, scriptName);

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
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)).toISOString().slice(0, 10);
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

// ====================== Update Functions ======================
async function doUpdateMother(chatId, env, msgId) {
  try {
    const token = env.CF_TOKEN;
    const accountId = env.MOTHER_ACCOUNT_ID;
    const scriptName = env.WORKER_NAME;
    const selfUrl = (env.MOTHER_URL || env._SELF_URL || "").replace(/\/$/, "");

    if (!token || !accountId || !scriptName) {
      return edit(chatId, msgId,
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

    // حفظ bindings فعلی
    let existingBindings = [];
    try {
      const settingsRes = await fetch(
        `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}/settings`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
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

    const uploadRes = await fetch(
      `${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: form }
    );
    const uploadData = await uploadRes.json();
    if (!uploadData.success) {
      throw new Error(uploadData.errors?.[0]?.message || JSON.stringify(uploadData));
    }

    return edit(chatId, msgId,
      `✅ <b>نود مادر آپدیت شد</b>\n\n📦 <code>${escape(scriptName)}</code>\n🌐 <code>${escape(selfUrl)}</code>`,
      env,
      [
        [{ text: "🔙 مدیریت نودها", callback_data: "nodes_manage" }],
        [{ text: "🏠 منو", callback_data: "main" }],
      ]
    );
  } catch (err) {
    return edit(chatId, msgId,
      `❌ خطا در آپدیت مادر:\n<code>${escape(err.message)}</code>`,
      env,
      [[{ text: "🔙", callback_data: "nodes_manage" }]]
    );
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

    // 1) حذف Worker
    try {
      await cfFetch(`/accounts/${accountId}/workers/scripts/${oldScript}`, token, { method: "DELETE" });
    } catch (e) {
      console.log("delete worker warning:", e?.message);
    }

    // 2) حذف D1 با id ذخیره‌شده
    if (oldDbId) {
      try {
        const delDb = await cfFetch(
          `/accounts/${accountId}/d1/database/${oldDbId}`,
          token,
          { method: "DELETE" }
        );
        console.log("delete D1 by id:", delDb);
      } catch (e) {
        console.log("delete D1 by id failed:", e?.message);
      }
    }

    // 3) اگر با id پاک نشد، با نام پیدا کن و پاک کن
    try {
      const dbsRes = await cfFetch(`/accounts/${accountId}/d1/database`, token);
      if (dbsRes.success && Array.isArray(dbsRes.result)) {
        for (const db of dbsRes.result) {
          const name = db.name || "";
          const id = db.uuid || db.id;
          // همون db قبلی
          if (oldDbName && name === oldDbName) {
            await cfFetch(`/accounts/${accountId}/d1/database/${id}`, token, { method: "DELETE" });
          }
          // یا هم‌نام اسکریپت
          if (name === oldScript || name === `saow-db-${oldScript.replace("saow-child-", "")}`) {
            await cfFetch(`/accounts/${accountId}/d1/database/${id}`, token, { method: "DELETE" });
          }
        }
      }
    } catch (e) {
      console.log("cleanup D1 by list failed:", e?.message);
    }

    await removeChildByScriptName(env, oldScript);
    await removeManagedNode(env, nodeId);

    // کمی صبر تا حذف در کلودفلر اعمال شود
    await new Promise((r) => setTimeout(r, 2000));

    await edit(chatId, msgId, "⏳ نود قدیمی حذف شد. در حال نصب نسخه جدید...", env);
    return createCloudflareNode(chatId, token, env);
  } catch (e) {
    return edit(chatId, msgId, `❌ خطا: ${escape(e.message)}`, env, [
      [{ text: "🔙", callback_data: "nodes" }],
    ]);
  }
}

async function deleteCloudflareNodeInternal(scriptName, token, env) {
  const accountsRes = await cfFetch("/accounts?per_page=5", token);
  if (!accountsRes.success) return;
  const accountId = accountsRes.result[0].id;
  await cfFetch(`/accounts/${accountId}/workers/scripts/${scriptName}`, token, { method: "DELETE" });
  await removeManagedNode(env, scriptName);
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
  `).bind(
    data.id, data.script_name, data.account_id, data.db_id, data.db_name,
    data.token_encrypted, data.url, data.created_at
  ).run();
}

async function getManagedNodes(env) {
  if (!(await d1Ready(env))) return [];
  try {
    const rows = await env.DB.prepare("SELECT * FROM managed_nodes ORDER BY created_at DESC").all();
    return rows.results || [];
  } catch { return []; }
}

async function getManagedNode(env, id) {
  if (!(await d1Ready(env))) return null;
  try {
    return await env.DB.prepare("SELECT * FROM managed_nodes WHERE id = ?").bind(id).first();
  } catch { return null; }
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
  `).bind(data.account_id, data.token, data.email || "", data.name || "", Date.now()).run();
}

async function getMotherAccountId(env) {
  // می‌توانید account_id مادر را در env یا جدول ذخیره کنید
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
        block_ads INTEGER DEFAULT 1, notes TEXT, created_at INTEGER, updated_at INTEGER
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
        token_encrypted TEXT, url TEXT, created_at INTEGER
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS cf_accounts (
        account_id TEXT PRIMARY KEY, token TEXT, email TEXT, name TEXT, updated_at INTEGER
      )`),
    ]);
    // alters for older tables
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
    ];
    for (const sql of alters) {
      try { await env.DB.prepare(sql).run(); } catch {}
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
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
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
  } catch { return []; }
}
async function getUserByUuid(env, uuid) {
  if (!(await d1Ready(env))) return null;
  try {
    const row = await env.DB.prepare("SELECT * FROM users WHERE uuid = ? COLLATE NOCASE").bind(uuid).first();
    return row ? mapUserRow(row) : null;
  } catch { return null; }
}
async function getUserById(env, id) {
  if (!(await d1Ready(env))) return null;
  try {
    const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
    return row ? mapUserRow(row) : null;
  } catch { return null; }
}
function mapUserRow(row) {
  return {
    id: row.id, name: row.name, uuid: row.uuid, enabled: !!row.enabled, expiry: row.expiry,
    quotaBytes: row.quota_bytes || 0, dailyQuotaBytes: row.daily_quota_bytes || 0,
    speedLimitKBps: row.speed_limit_kbps || 0, ipLimit: row.ip_limit || 1,
    cleanIp: row.clean_ip || "", blockAds: !!row.block_ads, notes: row.notes || "",
    createdAt: row.created_at || 0, updatedAt: row.updated_at || 0,
  };
}
async function upsertUser(env, data) {
  if (!(await d1Ready(env))) return false;
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO users
      (id, name, uuid, enabled, expiry, quota_bytes, daily_quota_bytes, speed_limit_kbps, ip_limit, clean_ip, block_ads, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, uuid=excluded.uuid, enabled=excluded.enabled, expiry=excluded.expiry,
        quota_bytes=excluded.quota_bytes, daily_quota_bytes=excluded.daily_quota_bytes,
        speed_limit_kbps=excluded.speed_limit_kbps, ip_limit=excluded.ip_limit,
        clean_ip=excluded.clean_ip, block_ads=excluded.block_ads, notes=excluded.notes, updated_at=excluded.updated_at
    `).bind(
      data.id, data.name, data.uuid, data.enabled ? 1 : 0, data.expiry || null,
      data.quotaBytes || 0, data.dailyQuotaBytes || 0, data.speedLimitKBps || 0,
      data.ipLimit ?? 1, data.cleanIp || "", data.blockAds ? 1 : 0, data.notes || "", now, now
    ).run();
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
  } catch { return false; }
}
async function resetUsage(env, userId) {
  if (!(await d1Ready(env))) return false;
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM usage_daily WHERE user_id = ?").bind(userId),
    ]);
    return true;
  } catch { return false; }
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
  } catch { return { up: 0, down: 0, total: 0 }; }
}
async function getDailyUsage(env, userId) {
  try {
    if (!(await d1Ready(env))) return { up: 0, down: 0, total: 0 };
    const row = await env.DB.prepare("SELECT up, down, total FROM usage_daily WHERE user_id = ? AND day = ?")
      .bind(userId, todayKey()).first();
    return row || { up: 0, down: 0, total: 0 };
  } catch { return { up: 0, down: 0, total: 0 }; }
}
async function registerChild(env, data) {
  if (!(await d1Ready(env))) return false;
  const now = Date.now();
  try {
    await env.DB.prepare(`
      INSERT INTO children (id, url, version, capacity, last_seen, active_users, healthy, meta)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        url = CASE WHEN excluded.url != '' THEN excluded.url ELSE children.url END,
        version = excluded.version, capacity = excluded.capacity,
        last_seen = excluded.last_seen, active_users = excluded.active_users, healthy = 1
    `).bind(
      data.id, data.url || "", data.version || "", data.capacity || 50,
      now, data.active || 0, JSON.stringify(data.meta || {})
    ).run();
    return true;
  } catch { return false; }
}
async function getHealthyChildren(env) {
  try {
    if (!(await d1Ready(env))) return [];
    const now = Date.now();
    const rows = await env.DB.prepare(`
      SELECT * FROM children WHERE last_seen > ? ORDER BY active_users ASC
    `).bind(now - NODE_TTL).all();
    return (rows.results || []).map(r => ({
      id: r.id, url: r.url, version: r.version, capacity: r.capacity,
      lastSeen: r.last_seen, activeUsers: r.active_users,
    }));
  } catch { return []; }
}

// IP limit
async function touchAndCheckIpLimit(env, user, clientIp, childId = "") {
  const limit = Number(user.ipLimit) > 0 ? Number(user.ipLimit) : 0;
  if (!limit || !clientIp) return { ok: true, online: 0 };
  if (!(await d1Ready(env))) return { ok: true, online: 0 };
  const now = Date.now();
  try {
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?")
      .bind(user.id, now - IP_IDLE_MS).run();
    const existing = await env.DB.prepare("SELECT ip FROM active_ips WHERE user_id = ? AND ip = ?")
      .bind(user.id, clientIp).first();
    if (existing) {
      await env.DB.prepare("UPDATE active_ips SET last_seen = ?, child_id = ? WHERE user_id = ? AND ip = ?")
        .bind(now, childId || "", user.id, clientIp).run();
    } else {
      const cntRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM active_ips WHERE user_id = ?").bind(user.id).first();
      const online = (cntRow && cntRow.c) || 0;
      if (online >= limit) return { ok: false, online, reason: "ip-limit" };
      await env.DB.prepare(`
        INSERT INTO active_ips (user_id, ip, last_seen, child_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, ip) DO UPDATE SET last_seen = excluded.last_seen, child_id = excluded.child_id
      `).bind(user.id, clientIp, now, childId || "").run();
    }
    const finalCnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM active_ips WHERE user_id = ?").bind(user.id).first();
    return { ok: true, online: (finalCnt && finalCnt.c) || 1 };
  } catch {
    return { ok: true, online: 0 };
  }
}
async function getActiveIPCount(env, userId) {
  if (!(await d1Ready(env))) return 0;
  try {
    const now = Date.now();
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?")
      .bind(userId, now - IP_IDLE_MS).run();
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM active_ips WHERE user_id = ?").bind(userId).first();
    return (row && row.c) || 0;
  } catch { return 0; }
}
async function listActiveIps(env, userId) {
  if (!(await d1Ready(env))) return [];
  try {
    const now = Date.now();
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ? AND last_seen < ?")
      .bind(userId, now - IP_IDLE_MS).run();
    const rows = await env.DB.prepare("SELECT ip, last_seen, child_id FROM active_ips WHERE user_id = ? ORDER BY last_seen DESC")
      .bind(userId).all();
    return (rows.results || []).map(r => ({
      ip: r.ip, lastSeen: r.last_seen,
      ageSec: Math.floor((now - r.last_seen) / 1000), childId: r.child_id || "",
    }));
  } catch { return []; }
}
async function clearActiveIps(env, userId) {
  if (!(await d1Ready(env))) return false;
  try {
    await env.DB.prepare("DELETE FROM active_ips WHERE user_id = ?").bind(userId).run();
    return true;
  } catch { return false; }
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
      total: total.total || 0, up: total.up || 0, down: total.down || 0, daily: daily.total || 0,
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
  const full = await Promise.all(users.map(u => buildFullUser(env, u)));
  const nodes = await getHealthyChildren(env);
  const totalTraffic = full.reduce((s, u) => s + (u.usage.total || 0), 0);
  return {
    version: VERSION,
    users: full.length,
    activeUsers: full.filter(u => u.status === "active").length,
    onlineUsers: full.filter(u => u.activeIPs > 0).length,
    nodes: nodes.length,
    totalTrafficGB: +(totalTraffic / 1073741824).toFixed(3),
    live: full.map(u => ({
      id: u.id, name: u.name, status: u.status, activeIPs: u.activeIPs,
      usageGB: u.usage.totalGB, ipLimit: u.ipLimit,
    })),
  };
}

// Domains / IRCF / Subscription (same logic as original mother)
const DOMAINS_URL = "https://raw.githubusercontent.com/isfwic10-arch/cf-domains/refs/heads/main/domains.txt";
const DOMAINS_TTL_MS = 30 * 60 * 1000;
let domainsList = null, domainsListAt = 0, domainsLoading = null;
const IRCF_DOMAINS = [
  { domain: "ipv4.ircf.space", name: "ipv4" }, { domain: "mci.ircf.space", name: "mci" },
  { domain: "mtn.ircf.space", name: "mtn" }, { domain: "mkh.ircf.space", name: "mkh" },
  { domain: "rtl.ircf.space", name: "rtl" }, { domain: "hwb.ircf.space", name: "hwb" },
  { domain: "ast.ircf.space", name: "ast" }, { domain: "sht.ircf.space", name: "sht" },
  { domain: "prs.ircf.space", name: "prs" }, { domain: "mbt.ircf.space", name: "mbt" },
  { domain: "ask.ircf.space", name: "ask" }, { domain: "rsp.ircf.space", name: "rsp" },
  { domain: "afn.ircf.space", name: "afn" }, { domain: "ztl.ircf.space", name: "ztl" },
  { domain: "psm.ircf.space", name: "psm" }, { domain: "arx.ircf.space", name: "arx" },
  { domain: "smt.ircf.space", name: "smt" }, { domain: "shm.ircf.space", name: "shm" },
  { domain: "fnv.ircf.space", name: "fnv" }, { domain: "dbn.ircf.space", name: "dbn" },
  { domain: "apt.ircf.space", name: "apt" }, { domain: "fnp.ircf.space", name: "fnp" },
  { domain: "ryn.ircf.space", name: "ryn" }, { domain: "sbn.ircf.space", name: "sbn" },
  { domain: "ptk.ircf.space", name: "ptk" }, { domain: "atc.ircf.space", name: "atc" },
];
const IRCF_CACHE_TTL = 5 * 60 * 1000;
let ircfCache = null, ircfCacheAt = 0, ircfLoading = null;

function parseDomainsText(text) {
  const list = []; const seen = new Set();
  for (let p of String(text || "").replace(/\r/g, "\n").split(/[\n,;]+/)) {
    p = p.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    if (p.length >= 3 && p.length <= 253 && !/[^a-z0-9.:-]/i.test(p) && !seen.has(p)) {
      seen.add(p); list.push(p);
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
        if (list.length) { domainsList = list; domainsListAt = Date.now(); return list; }
      }
    } catch {}
    return domainsList || [];
  })();
  try { return await domainsLoading; } finally { domainsLoading = null; }
}
async function resolveDomain(domain) {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
      headers: { Accept: "application/dns-json" }, cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answers = (data.Answer || []).filter(a => a.type === 1 && a.data);
    if (!answers.length) return null;
    return answers[Math.floor(Math.random() * answers.length)].data;
  } catch { return null; }
}
async function ensureIrcfResolved() {
  const now = Date.now();
  if (ircfCache && now - ircfCacheAt < IRCF_CACHE_TTL) return ircfCache;
  if (ircfLoading) return ircfLoading;
  ircfLoading = (async () => {
    const results = await Promise.all(IRCF_DOMAINS.map(async item => {
      const ip = await resolveDomain(item.domain);
      return { ...item, ip };
    }));
    const map = {};
    for (const r of results) if (r.ip) map[r.domain] = r.ip;
    if (Object.keys(map).length >= 2) { ircfCache = map; ircfCacheAt = Date.now(); }
    return ircfCache || map;
  })();
  try { return await ircfLoading; } finally { ircfLoading = null; }
}

function formatBytesShort(n) {
  n = Number(n) || 0;
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + "GB";
  if (n >= 1048576) return (n / 1048576).toFixed(0) + "MB";
  return (n / 1024).toFixed(0) + "KB";
}
function daysRemaining(expiry) {
  if (!expiry) return "∞";
  const ms = Date.parse(expiry) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  return String(Math.ceil(ms / 86400000));
}
function buildVlessLink({ ip, port, uuid, host, path, name, fp = "chrome" }) {
  const qs = new URLSearchParams({
    security: "tls", sni: host, fp, type: "ws", path: path || "/", host, encryption: "none", alpn: "http/1.1",
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

  if (isDisabled || isExpired || isQuotaExceeded || isDailyExceeded) {
    if (isDisabled) links.push(buildInfoLink(user.uuid, motherHost, `🚫 حساب شما غیرفعال شده است`));
    if (isExpired) links.push(buildInfoLink(user.uuid, motherHost, `⏰ زمان اشتراک به پایان رسیده`));
    if (isQuotaExceeded) links.push(buildInfoLink(user.uuid, motherHost, `📦 حجم کل تمام شده`));
    if (isDailyExceeded) links.push(buildInfoLink(user.uuid, motherHost, `📅 حجم روزانه تمام شده`));
    links.push(buildInfoLink(user.uuid, motherHost, `🔄 برای تمدید با پشتیبانی در ارتباط باشید`));
    return links.join("\n");
  }

  // ---- انتخاب نود معتبر ----
  // اولویت: managed_nodes (ثبت‌شده در پنل) که آنلاین باشند
  // بعد: هر managed حتی اگر فعلاً heartbeat نداده
  // در آخر: alive بدون managed (سازگاری عقب‌رو)
  const managed = await getManagedNodes(env);
  const alive = await getHealthyChildren(env);

  function hostFromUrl(u) {
    try { return new URL(u).hostname; } catch { return null; }
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

  let selectedUrl = null;

  // 1) managed که آنلاین است
  for (const m of managed) {
    if (!m.url) continue;
    if (alive.some((a) => isAliveMatch(m, a))) {
      selectedUrl = m.url;
      break;
    }
  }

  // 2) اگر هیچ managed آنلاینی نبود، اولین managed با url
  if (!selectedUrl) {
    const withUrl = managed.find((m) => m.url);
    if (withUrl) selectedUrl = withUrl.url;
  }

  // 3) سازگاری: اگر managed خالی بود از alive
  if (!selectedUrl && alive.length && alive[0].url) {
    selectedUrl = alive[0].url;
  }

  if (!selectedUrl) {
    links.push(buildInfoLink(user.uuid, motherHost, `⚠️ هیچ نود فعالی وجود ندارد`));
    return links.join("\n");
  }

  let childHost = hostFromUrl(selectedUrl);
  if (!childHost) {
    links.push(buildInfoLink(user.uuid, motherHost, `⚠️ نود نامعتبر`));
    return links.join("\n");
  }

  const activeCount = await getActiveIPCount(env, user.id);
  links.push(buildVlessLink({
    ip: "127.0.0.1",
    port: 1,
    uuid: user.uuid,
    host: motherHost,
    path: "/",
    name: `📋 ${formatBytesShort(total.total)} / ${user.quotaBytes > 0 ? formatBytesShort(user.quotaBytes) : "∞"} | ${daysRemaining(user.expiry)}d | IP:${activeCount}/${user.ipLimit}`,
  }));

  let gh = [];
  try { gh = await ensureDomainsList(); } catch {}
  const preferred = (gh || []).slice(0, 3);
  const ports = [443, 8443, 2053];
  const fps = ["chrome", "firefox", "safari"];
  for (let i = 0; i < preferred.length; i++) {
    links.push(buildVlessLink({
      ip: preferred[i],
      port: ports[i % ports.length],
      uuid: user.uuid,
      host: childHost,
      path: `/?u=${user.id}`,
      name: `⭐ ${base} | P${i + 1}`,
      fp: fps[i % fps.length],
    }));
  }

  let resolved = {};
  try { resolved = await ensureIrcfResolved(); } catch {}
  let idx = 0;
  const ircfFps = ["chrome", "firefox", "safari", "edge", "random"];
  for (const item of IRCF_DOMAINS) {
    const ip = resolved[item.domain];
    if (!ip) continue;
    links.push(buildVlessLink({
      ip,
      port: 443,
      uuid: user.uuid,
      host: childHost,
      path: `/?u=${user.id}`,
      name: `⚡ ${base} | ${item.name}`,
      fp: ircfFps[idx % ircfFps.length],
    }));
    idx++;
  }

  return links.join("\n");
}

// ====================== API for Child Nodes ======================
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

    if (path === "/node/report" && request.method === "POST") {
      const authErr = requireAuth(request);
      if (authErr) return authErr;
      const body = await request.json();
      if (!body?.type || !body?.child_id) return json({ ok: false, err: "bad request" }, 400);
      if (body.type === "heartbeat") {
        await registerChild(env, {
          id: body.child_id || body.id, url: body.url || "", version: body.version || "",
          capacity: body.capacity || 100, active: body.active || 0, meta: body.meta || {},
        });
        return json({ ok: true });
      }
      const user = await getUserByUuid(env, body.uuid);
      if (!user) return json({ ok: false, action: "close", reason: "user not found" });
      if (body.type === "connect") {
        const ipCheck = await touchAndCheckIpLimit(env, user, body.ip, body.child_id);
        if (!ipCheck.ok) return json({ ok: true, action: "close", reason: `IP limit exceeded`, enabled: false });
        if (!user.enabled) return json({ ok: true, action: "close", reason: "disabled", enabled: false });
        const total = await getUsage(env, user.id);
        const daily = await getDailyUsage(env, user.id);
        if (user.quotaBytes > 0 && total.total >= user.quotaBytes) return json({ ok: true, action: "close", reason: "quota exceeded", enabled: false });
        if (user.dailyQuotaBytes > 0 && daily.total >= user.dailyQuotaBytes) return json({ ok: true, action: "close", reason: "daily quota exceeded", enabled: false });
        return json({
          ok: true, enabled: true, online: ipCheck.online,
          config: { enabled: user.enabled, speedLimitKBps: user.speedLimitKBps, blockAds: user.blockAds, ipLimit: user.ipLimit, quotaBytes: user.quotaBytes, dailyQuotaBytes: user.dailyQuotaBytes },
        });
      }
      if (body.type === "disconnect") {
        if ((body.up || 0) + (body.down || 0) > 0) await addUsage(env, user.id, body.up || 0, body.down || 0);
        return json({ ok: true });
      }
      if (body.type === "usage") {
        const up = body.up || 0, down = body.down || 0;
        if (up + down > 0) await addUsage(env, user.id, up, down);
        if (body.ip) await touchAndCheckIpLimit(env, user, body.ip, body.child_id);
        const total = await getUsage(env, user.id);
        const daily = await getDailyUsage(env, user.id);
        let action = "continue", reason = "", enabled = user.enabled;
        if (!user.enabled) { action = "close"; reason = "disabled"; enabled = false; }
        else if (user.quotaBytes > 0 && total.total >= user.quotaBytes) {
          action = "close"; reason = "quota exceeded";
          await upsertUser(env, { ...user, enabled: false, notes: "Auto disabled: quota exceeded" });
          enabled = false;
        } else if (user.dailyQuotaBytes > 0 && daily.total >= user.dailyQuotaBytes) {
          action = "close"; reason = "daily quota exceeded"; enabled = false;
        }
        return json({
          ok: true, action, reason, enabled,
          usage: { total: total.total, daily: daily.total },
          config: { enabled, speedLimitKBps: user.speedLimitKBps, blockAds: user.blockAds, ipLimit: user.ipLimit, quotaBytes: user.quotaBytes, dailyQuotaBytes: user.dailyQuotaBytes },
        });
      }
      return json({ ok: false, err: "unknown type" }, 400);
    }

    // بقیه مسیرهای API برای سازگاری (اختیاری)
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
      const list = await Promise.all(users.map(u => buildFullUser(env, u)));
      return json({ ok: true, users: list, total: list.length, version: VERSION });
    }

    return json({ ok: false, err: "not found" }, 404);
  } catch (e) {
    console.error("api error", e);
    return json({ ok: false, err: "internal" }, 500);
  }
}

// ====================== Helpers ======================

async function removeChildByScriptName(env, scriptName) {
  if (!(await d1Ready(env)) || !scriptName) return;
  try {
    // idهای heartbeat شبیه: child-saow-child-84598-isfwic1-workers-dev
    await env.DB.prepare(
      `DELETE FROM children WHERE id LIKE ? OR id LIKE ? OR url LIKE ?`
    ).bind(
      `%${scriptName}%`,
      `%${scriptName.replace(/-/g, "")}%`,
      `%${scriptName}%`
    ).run();
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

async function send(chatId, text, env, keyboard = null, forceReply = false) {
  const body = {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
  };
  if (forceReply) body.reply_markup = { force_reply: true, selective: true };
  else if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`${TG}/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
async function edit(chatId, msgId, text, env, keyboard = null) {
  const body = { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  await fetch(`${TG}/bot${env.BOT_TOKEN}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
async function answer(id, text, env, alert = false) {
  await fetch(`${TG}/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text: text || "", show_alert: alert }),
  });
}
function escape(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
