// ============================================================================
//  ربات پیشرفته روبیکا - نسخه کامل
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
  tgConnecting: false,
  channelListeners: new Map() // listener برای چنل‌های تلگرام
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
    } else if (type === 'video') {
      form.append('video', buffer, { filename: 'video.mp4', contentType: 'video/mp4' });
    } else {
      form.append('document', buffer, { filename: 'file', contentType: 'application/octet-stream' });
    }
    
    if (caption) form.append('caption', caption.substring(0, 1000));

    const url = `${RUBIKA_BASE_URL}/${config.rubikaToken}/send${type.charAt(0).toUpperCase() + type.slice(1)}`;
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
    await sendMessage(chatId, "✅ با موفقیت به تلگرام متصل شدیم!\n\nاز دستورات زیر استفاده کنید:\n\n/start - منوی اصلی");
  } catch (err) {
    await sendMessage(chatId, "❌ کد اشتباه است یا خطایی رخ داد: " + err.message);
  }
}

// ----------------------------------------------------------------------------
// دریافت لیست چنل‌ها و گروه‌های تلگرام
// ----------------------------------------------------------------------------
async function getTgChannels() {
  try {
    const dialogs = await state.tgClient.getDialogs({});
    const channels = [];
    
    for (const dialog of dialogs) {
      if (dialog.isChannel && dialog.entity.adminRights) {
        channels.push({
          id: dialog.id,
          title: dialog.title,
          username: dialog.entity.username,
          entity: dialog.entity
        });
      }
    }
    
    return channels;
  } catch (err) {
    log("error", "خطا در دریافت چنل‌ها:", err.message);
    return [];
  }
}

async function getTgGroups() {
  try {
    const dialogs = await state.tgClient.getDialogs({});
    const groups = [];
    
    for (const dialog of dialogs) {
      if (dialog.isGroup && dialog.entity.adminRights) {
        groups.push({
          id: dialog.id,
          title: dialog.title,
          username: dialog.entity.username,
          entity: dialog.entity
        });
      }
    }
    
    return groups;
  } catch (err) {
    log("error", "خطا در دریافت گروه‌ها:", err.message);
    return [];
  }
}

// ----------------------------------------------------------------------------
// دانلود و فوروارد مدیا
// ----------------------------------------------------------------------------
async function downloadMediaFromTg(msg) {
  try {
    const buffer = await state.tgClient.downloadMedia(msg, {
      workers: 1,
      progressCallback: () => {}
    });
    
    if (buffer && Buffer.isBuffer(buffer)) {
      return buffer;
    }
    
    if (buffer) {
      return Buffer.from(buffer);
    }
    
    return null;
  } catch (err) {
    log("error", "خطا در دانلود مدیا:", err.message);
    return null;
  }
}

async function forwardMessageToRubika(chatId, msg, sourceTitle) {
  try {
    const caption = msg.message || '';
    const fullCaption = `📰 از چنل: ${sourceTitle}\n\n${caption}`;

    if (msg.photo) {
      const buffer = await downloadMediaFromTg(msg);
      if (buffer) {
        await sendMediaToRubika(chatId, buffer, 'photo', fullCaption);
      }
    } else if (msg.video) {
      const buffer = await downloadMediaFromTg(msg);
      if (buffer) {
        await sendMediaToRubika(chatId, buffer, 'video', fullCaption);
      }
    } else if (msg.document) {
      const buffer = await downloadMediaFromTg(msg);
      if (buffer) {
        await sendMediaToRubika(chatId, buffer, 'document', fullCaption);
      }
    } else if (caption) {
      await sendMessage(chatId, fullCaption);
    }

    return true;
  } catch (err) {
    log("error", "خطا در فوروارد پیام:", err.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Listener برای چنل‌های تلگرام
// ----------------------------------------------------------------------------
function startChannelListener(chatId, tgChannel, rubikaChannelId) {
  const key = `${chatId}_${tgChannel.id}`;
  
  if (state.channelListeners.has(key)) {
    log("info", `Listener قبلاً فعال است: ${key}`);
    return;
  }

  log("info", `شروع listener برای چنل: ${tgChannel.title}`);
  
  const interval = setInterval(async () => {
    try {
      const messages = await state.tgClient.getMessages(tgChannel.entity, { limit: 5 });
      
      for (const msg of messages.reverse()) {
        const msgKey = `${key}_${msg.id}`;
        
        if (!state.channelListeners.has(msgKey)) {
          state.channelListeners.set(msgKey, true);
          await forwardMessageToRubika(rubikaChannelId, msg, tgChannel.title);
        }
      }
    } catch (err) {
      log("error", "خطا در listener:", err.message);
    }
  }, 10000); // هر 10 ثانیه چک کن

  state.channelListeners.set(key, interval);
}

function stopChannelListener(chatId, tgChannelId) {
  const key = `${chatId}_${tgChannelId}`;
  
  if (state.channelListeners.has(key)) {
    clearInterval(state.channelListeners.get(key));
    state.channelListeners.delete(key);
    log("info", `Listener متوقف شد: ${key}`);
  }
}

// ----------------------------------------------------------------------------
// استارت ربات تلگرامی
// ----------------------------------------------------------------------------
async function startTgBot(chatId, botUsername) {
  try {
    const entity = await state.tgClient.getEntity(botUsername);
    
    await state.tgClient.invoke(new Api.messages.StartBot({
      bot: entity,
      randomId: Math.floor(Math.random() * 1000000),
      startParam: 'start'
    }));

    await sendMessage(chatId, `✅ ربات @${botUsername} استارت شد!\n\nلطفاً صبر کنید تا پیام‌های ربات را دریافت کنم...`);

    // دریافت پیام‌های ربات
    setTimeout(async () => {
      const messages = await state.tgClient.getMessages(entity, { limit: 5 });
      
      if (messages.length > 0) {
        const lastMsg = messages[0];
        let botResponse = "🤖 پاسخ ربات:\n\n";
        
        if (lastMsg.message) {
          botResponse += lastMsg.message + "\n\n";
        }

        if (lastMsg.replyMarkup) {
          botResponse += "🔘 دکمه‌ها:\n";
          const buttons = lastMsg.replyMarkup.rows;
          
          for (let i = 0; i < buttons.length; i++) {
            for (let j = 0; j < buttons[i].buttons.length; j++) {
              const btn = buttons[i].buttons[j];
              botResponse += `${i + 1}. ${btn.text}\n`;
            }
          }
        }

        await sendMessage(chatId, botResponse);
      }
    }, 3000);

  } catch (err) {
    await sendMessage(chatId, "❌ خطا در استارت ربات: " + err.message);
  }
}

// ----------------------------------------------------------------------------
// مدیریت دستورات
// ----------------------------------------------------------------------------
async function handleTextMessage(chatId, text) {
  const userState = state.userStates[chatId] || { step: 'idle' };
  const trimmedText = text.trim();

  const mainMenu = [
    ["📢 چنل‌های من", "⚙️ تنظیم چنل"],
    ["👥 گروه‌های من", "⚙️ تنظیم گروه"],
    ["🤖 استارت ربات"]
  ];

  const backMenu = [["🏠 منوی اصلی"]];

  // منوی اصلی
  if (trimmedText === "/start" || trimmedText === "🏠 منوی اصلی") {
    if (!state.isTgLoggedIn) {
      if (state.tgConnecting) {
        await sendMessage(chatId, "⏳ در حال اتصال به تلگرام...");
      } else {
        await sendMessage(chatId, "⚠️ ابتدا باید به تلگرام متصل شوید.");
        await sendTgCode(chatId);
      }
    } else {
      state.userStates[chatId] = { step: 'idle' };
      await sendMessage(chatId, "👋 خوش آمدید!\n\nاز دکمه‌ها یا دستورات استفاده کنید:", mainMenu);
    }
  }
  else if (trimmedText === "/menu") {
    state.userStates[chatId] = { step: 'idle' };
    await sendMessage(chatId, "🏠 منوی اصلی:", mainMenu);
  }
  // لیست چنل‌ها
  else if (trimmedText === "/channels" || trimmedText === "📢 چنل‌های من") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "❌ ابتدا باید لاگین کنید.");
      return;
    }

    await sendMessage(chatId, "⏳ در حال دریافت لیست چنل‌ها...");
    const channels = await getTgChannels();

    if (channels.length === 0) {
      await sendMessage(chatId, "❌ هیچ چنلی یافت نشد.\n\nشما باید در تلگرام ادمین چنل باشید.", mainMenu);
      return;
    }

    let msg = "📢 چنل‌هایی که ادمین هستید:\n\n";
    const kb = [];
    
    channels.forEach((ch, i) => {
      msg += `${i + 1}. ${ch.title}\n`;
      kb.push([`/ch${i + 1}`]);
    });
    
    kb.push(["🏠 منوی اصلی"]);
    
    state.userStates[chatId] = { step: 'selecting_channel', channels };
    await sendMessage(chatId, msg, kb);
  }
  // انتخاب چنل
  else if (trimmedText.match(/^\/ch\d+$/)) {
    if (userState.step !== 'selecting_channel') {
      await sendMessage(chatId, "❌ ابتدا دستور /channels را بزنید.");
      return;
    }

    const index = parseInt(trimmedText.replace('/ch', '')) - 1;
    const channel = userState.channels[index];

    if (!channel) {
      await sendMessage(chatId, "❌ شماره نامعتبر.");
      return;
    }

    state.userStates[chatId] = { 
      step: 'waiting_for_tg_channel_link',
      selectedChannel: channel
    };

    await sendMessage(chatId, `✅ چنل "${channel.title}" انتخاب شد.\n\nحالا لینک چنل تلگرامی را ارسال کنید:\n(مثال: https://t.me/durov)`, backMenu);
  }
  // لینک چنل تلگرامی
  else if (userState.step === 'waiting_for_tg_channel_link') {
    const link = trimmedText;
    const tgChannel = userState.selectedChannel;

    try {
      const username = link.replace(/https?:\/\/t\.me\//, '').replace('/', '');
      const entity = await state.tgClient.getEntity(username);

      state.userStates[chatId] = {
        step: 'idle',
        monitoring: {
          tgChannel: { id: entity.id, title: entity.title, entity },
          rubikaChannelId: chatId
        }
      };

      // شروع listener
      startChannelListener(chatId, { id: entity.id, title: entity.title, entity }, chatId);

      await sendMessage(chatId, `✅ فوروارد خودکار فعال شد!\n\nاز چنل تلگرام: ${entity.title}\nبه چت روبیکا: ${chatId}\n\nهر پیامی که منتشر بشه، خودکار فوروارد میشه.`, mainMenu);
    } catch (err) {
      await sendMessage(chatId, "❌ خطا: " + err.message);
    }
  }
  // لیست گروه‌ها
  else if (trimmedText === "/groups" || trimmedText === "👥 گروه‌های من") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "❌ ابتدا باید لاگین کنید.");
      return;
    }

    await sendMessage(chatId, "⏳ در حال دریافت لیست گروه‌ها...");
    const groups = await getTgGroups();

    if (groups.length === 0) {
      await sendMessage(chatId, "❌ هیچ گروهی یافت نشد.", mainMenu);
      return;
    }

    let msg = "👥 گروه‌هایی که ادمین هستید:\n\n";
    const kb = [];
    
    groups.forEach((gr, i) => {
      msg += `${i + 1}. ${gr.title}\n`;
      kb.push([`/gr${i + 1}`]);
    });
    
    kb.push(["🏠 منوی اصلی"]);
    
    state.userStates[chatId] = { step: 'selecting_group', groups };
    await sendMessage(chatId, msg, kb);
  }
  // استارت ربات تلگرامی
  else if (trimmedText === "/bot" || trimmedText === "🤖 استارت ربات") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "❌ ابتدا باید لاگین کنید.");
      return;
    }

    state.userStates[chatId] = { step: 'waiting_for_bot_username' };
    await sendMessage(chatId, "🤖 آیدی ربات تلگرامی را ارسال کنید:\n(مثال: @BotFather یا BotFather)", backMenu);
  }
  else if (userState.step === 'waiting_for_bot_username') {
    const botUsername = trimmedText.replace('@', '');
    await startTgBot(chatId, botUsername);
    state.userStates[chatId] = { step: 'idle' };
  }
  else {
    await sendMessage(chatId, "❓ دستور نامعتبر.\n\n/start برای منوی اصلی", mainMenu);
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
// اپلیکیشن Express
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.setHeader("Content-Type", "text/html; charset=utf-8").send(renderAdminPage()));

app.get("/api/status", (req, res) => {
  res.json({
    running: state.running, 
    messageCount: state.messageCount, 
    lastError: state.lastError,
    hasRubikaToken: Boolean(config.rubikaToken),
    hasTgConfig: Boolean(config.tgApiId && config.tgApiHash && config.tgPhone),
    isTgLoggedIn: state.isTgLoggedIn, 
    tgConnecting: state.tgConnecting
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
    
    state.running = true;
    state.messageCount = 0;
    log("info", "ربات شروع به کار کرد.");
    pollOnce();
    
    initTgClient().then(() => {
      log("info", "اتصال تلگرام در پس‌زمینه کامل شد");
    }).catch(err => {
      log("error", "خطا در اتصال تلگرام:", err.message);
    });
    
    res.json({ ok: true, message: "ربات راه‌اندازی شد." });
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
<title>پنل ربات پیشرفته</title>
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
  .btn-success { background: var(--green); color: #052e12; }
  .btn-danger { background: var(--red); color: #3a0a0a; }
  .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-on { background: rgba(34,197,94,0.15); color: var(--green); }
  .status-on .dot { background: var(--green); }
  .status-off { background: rgba(239,68,68,0.15); color: var(--red); }
  .status-off .dot { background: var(--red); }
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
  <h1>🤖 پنل ربات پیشرفته روبیکا</h1>
  <div class="subtitle">مدیریت چنل‌ها، گروه‌ها و ربات‌های تلگرامی</div>

  <div class="card">
    <h2>وضعیت سیستم</h2>
    <span id="statusBadge" class="status-badge status-off"><span class="dot"></span> در حال بارگذاری...</span>
    <div class="info-grid" id="infoGrid"></div>
  </div>

  <div class="card">
    <h2>تنظیمات</h2>
    <label>توکن ربات روبیکا</label>
    <input id="rubikaToken" type="text" placeholder="توکن ربات روبیکا" />
    <label>API ID تلگرام</label>
    <input id="tgApiId" type="text" placeholder="عدد API ID" />
    <label>API Hash تلگرام</label>
    <input id="tgApiHash" type="text" placeholder="کاراکترهای API Hash" />
    <label>شماره تلفن تلگرام</label>
    <input id="tgPhone" type="text" placeholder="+989xxxxxxxxx" />
  </div>

  <div class="card">
    <h2>عملیات</h2>
    <div class="row">
      <button class="btn-primary" onclick="saveConfig()">💾 ذخیره</button>
      <button class="btn-success" onclick="startBot()">▶️ راه‌اندازی</button>
      <button class="btn-danger" onclick="stopBot()">⏹ توقف</button>
    </div>
  </div>

  <div class="card">
    <h2>دستورات ربات</h2>
    <div class="commands">
      <div><strong>/start</strong> - منوی اصلی</div>
      <div><strong>/channels</strong> - لیست چنل‌های تلگرام</div>
      <div><strong>/groups</strong> - لیست گروه‌های تلگرام</div>
      <div><strong>/bot</strong> - استارت ربات تلگرامی</div>
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
        <div><span>پیام‌ها</span>\${s.messageCount}</div>
        <div><span>توکن روبیکا</span>\${s.hasRubikaToken ? '✅' : '❌'}</div>
        <div><span>تنظیمات تلگرام</span>\${s.hasTgConfig ? '✅' : '❌'}</div>
        <div><span>وضعیت تلگرام</span>\${tgStatus}</div>
      \`;
    } catch (e) { console.error(e); }
  }

  refreshStatus();
  setInterval(refreshStatus, 3000);
</script>
</body>
</html>`;
}
