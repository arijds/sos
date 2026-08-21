// ============================================================================
//  ربات دانلودر تلگرام برای روبیکا  —  نسخه نهایی با دکمه و دانلود بهتر
// ============================================================================

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TelegramClient, Api } from "telegram/index.js";
import { StringSession } from "telegram/sessions/index.js";
import FormData from "form-data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, "bot-config.json");
const SESSION_PATH = path.join(__dirname, "tg-session.json");
const DATA_PATH = path.join(__dirname, "bot-data.json");
const RUBIKA_BASE_URL = "https://botapi.rubika.ir/v3";

function log(level, ...args) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  const prefix = `[${time}] [${level.toUpperCase()}]`;
  if (level === "error") console.error(prefix, ...args);
  else console.log(prefix, ...args);
}

// ----------------------------------------------------------------------------
// وضعیت و پیکربندی
// ----------------------------------------------------------------------------
const state = {
  running: false,
  pollTimeout: null,
  offsetId: null,
  messageCount: 0,
  lastError: null,
  botInfo: null,
  isTgLoggedIn: false,
  tgClient: null,
  tgPhoneCodeHash: null,
  userStates: {},
  savedChannels: [],
  tgConnecting: false
};

let config = {
  rubikaToken: "",
  tgApiId: "",
  tgApiHash: "",
  tgPhone: ""
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
    if (fs.existsSync(DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
      state.savedChannels = data.savedChannels || [];
    }
  } catch (err) { log("error", "خطا در خواندن فایل‌ها:", err.message); }
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8"); return true; } 
  catch (err) { log("error", "خطا در ذخیره تنظیمات:", err.message); return false; }
}

function saveData() {
  try { fs.writeFileSync(DATA_PATH, JSON.stringify({ savedChannels: state.savedChannels }, null, 2), "utf-8"); } 
  catch (err) { log("error", "خطا در ذخیره داده‌ها:", err.message); }
}

function saveTgSession() {
  try {
    if (state.tgClient) {
      fs.writeFileSync(SESSION_PATH, JSON.stringify({ session: state.tgClient.session.save() }, "utf-8"));
    }
  } catch (err) { log("error", "خطا در ذخیره سشن تلگرام:", err.message); }
}

loadConfig();

// ----------------------------------------------------------------------------
// ارتباط با API روبیکا
// ----------------------------------------------------------------------------
async function rubikaCall(method, body = {}, token = config.rubikaToken) {
  if (!token) throw new Error("توکن ربات روبیکا تنظیم نشده است.");
  const url = `${RUBIKA_BASE_URL}/${token}/${method}`;
  try {
    const res = await axios.post(url, body, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
    return res.data;
  } catch (err) {
    throw new Error(`خطا در متد ${method}: ${err.response?.data?.status_det || err.message}`);
  }
}

async function sendMessage(chatId, text, keyboard = null) {
  const body = { chat_id: String(chatId), text };
  if (keyboard && keyboard.length > 0) {
    body.reply_markup = JSON.stringify({ 
      keyboard: keyboard,
      resize_keyboard: true,
      one_time_keyboard: false
    });
  }
  return rubikaCall("sendMessage", body);
}

async function sendMediaToRubika(chatId, buffer, type, caption = "") {
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    
    if (type === 'photo') {
      form.append('photo', buffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
    } else {
      form.append('document', buffer, { filename: 'file', contentType: 'application/octet-stream' });
    }
    
    if (caption) form.append('caption', caption.substring(0, 1000));

    const url = `${RUBIKA_BASE_URL}/${config.rubikaToken}/send${type === 'photo' ? 'Photo' : 'Document'}`;
    await axios.post(url, form, { 
      headers: form.getHeaders(), 
      maxBodyLength: Infinity, 
      maxContentLength: Infinity, 
      timeout: 60000 
    });
    return true;
  } catch (err) {
    log("error", `خطا در ارسال ${type}:`, err.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// مدیریت کلاینت تلگرام
// ----------------------------------------------------------------------------
async function initTgClient() {
  if (!config.tgApiId || !config.tgApiHash) {
    log("warn", "تنظیمات تلگرام کامل نیست");
    return false;
  }
  
  state.tgConnecting = true;
  log("info", "شروع اتصال به تلگرام...");
  
  let sessionStr = '';
  if (fs.existsSync(SESSION_PATH)) {
    try { sessionStr = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8")).session || ''; } catch(e) {}
  }

  try {
    state.tgClient = new TelegramClient(
      new StringSession(sessionStr), 
      parseInt(config.tgApiId), 
      config.tgApiHash, 
      { connectionRetries: 3, timeout: 10 }
    );
    
    await state.tgClient.connect();
    state.isTgLoggedIn = await state.tgClient.isUserAuthorized();
    state.tgConnecting = false;
    log("info", `وضعیت تلگرام: ${state.isTgLoggedIn ? 'متصل' : 'نیاز به لاگین'}`);
    return state.isTgLoggedIn;
  } catch (err) {
    state.tgConnecting = false;
    log("error", "خطا در اتصال به تلگرام:", err.message);
    state.isTgLoggedIn = false;
    return false;
  }
}

async function sendTgCode(chatId) {
  try {
    const result = await state.tgClient.sendCode({ apiId: parseInt(config.tgApiId), apiHash: config.tgApiHash }, config.tgPhone);
    state.tgPhoneCodeHash = result.phoneCodeHash;
    state.userStates[chatId] = { step: 'waiting_for_tg_code' };
    await sendMessage(chatId, "🔑 کد تایید به تلگرام شما ارسال شد.\nلطفاً کد 5 رقمی را همینجا ارسال کنید:");
  } catch (err) {
    await sendMessage(chatId, "❌ خطا در ارسال کد: " + err.message);
  }
}

async function verifyTgCode(chatId, code) {
  try {
    await state.tgClient.invoke(new Api.auth.SignIn({
      phoneNumber: config.tgPhone,
      phoneCodeHash: state.tgPhoneCodeHash,
      phoneCode: code
    }));
    state.isTgLoggedIn = true;
    saveTgSession();
    delete state.userStates[chatId];
    await sendMessage(chatId, "✅ با موفقیت به تلگرام متصل شدیم!\n\nاز دستورات زیر استفاده کنید:\n\n/start - منوی اصلی\n/search - جستجو در چنل\n/fast - دانلود سریع\n/saved - چنل‌های ذخیره شده");
  } catch (err) {
    await sendMessage(chatId, "❌ کد اشتباه است یا خطایی رخ داد: " + err.message);
  }
}

// ----------------------------------------------------------------------------
// دانلود بهتر مدیا از تلگرام
// ----------------------------------------------------------------------------
async function downloadMediaFromTg(msg) {
  try {
    // روش 1: دانلود مستقیم
    const buffer = await state.tgClient.downloadMedia(msg, {
      workers: 1,
      progressCallback: () => {}
    });
    
    if (buffer && Buffer.isBuffer(buffer)) {
      return buffer;
    }
    
    // روش 2: اگر buffer نبود، تبدیل به buffer
    if (buffer) {
      return Buffer.from(buffer);
    }
    
    return null;
  } catch (err) {
    log("error", "خطا در دانلود مدیا:", err.message);
    return null;
  }
}

// ----------------------------------------------------------------------------
// منطق دانلود از تلگرام (از آخر به اول)
// ----------------------------------------------------------------------------
async function fetchAndSend(chatId, channelLink, count, isFast) {
  try {
    const username = channelLink.replace(/https?:\/\/t\.me\//, '').replace('/', '');
    const entity = await state.tgClient.getEntity(username);
    
    await sendMessage(chatId, `⏳ در حال دریافت ${count} پیام از ${entity.title}...`);
    let messages = await state.tgClient.getMessages(entity, { limit: count });

    if (messages.length === 0) {
      await sendMessage(chatId, "❌ پیامی یافت نشد.");
      return;
    }

    // ✅ معکوس کردن ترتیب پیام‌ها (از آخر به اول)
    messages = messages.reverse();

    await sendMessage(chatId, `📥 شروع ارسال ${messages.length} پیام (از جدیدترین به قدیمی‌ترین)...`);

    let successCount = 0;
    let failCount = 0;

    for (const msg of messages) {
      const caption = msg.message || '';
      let sent = false;

      try {
        if (msg.photo) {
          const buffer = await downloadMediaFromTg(msg);
          if (buffer) {
            sent = await sendMediaToRubika(chatId, buffer, 'photo', caption);
          }
        } else if (msg.document) {
          const buffer = await downloadMediaFromTg(msg);
          if (buffer) {
            sent = await sendMediaToRubika(chatId, buffer, 'document', caption);
          }
        } else if (msg.video) {
          const buffer = await downloadMediaFromTg(msg);
          if (buffer) {
            sent = await sendMediaToRubika(chatId, buffer, 'document', caption);
          }
        } else if (caption) {
          await sendMessage(chatId, caption);
          sent = true;
        }

        if (sent) successCount++;
        else failCount++;
      } catch (err) {
        log("error", `خطا در ارسال پیام ${msg.id}:`, err.message);
        failCount++;
        if (caption) {
          await sendMessage(chatId, `⚠️ [متن پیام]:\n${caption}`);
        }
      }

      // تاخیر کوتاه برای جلوگیری از rate limit
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await sendMessage(chatId, `✅ ارسال پیام‌ها تمام شد!\n\n✅ موفق: ${successCount}\n❌ ناموفق: ${failCount}`);
    
    if (!isFast) {
      state.userStates[chatId] = { step: 'ask_save', link: channelLink, name: entity.title };
      await sendMessage(chatId, "آیا مایل به ذخیره این چنل هستید؟\nبله برای ذخیره /save را ارسال کنید\nیا /menu برای بازگشت به منو");
    }
  } catch (err) {
    await sendMessage(chatId, "❌ خطا: " + err.message);
  }
}

// ----------------------------------------------------------------------------
// مدیریت دستورات با دکمه
// ----------------------------------------------------------------------------
async function handleTextMessage(chatId, text) {
  const userState = state.userStates[chatId];
  const trimmedText = text.trim();

  // منوی اصلی
  const mainMenu = [
    ["🔍 جستجو در چنل"],
    ["⚡ دانلود سریع"],
    ["💾 چنل‌های ذخیره شده"]
  ];

  const backMenu = [["🏠 منوی اصلی"]];

  if (trimmedText === "/start" || trimmedText === "🏠 منوی اصلی") {
    if (!state.isTgLoggedIn) {
      if (state.tgConnecting) {
        await sendMessage(chatId, "⏳ در حال اتصال به تلگرام...\nلطفاً چند لحظه صبر کنید و دوباره /start را بفرستید.");
      } else {
        await sendMessage(chatId, "⚠️ ابتدا باید به تلگرام متصل شوید.\nلطفاً صبر کنید...");
        await sendTgCode(chatId);
      }
    } else {
      delete state.userStates[chatId];
      await sendMessage(chatId, "👋 خوش آمدید!\n\nاز دکمه‌های زیر یا دستورات استفاده کنید:", mainMenu);
    }
  }
  else if (trimmedText === "/menu") {
    delete state.userStates[chatId];
    await sendMessage(chatId, "🏠 منوی اصلی:", mainMenu);
  }
  else if (trimmedText === "/search" || trimmedText === "🔍 جستجو در چنل") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "❌ ابتدا باید لاگین کنید.\n/start را بفرستید.");
      return;
    }
    state.userStates[chatId] = { step: 'waiting_for_link', action: 'search' };
    await sendMessage(chatId, "🔗 لینک چنل تلگرام را ارسال کنید:\n(مثال: https://t.me/durov)", backMenu);
  }
  else if (trimmedText === "/fast" || trimmedText === "⚡ دانلود سریع") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "❌ ابتدا باید لاگین کنید.\n/start را بفرستید.");
      return;
    }
    state.userStates[chatId] = { step: 'waiting_for_link', action: 'fast' };
    await sendMessage(chatId, "🔗 لینک چنل تلگرام را برای دانلود سریع ارسال کنید:", backMenu);
  }
  else if (trimmedText === "/saved" || trimmedText === "💾 چنل‌های ذخیره شده") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "❌ ابتدا باید لاگین کنید.\n/start را بفرستید.");
      return;
    }
    if (state.savedChannels.length === 0) {
      await sendMessage(chatId, "💾 لیست چنل‌های ذخیره شده خالی است.", mainMenu);
      return;
    }
    let msgText = "💾 چنل‌های ذخیره شده:\n\n";
    const kb = [];
    state.savedChannels.forEach((ch, i) => {
      msgText += `${i + 1}. ${ch.name}\n`;
      kb.push([`📥 ${ch.name}`]);
    });
    kb.push(["🏠 منوی اصلی"]);
    state.userStates[chatId] = { step: 'showing_saved' };
    await sendMessage(chatId, msgText, kb);
  }
  else if (trimmedText === "/save") {
    if (userState?.step === 'ask_save') {
      if (!state.savedChannels.find(c => c.link === userState.link)) {
        state.savedChannels.push({ link: userState.link, name: userState.name });
        saveData();
        await sendMessage(chatId, "✅ چنل ذخیره شد!", mainMenu);
      } else {
        await sendMessage(chatId, "⚠️ این چنل قبلاً ذخیره شده.", mainMenu);
      }
      delete state.userStates[chatId];
    } else {
      await sendMessage(chatId, "❌ ابتدا باید یک چنل را جستجو کنید.\n/search را بفرستید.");
    }
  }
  else if (userState?.step === 'waiting_for_tg_code') {
    await verifyTgCode(chatId, trimmedText);
  }
  else if (userState?.step === 'waiting_for_link') {
    userState.link = trimmedText;
    if (userState.action === 'fast') {
      delete state.userStates[chatId];
      await fetchAndSend(chatId, userState.link, 50, true);
      await sendMessage(chatId, "\nمنوی اصلی:", mainMenu);
    } else {
      userState.step = 'waiting_for_count';
      await sendMessage(chatId, "🔢 چند تا از آخرین پیام‌ها رو بفرستم؟ (مثلاً 10)", backMenu);
    }
  }
  else if (userState?.step === 'waiting_for_count') {
    const count = parseInt(trimmedText);
    if (isNaN(count) || count < 1) {
      await sendMessage(chatId, "❌ عدد معتبر وارد کنید.", backMenu);
      return;
    }
    delete state.userStates[chatId];
    await fetchAndSend(chatId, userState.link, count, false);
  }
  else if (userState?.step === 'showing_saved') {
    const chName = trimmedText.replace("📥 ", "");
    const ch = state.savedChannels.find(c => c.name === chName);
    if (ch) {
      state.userStates[chatId] = { step: 'waiting_for_count', link: ch.link };
      await sendMessage(chatId, "🔢 چند تا از آخرین پیام‌ها رو بفرستم؟ (عدد بفرست)", backMenu);
    }
  }
  else {
    await sendMessage(chatId, "❓ دستور نامعتبر.\n\n/start برای مشاهده دستورات", mainMenu);
  }
}

function extractMessageFromUpdate(update) {
  const nm = update.new_message || update.updated_message || null;
  const chatId = update.chat_id || nm?.chat_id;
  const text = nm?.text ?? update.text ?? "";
  const senderType = nm?.sender_type ?? update.sender_type ?? "";
  return { chatId: String(chatId), text, senderType };
}

// ----------------------------------------------------------------------------
// حلقه‌ی Polling
// ----------------------------------------------------------------------------
async function pollOnce() {
  try {
    const data = await rubikaCall("getUpdates", { limit: 100, offset_id: state.offsetId });
    const updates = data?.data?.updates || data?.updates || [];
    const nextOffsetId = data?.data?.next_offset_id || data?.next_offset_id;

    for (const update of updates) {
      const { chatId, text, senderType } = extractMessageFromUpdate(update);
      if (!chatId || senderType === "Bot") continue;
      
      state.messageCount += 1;
      if (text) await handleTextMessage(chatId, text);
    }

    if (nextOffsetId) state.offsetId = nextOffsetId;
    state.lastError = null;
  } catch (err) {
    log("error", "خطا در getUpdates:", err.message);
    state.lastError = err.message;
  } finally {
    if (state.running) state.pollTimeout = setTimeout(pollOnce, 3000);
  }
}

// ----------------------------------------------------------------------------
// اپلیکیشن Express و پنل مدیریت
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.setHeader("Content-Type", "text/html; charset=utf-8").send(renderAdminPage()));

app.get("/api/status", (req, res) => {
  res.json({
    running: state.running, 
    messageCount: state.messageCount, 
    lastError: state.lastError,
    botInfo: state.botInfo, 
    hasRubikaToken: Boolean(config.rubikaToken),
    hasTgConfig: Boolean(config.tgApiId && config.tgApiHash && config.tgPhone),
    isTgLoggedIn: state.isTgLoggedIn, 
    tgConnecting: state.tgConnecting,
    savedCount: state.savedChannels.length
  });
});

app.post("/api/config", (req, res) => {
  const { rubikaToken, tgApiId, tgApiHash, tgPhone } = req.body || {};
  if (rubikaToken) config.rubikaToken = rubikaToken.trim();
  if (tgApiId) config.tgApiId = tgApiId.trim();
  if (tgApiHash) config.tgApiHash = tgApiHash.trim();
  if (tgPhone) config.tgPhone = tgPhone.trim();
  res.json({ ok: saveConfig(), message: "تنظیمات ذخیره شد." });
});

app.post("/api/start", async (req, res) => {
  try {
    if (state.running) {
      return res.json({ ok: true, message: "ربات از قبل در حال اجراست." });
    }
    if (!config.rubikaToken) {
      return res.status(400).json({ ok: false, message: "ابتدا توکن ربات روبیکا را وارد کنید." });
    }
    
    try {
      const meRes = await rubikaCall("getMe", {});
      state.botInfo = meRes?.data?.bot || meRes?.bot || null;
    } catch (err) {
      return res.status(400).json({ ok: false, message: "توکن روبیکا نامعتبر است: " + err.message });
    }
    
    state.running = true;
    state.messageCount = 0;
    log("info", "ربات شروع به کار کرد.");
    pollOnce();
    
    initTgClient().then(() => {
      log("info", "اتصال تلگرام در پس‌زمینه کامل شد");
    }).catch(err => {
      log("error", "خطا در اتصال تلگرام:", err.message);
    });
    
    res.json({ ok: true, message: "ربات راه‌اندازی شد. اتصال تلگرام در پس‌زمینه در حال انجام است." });
  } catch (err) {
    log("error", "خطا در راه‌اندازی:", err.message);
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post("/api/stop", (req, res) => {
  state.running = false;
  if (state.pollTimeout) clearTimeout(state.pollTimeout);
  log("info", "ربات متوقف شد.");
  res.json({ ok: true, message: "ربات متوقف شد." });
});

app.listen(PORT, () => log("info", `پنل روی http://localhost:${PORT} اجراست.`));

// ----------------------------------------------------------------------------
// رندر HTML پنل مدیریت
// ----------------------------------------------------------------------------
function renderAdminPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>پنل دانلودر تلگرام</title>
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: #6366f1; --green: #22c55e; --red: #ef4444; --yellow: #eab308; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Vazirmatn", Tahoma, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 24px; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: var(--muted); margin-bottom: 24px; font-size: 14px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 20px; margin-bottom: 18px; }
  .card h2 { font-size: 15px; margin: 0 0 14px 0; color: var(--muted); font-weight: 600; }
  label { display: block; font-size: 13px; margin-bottom: 6px; color: var(--muted); }
  input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: #0b1220; color: var(--text); font-size: 14px; margin-bottom: 14px; font-family: inherit; }
  input:focus { outline: 1px solid var(--accent); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  button { cursor: pointer; border: none; border-radius: 8px; padding: 10px 16px; font-size: 13px; font-weight: 600; font-family: inherit; transition: opacity 0.15s; }
  button:hover { opacity: 0.9; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-secondary { background: #334155; color: var(--text); }
  .btn-success { background: var(--green); color: #052e12; }
  .btn-danger { background: var(--red); color: #3a0a0a; }
  .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-on { background: rgba(34,197,94,0.15); color: var(--green); }
  .status-on .dot { background: var(--green); }
  .status-off { background: rgba(239,68,68,0.15); color: var(--red); }
  .status-off .dot { background: var(--red); }
  .status-connecting { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .status-connecting .dot { background: var(--yellow); animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px; margin-top: 10px; }
  .info-grid div span { color: var(--muted); display: block; font-size: 11px; margin-bottom: 2px; }
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--card); border: 1px solid var(--border); padding: 10px 18px; border-radius: 10px; font-size: 13px; display: none; max-width: 90%; }
  #toast.show { display: block; }
  #toast.ok { border-color: var(--green); }
  #toast.error { border-color: var(--red); }
  .commands { background: #0b1220; padding: 15px; border-radius: 8px; margin-top: 10px; font-family: monospace; font-size: 13px; }
  .commands div { margin: 5px 0; }
</style>
</head>
<body>
<div class="container">
  <h1>📥 پنل دانلودر تلگرام برای روبیکا</h1>
  <div class="subtitle">تنظیمات ربات، تلگرام و مدیریت وضعیت</div>

  <div class="card">
    <h2>وضعیت سیستم</h2>
    <span id="statusBadge" class="status-badge status-off"><span class="dot"></span> در حال بارگذاری...</span>
    <div class="info-grid" id="infoGrid"></div>
  </div>

  <div class="card">
    <h2>تنظیمات ربات روبیکا</h2>
    <label>توکن ربات روبیکا</label>
    <input id="rubikaToken" type="text" placeholder="توکن ربات روبیکا" />
  </div>

  <div class="card">
    <h2>تنظیمات اکانت تلگرام</h2>
    <label>API ID</label>
    <input id="tgApiId" type="text" placeholder="عدد API ID" />
    <label>API Hash</label>
    <input id="tgApiHash" type="text" placeholder="کاراکترهای API Hash" />
    <label>شماره تلفن تلگرام (با کد کشور)</label>
    <input id="tgPhone" type="text" placeholder="+989xxxxxxxxx" />
  </div>

  <div class="card">
    <h2>عملیات</h2>
    <div class="row">
      <button class="btn-primary" onclick="saveConfig()">💾 ذخیره تنظیمات</button>
      <button class="btn-success" onclick="startBot()">▶️ راه‌اندازی ربات</button>
      <button class="btn-danger" onclick="stopBot()">⏹ توقف ربات</button>
    </div>
  </div>

  <div class="card">
    <h2>دستورات و دکمه‌های ربات</h2>
    <div class="commands">
      <div><strong>/start</strong> یا <strong>🏠 منوی اصلی</strong> - منوی اصلی</div>
      <div><strong>/search</strong> یا <strong>🔍 جستجو در چنل</strong> - جستجو</div>
      <div><strong>/fast</strong> یا <strong>⚡ دانلود سریع</strong> - دانلود سریع</div>
      <div><strong>/saved</strong> یا <strong>💾 چنل‌های ذخیره شده</strong> - لیست ذخیره‌ها</div>
      <div><strong>/save</strong> - ذخیره چنل فعلی</div>
      <div><strong>/menu</strong> - بازگشت به منو</div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
  function showToast(msg, ok) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show ' + (ok ? 'ok' : 'error');
    setTimeout(() => { el.className = ''; }, 4000);
  }

  async function saveConfig() {
    try {
      const res = await fetch('/api/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rubikaToken: document.getElementById('rubikaToken').value,
          tgApiId: document.getElementById('tgApiId').value,
          tgApiHash: document.getElementById('tgApiHash').value,
          tgPhone: document.getElementById('tgPhone').value
        })
      });
      const data = await res.json();
      showToast(data.message, data.ok);
      refreshStatus();
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }

  async function startBot() {
    try {
      const res = await fetch('/api/start', { method: 'POST' });
      const data = await res.json();
      showToast(data.message, data.ok);
      refreshStatus();
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }

  async function stopBot() {
    try {
      const res = await fetch('/api/stop', { method: 'POST' });
      const data = await res.json();
      showToast(data.message, data.ok);
      refreshStatus();
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }

  async function refreshStatus() {
    try {
      const s = await (await fetch('/api/status')).json();
      const badge = document.getElementById('statusBadge');
      
      if (s.running) {
        badge.className = 'status-badge status-on';
        badge.innerHTML = '<span class="dot"></span> در حال اجرا';
      } else {
        badge.className = 'status-badge status-off';
        badge.innerHTML = '<span class="dot"></span> متوقف';
      }

      let tgStatus = '❌ متصل نیست';
      if (s.tgConnecting) {
        tgStatus = '<span style="color: #eab308;">⏳ در حال اتصال...</span>';
      } else if (s.isTgLoggedIn) {
        tgStatus = '✅ متصل';
      }

      document.getElementById('infoGrid').innerHTML = \`
        <div><span>پیام‌های پردازش شده</span>\${s.messageCount}</div>
        <div><span>چنل‌های ذخیره شده</span>\${s.savedCount}</div>
        <div><span>توکن روبیکا</span>\${s.hasRubikaToken ? '✅' : '❌'}</div>
        <div><span>تنظیمات تلگرام</span>\${s.hasTgConfig ? '✅' : '❌'}</div>
        <div><span>وضعیت تلگرام</span>\${tgStatus}</div>
        <div><span>آخرین خطا</span>\${s.lastError || '-'}</div>
      \`;
    } catch (e) { console.error(e); }
  }

  refreshStatus();
  setInterval(refreshStatus, 3000);
</script>
</body>
</html>`;
}
