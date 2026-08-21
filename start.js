// ============================================================================
//  ربات پیشرفته روبیکا - نسخه ۲
//  - لیست کانال/گروه = جاهایی که خودِ بات روبیکا ادمینه (نه اکانت شخصی)
//  - فوروارد لحظه‌ای (event-based) به‌جای polling هر ۱۰ ثانیه
//  - محدودیت حجم فایل ۱ گیگابایت با پیام جایگزین برای فایل‌های بزرگ‌تر
//  - رله زنده‌ی هر رباتِ تلگرامی + دکمه‌های آن به‌صورت دستور متنی (/btn1, /btn2 ...)
//  - دکمه شیشه‌ای (inline keypad) به‌طور کامل حذف شد چون در حالت Polling
//    توسط پلتفرم روبیکا اصلاً قابل دریافت نیست (فقط با وبهوک کار می‌کند)
// ============================================================================

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TelegramClient, Api } from "telegram/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import FormData from "form-data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DEBUG_UPDATES = process.env.DEBUG_UPDATES === "1"; // برای دیباگ: DEBUG_UPDATES=1 node bot-v2.js
const CONFIG_PATH = path.join(__dirname, "bot-config.json");
const SESSION_PATH = path.join(__dirname, "tg-session.json");
const DATA_PATH = path.join(__dirname, "bot-data.json");
const RUBIKA_BASE_URL = "https://botapi.rubika.ir/v3";
const ONE_GB = 1024 * 1024 * 1024;

function log(level, ...args) {
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (level === "error") console.error(`[${time}] [ERROR]`, ...args);
  else console.log(`[${time}] [INFO]`, ...args);
}

// ----------------------------------------------------------------------------
// ✅ هندلرهای گلوبال - جلوگیری از کرش کامل پروسه (علت اصلی "استاپ خودکار" قبلی)
// ----------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  log("error", "Uncaught Exception (پروسه نمرد):", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled Rejection (پروسه نمرد):", reason?.message || reason);
});

// ----------------------------------------------------------------------------
// وضعیت و پیکربندی
// ----------------------------------------------------------------------------
const state = {
  running: false,
  pollTimeout: null,
  offsetId: null,
  messageCount: 0,
  lastError: null,
  isTgLoggedIn: false,
  tgClient: null,
  tgPhoneCodeHash: null,
  userStates: {},        // per Rubika chat: مرحله فعلی مکالمه + رله فعال + دکمه‌های فعال
  rubikaChats: [],        // [{chat_id, title, type}] - جاهایی که این بات ادمینه (از رویداد StartedBot)
  forwardMappings: [],     // [{name, link, targetChatId, targetTitle}] - اتصال‌های فعال ذخیره‌شده
  codeSent: false
};

let config = { rubikaToken: "", tgApiId: "", tgApiHash: "", tgPhone: "" };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
    }
    if (fs.existsSync(DATA_PATH)) {
      const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
      state.rubikaChats = data.rubikaChats || [];
      state.forwardMappings = data.forwardMappings || data.savedChannels || [];
    }
  } catch (err) { log("error", "خطا در خواندن فایل‌ها:", err.message); }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8"); return true; }
  catch (err) { log("error", "خطا در ذخیره تنظیمات:", err.message); return false; }
}
function saveData() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({
      rubikaChats: state.rubikaChats,
      forwardMappings: state.forwardMappings
    }, null, 2), "utf-8");
  } catch (err) { log("error", "خطا در ذخیره داده‌ها:", err.message); }
}
function saveTgSession() {
  try {
    if (state.tgClient) fs.writeFileSync(SESSION_PATH, JSON.stringify({ session: state.tgClient.session.save() }, "utf-8"));
  } catch (err) { log("error", "خطا در ذخیره سشن تلگرام:", err.message); }
}

loadConfig();

function upsertRubikaChat(chatId, title, type) {
  chatId = String(chatId);
  const idx = state.rubikaChats.findIndex((c) => c.chat_id === chatId);
  if (idx >= 0) state.rubikaChats[idx] = { chat_id: chatId, title, type };
  else state.rubikaChats.push({ chat_id: chatId, title, type });
  saveData();
}
function removeRubikaChat(chatId) {
  chatId = String(chatId);
  state.rubikaChats = state.rubikaChats.filter((c) => c.chat_id !== chatId);
  saveData();
}

// ----------------------------------------------------------------------------
// ارتباط با API روبیکا
// ----------------------------------------------------------------------------
async function rubikaCall(method, body = {}, token = config.rubikaToken) {
  if (!token) throw new Error("توکن ربات روبیکا تنظیم نشده است.");
  const url = `${RUBIKA_BASE_URL}/${token}/${method}`;
  try {
    const res = await axios.post(url, body, { headers: { "Content-Type": "application/json" }, timeout: 15000 });
    return res.data;
  } catch (err) {
    throw new Error(`خطا در متد ${method}: ${err.response?.data?.status_det || err.message}`);
  }
}

async function sendMessage(chatId, text) {
  return rubikaCall("sendMessage", { chat_id: String(chatId), text });
}

// نگاشت نوع مدیا به متد آپلود روبیکا. فقط photo/video بر اساس تست قبلی شما مطمئنیم درست کار می‌کنن؛
// بقیه (gif/music/voice/file) بر اساس مستندات ناقص روبیکا حدس زده شده - اگه ارور خوردن، از لاگ
// خطای واقعی (status_det) که الان چاپ می‌شه می‌فهمیم اسم متد درست چیه و اصلاح می‌کنیم.
const MEDIA_ENDPOINTS = {
  photo: { method: "sendPhoto", field: "photo", filename: "image.jpg", contentType: "image/jpeg" },
  video: { method: "sendVideo", field: "video", filename: "video.mp4", contentType: "video/mp4" },
  gif:   { method: "sendGif",   field: "gif",   filename: "anim.gif",  contentType: "image/gif" },
  music: { method: "sendMusic", field: "music", filename: "audio.mp3", contentType: "audio/mpeg" },
  voice: { method: "sendVoice", field: "voice", filename: "voice.ogg", contentType: "audio/ogg" },
  file:  { method: "sendFile",  field: "file",  filename: "file.bin",  contentType: "application/octet-stream" }
};

async function sendMediaToRubika(chatId, buffer, kind, caption = "", customFilename = null) {
  try {
    const cfg = MEDIA_ENDPOINTS[kind] || MEDIA_ENDPOINTS.file;
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const filename = customFilename || cfg.filename;
    form.append(cfg.field, buffer, { filename, contentType: cfg.contentType });
    if (caption) form.append("caption", caption.substring(0, 1000));

    const url = `${RUBIKA_BASE_URL}/${config.rubikaToken}/${cfg.method}`;
    await axios.post(url, form, { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 180000 });
    return true;
  } catch (err) {
    log("error", `خطا در ارسال ${kind}:`, err.response?.data?.status_det || err.message);
    // اگه متد ناموجود بود (مثلاً sendGif واقعاً وجود نداره)، به‌صورت فایل عادی امتحان کن
    if (kind !== "file" && (err.response?.status === 404 || err.response?.status === 400)) {
      log("info", `تلاش دوباره برای ارسال ${kind} به‌صورت file عمومی...`);
      return sendMediaToRubika(chatId, buffer, "file", caption, customFilename);
    }
    return false;
  }
}

function humanFileSize(bytes) {
  if (bytes == null) return "نامشخص";
  const units = ["B", "KB", "MB", "GB"];
  let n = Number(bytes), i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${units[i]}`;
}

const EXT_MAP = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4",
  "video/x-matroska": "mkv", "audio/mpeg": "mp3", "audio/ogg": "ogg", "application/pdf": "pdf",
  "application/zip": "zip", "application/x-rar-compressed": "rar", "application/vnd.android.package-archive": "apk"
};
function guessExtension(mimeType) { return EXT_MAP[mimeType] || "bin"; }

function getMediaObjectAndKind(msg) {
  if (msg.photo) return { kind: "photo", obj: msg.photo };
  if (msg.video) return { kind: "video", obj: msg.video };
  if (msg.gif) return { kind: "gif", obj: msg.gif };
  if (msg.audio) return { kind: "music", obj: msg.audio };
  if (msg.voice) return { kind: "voice", obj: msg.voice };
  if (msg.document) return { kind: "file", obj: msg.document };
  return { kind: null, obj: null };
}
function getMediaSizeBytes(kind, obj) {
  if (kind === "photo" || !obj) return null; // عکس‌ها معمولاً کوچیکن، نیازی به چک نیست
  try { return obj.size != null ? Number(obj.size) : null; } catch { return null; }
}
function getFileName(obj, msgId) {
  try {
    const attrs = obj?.attributes || [];
    const fnAttr = attrs.find((a) => a.className === "DocumentAttributeFilename");
    if (fnAttr?.fileName) return fnAttr.fileName;
  } catch (e) {}
  return `file_${msgId}.${guessExtension(obj?.mimeType)}`;
}

// ----------------------------------------------------------------------------
// مدیریت کلاینت تلگرام
// ----------------------------------------------------------------------------
async function initTgClient() {
  if (!config.tgApiId || !config.tgApiHash) throw new Error("تنظیمات تلگرام کامل نیست.");
  state.tgConnecting = true;

  let sessionStr = "";
  if (fs.existsSync(SESSION_PATH)) {
    try { sessionStr = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8")).session || ""; } catch (e) {}
  }

  try {
    state.tgClient = new TelegramClient(
      new StringSession(sessionStr), parseInt(config.tgApiId), config.tgApiHash,
      { connectionRetries: 5, retryDelay: 2000, timeout: 10, autoReconnect: true }
    );
    await state.tgClient.connect();
    state.isTgLoggedIn = await state.tgClient.isUserAuthorized();
    state.tgConnecting = false;
    return true;
  } catch (err) {
    state.tgConnecting = false;
    state.tgClient = null;
    log("error", "خطا در اتصال به تلگرام:", err.message);
    throw err;
  }
}
async function ensureTgClient() {
  if (!state.tgClient) await initTgClient();
  if (!state.tgClient) throw new Error("کلاینت تلگرام ساخته نشد.");
  return state.tgClient;
}
async function sendTgCodeFromWeb(phone) {
  try {
    const client = await ensureTgClient();
    const result = await client.sendCode({ apiId: parseInt(config.tgApiId), apiHash: config.tgApiHash }, phone);
    state.tgPhoneCodeHash = result.phoneCodeHash;
    state.codeSent = true;
    return { success: true, message: "کد ارسال شد" };
  } catch (err) { log("error", "خطا در ارسال کد:", err.message); return { success: false, message: err.message }; }
}
async function verifyTgCodeFromWeb(code) {
  try {
    const client = await ensureTgClient();
    if (!state.tgPhoneCodeHash) return { success: false, message: "ابتدا کد را ارسال کنید" };
    await client.invoke(new Api.auth.SignIn({ phoneNumber: config.tgPhone, phoneCodeHash: state.tgPhoneCodeHash, phoneCode: code }));
    state.isTgLoggedIn = true;
    state.codeSent = false;
    saveTgSession();
    await restoreForwardMappings(); // بعد از لاگین موفق، اتصال‌های قبلی رو دوباره فعال کن
    return { success: true, message: "لاگین موفق" };
  } catch (err) { log("error", "خطا در تایید کد:", err.message); return { success: false, message: err.message }; }
}

// ----------------------------------------------------------------------------
// دانلود مدیا از تلگرام
// ----------------------------------------------------------------------------
async function downloadMediaFromTg(msg) {
  try {
    const buffer = await state.tgClient.downloadMedia(msg, { workers: 1, progressCallback: () => {} });
    if (buffer && Buffer.isBuffer(buffer)) return buffer;
    if (buffer) return Buffer.from(buffer);
    return null;
  } catch (err) { log("error", "خطا در دانلود مدیا:", err.message); return null; }
}

// ----------------------------------------------------------------------------
// ✅ فوروارد لحظه‌ای از یک کانال/گروه تلگرامی به یک چت روبیکا
// ----------------------------------------------------------------------------
const activeForwardHandlers = new Map(); // targetChatId -> {handler, eventBuilder}

async function attachRealtimeForward(targetChatId, tgEntity, sourceTitle) {
  const client = await ensureTgClient();
  detachRealtimeForward(targetChatId);

  const handler = async (event) => {
    try { await forwardTelegramMessageToRubika(targetChatId, event.message, sourceTitle); }
    catch (err) { log("error", "خطا در فوروارد لحظه‌ای:", err.message); }
  };
  const eventBuilder = new NewMessage({ chats: [tgEntity] });
  client.addEventHandler(handler, eventBuilder);
  activeForwardHandlers.set(String(targetChatId), { handler, eventBuilder });
  log("info", `فوروارد لحظه‌ای فعال شد: ${sourceTitle} → چت روبیکا ${targetChatId}`);
}
function detachRealtimeForward(targetChatId) {
  const existing = activeForwardHandlers.get(String(targetChatId));
  if (existing && state.tgClient) {
    try { state.tgClient.removeEventHandler(existing.handler, existing.eventBuilder); } catch (e) {}
  }
  activeForwardHandlers.delete(String(targetChatId));
}

async function forwardTelegramMessageToRubika(targetChatId, msg, sourceTitle) {
  const caption = msg.message || "";
  const fullCaption = `📰 از: ${sourceTitle}\n\n${caption}`.trim();
  const { kind, obj } = getMediaObjectAndKind(msg);
  const sizeBytes = getMediaSizeBytes(kind, obj);

  if (kind && sizeBytes != null && sizeBytes > ONE_GB) {
    const label = { video: "ویدیو", gif: "گیف", music: "فایل صوتی", voice: "پیام صوتی", file: "فایل" }[kind] || "فایل";
    await sendMessage(targetChatId, `⚠️ ${label} دریافتی حجمش بیشتر از ۱ گیگابایت بود (${humanFileSize(sizeBytes)}) و ارسال نشد.\n\n${fullCaption}`);
    return;
  }

  if (kind) {
    const buffer = await downloadMediaFromTg(msg);
    if (!buffer) { await sendMessage(targetChatId, `⚠️ دانلود ${kind} با خطا مواجه شد.\n\n${fullCaption}`); return; }
    const filename = kind === "file" ? getFileName(obj, msg.id) : null;
    await sendMediaToRubika(targetChatId, buffer, kind, fullCaption, filename);
  } else if (caption) {
    await sendMessage(targetChatId, fullCaption);
  }
}

async function restoreForwardMappings() {
  if (!state.isTgLoggedIn) return;
  for (const m of state.forwardMappings) {
    try {
      const username = m.link.replace(/https?:\/\/t\.me\//, "").replace("/", "");
      const entity = await state.tgClient.getEntity(username);
      await attachRealtimeForward(m.targetChatId, entity, m.name);
    } catch (err) { log("error", `خطا در بازیابی فوروارد "${m.name}":`, err.message); }
  }
}

// ----------------------------------------------------------------------------
// ✅ رله زنده‌ی یک ربات تلگرامی به یک چت روبیکا (شامل دکمه‌ها)
// ----------------------------------------------------------------------------
async function startBotRelay(chatId, botUsernameRaw) {
  try {
    const client = await ensureTgClient();
    const botUsername = botUsernameRaw.replace("@", "").replace(/^https?:\/\/t\.me\//, "");
    const entity = await client.getEntity(botUsername);

    stopBotRelay(chatId);

    const handler = async (event) => {
      try { await relayBotMessageToRubika(chatId, event.message); }
      catch (err) { log("error", "خطا در رله پیام ربات:", err.message); }
    };
    const eventBuilder = new NewMessage({ chats: [entity] });
    client.addEventHandler(handler, eventBuilder);

    state.userStates[chatId] = state.userStates[chatId] || {};
    state.userStates[chatId].relay = { botEntity: entity, handler, eventBuilder, botUsername };
    state.userStates[chatId].step = "idle";

    await client.invoke(new Api.messages.StartBot({ bot: entity, randomId: Math.floor(Math.random() * 1e9), startParam: "start" }));

    await sendMessage(chatId, `✅ ربات @${botUsername} استارت شد.\n\nاز الان هر چیزی که این ربات بفرسته (متن، عکس، فایل، دکمه و ...) همینجا میاد.\nبرای توقف: /stoprelay`);
  } catch (err) {
    await sendMessage(chatId, "❌ خطا در استارت ربات: " + err.message);
  }
}
function stopBotRelay(chatId) {
  const relay = state.userStates[chatId]?.relay;
  if (relay && state.tgClient) {
    try { state.tgClient.removeEventHandler(relay.handler, relay.eventBuilder); } catch (e) {}
  }
  if (state.userStates[chatId]) {
    delete state.userStates[chatId].relay;
    delete state.userStates[chatId].activeBotButtons;
  }
}

function extractButtonsFromMessage(msg) {
  const markup = msg.replyMarkup;
  if (!markup || !markup.rows) return null;
  return markup.rows.map((row) => row.buttons.map((btn) => ({
    text: btn.text,
    data: btn.data ? Buffer.from(btn.data).toString("base64") : null,
    url: btn.url || null
  })));
}
function formatButtonsAndStoreMapping(chatId, buttonRows, messageId) {
  let text = "\n\n🔘 دکمه‌های این پیام:\n";
  const mapping = {};
  let counter = 1;
  buttonRows.forEach((row) => row.forEach((btn) => {
    const cmd = `/btn${counter}`;
    text += `${cmd} ← ${btn.text}\n`;
    mapping[cmd] = { messageId, data: btn.data, url: btn.url, text: btn.text };
    counter++;
  }));
  state.userStates[chatId] = state.userStates[chatId] || {};
  state.userStates[chatId].activeBotButtons = mapping;
  return text;
}

async function relayBotMessageToRubika(chatId, msg) {
  const caption = msg.message || "";
  const { kind, obj } = getMediaObjectAndKind(msg);
  const sizeBytes = getMediaSizeBytes(kind, obj);

  let buttonsText = "";
  const buttons = extractButtonsFromMessage(msg);
  if (buttons) buttonsText = formatButtonsAndStoreMapping(chatId, buttons, msg.id);

  const fullCaption = `🤖 ${caption}${buttonsText}`.trim();

  if (kind && sizeBytes != null && sizeBytes > ONE_GB) {
    await sendMessage(chatId, `⚠️ فایل دریافتی از ربات حجمش بیشتر از ۱ گیگابایت بود (${humanFileSize(sizeBytes)}).\n\n${fullCaption}`);
    return;
  }
  if (kind) {
    const buffer = await downloadMediaFromTg(msg);
    if (buffer) {
      const filename = kind === "file" ? getFileName(obj, msg.id) : null;
      await sendMediaToRubika(chatId, buffer, kind, fullCaption, filename);
    } else {
      await sendMessage(chatId, fullCaption || "⚠️ خطا در دانلود فایل ربات");
    }
  } else if (fullCaption) {
    await sendMessage(chatId, fullCaption);
  }
}

async function clickRelayButton(chatId, cmd) {
  const relay = state.userStates[chatId]?.relay;
  const mapping = state.userStates[chatId]?.activeBotButtons?.[cmd];
  if (!relay || !mapping) { await sendMessage(chatId, "❌ الان دکمه‌ی فعالی نیست. اول با /bot یک ربات را استارت بزن."); return; }

  try {
    if (mapping.url) { await sendMessage(chatId, `🔗 این دکمه یک لینک است:\n${mapping.url}`); return; }
    const client = await ensureTgClient();
    if (mapping.data) {
      await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer: relay.botEntity, msgId: mapping.messageId, data: Buffer.from(mapping.data, "base64")
      }));
      // پاسخ احتمالی (پیام جدید یا ویرایش‌شده) خودکار توسط listener فوروارد میشه
    } else {
      await client.sendMessage(relay.botEntity, { message: mapping.text });
    }
  } catch (err) {
    await sendMessage(chatId, "❌ خطا در کلیک دکمه: " + err.message);
  }
}

// ----------------------------------------------------------------------------
// ✅ ثبت خودکار کانال/گروه‌هایی که این بات روبیکا ادمینشونه
// ----------------------------------------------------------------------------
async function handleBotMembershipUpdate(update) {
  const chatId = String(update.chat_id);
  if (update.type === "StoppedBot") { removeRubikaChat(chatId); return; }

  // StartedBot: هم برای PV (کاربر /start زده) هم برای گروه/کانال (بات ادمین شده) میاد.
  let title = update.chat?.title || update.chat?.first_name || null;
  let type = update.chat?.type || null;

  if (!title || !type) {
    try {
      const info = await rubikaCall("getChat", { chat_id: chatId });
      if (DEBUG_UPDATES) log("info", "getChat raw:", JSON.stringify(info));
      const chat = info?.data?.chat || info?.chat || info?.data || {};
      title = title || chat.title || chat.first_name || chatId;
      type = type || chat.type;
    } catch (e) { log("error", "خطا در getChat:", e.message); }
  }

  if (type === "Group" || type === "Channel") {
    upsertRubikaChat(chatId, title, type);
    log("info", `✅ بات به عنوان ادمین در ${type === "Channel" ? "کانال" : "گروه"} "${title}" ثبت شد.`);
  }
  // اگه type چیز دیگه‌ای بود (مثلاً PV)، کاری لازم نیست - جریان /start معمولی از مسیر NewMessage جواب میده.
}

// ----------------------------------------------------------------------------
// ✅ مدیریت دستورات - فقط متنی (بدون دکمه شیشه‌ای، به دلایل بالا)
// ----------------------------------------------------------------------------
async function handleTextMessage(chatId, text) {
  const userState = state.userStates[chatId] || { step: "idle" };
  const trimmedText = text.trim();

  if (trimmedText === "/start") {
    if (!state.isTgLoggedIn) {
      await sendMessage(chatId, "⚠️ ابتدا باید از پنل وب به تلگرام متصل شوید.");
    } else {
      state.userStates[chatId] = { step: "idle" };
      await sendMessage(chatId,
`👋 خوش آمدید!

📋 دستورات:
/channels - کانال‌های روبیکایی که این بات توشون ادمینه
/groups - گروه‌های روبیکایی که این بات توشون ادمینه
/saved - اتصال‌های فعال فعلی
/bot - استارت یک ربات تلگرامی و دریافت زنده‌ی پیام‌هایش
/stoprelay - توقف رله ربات تلگرامی فعال
/menu - بازگشت به منو

💡 روش اتصال کانال/گروه:
۱. این بات را در یک کانال/گروه روبیکا ادمین کن (گزینه «دریافت همه پیام‌های کانال و گروه» را هم در BotFather روشن کن)
۲. /channels یا /groups را بزن و با /rc1 یا /rg1 انتخاب کن
۳. لینک کانال/گروه تلگرامی مبدأ را بفرست
۴. از این به بعد هر پیامی در آن کانال/گروه تلگرام منتشر بشه، خودکار همینجا میاد.`);
    }
  }
  else if (trimmedText === "/menu") {
    state.userStates[chatId] = { step: "idle" };
    await sendMessage(chatId, "🏠 /channels | /groups | /saved | /bot | /stoprelay");
  }
  else if (trimmedText === "/channels" || trimmedText === "/groups") {
    const wantType = trimmedText === "/channels" ? "Channel" : "Group";
    const list = state.rubikaChats.filter((c) => c.type === wantType);
    if (list.length === 0) {
      await sendMessage(chatId,
`❌ هنوز هیچ ${wantType === "Channel" ? "کانالی" : "گروهی"} شناسایی نشده.

این بات را در یک ${wantType === "Channel" ? "کانال" : "گروه"} روبیکا ادمین کن تا خودکار اینجا لیست بشه.

⚠️ حتماً در BotFather گزینه «دریافت همه پیام‌های کانال و گروه» را برای این بات فعال کن، وگرنه بات از ادمین‌شدنش خبردار نمی‌شه.`);
      return;
    }
    const prefix = wantType === "Channel" ? "rc" : "rg";
    let msg = `${wantType === "Channel" ? "📢 کانال‌ها" : "👥 گروه‌ها"}یی که این بات ادمینشونه:\n\n`;
    list.forEach((c, i) => { msg += `${i + 1}. ${c.title}\n   انتخاب: /${prefix}${i + 1}\n\n`; });
    state.userStates[chatId] = { step: "selecting_rubika_target", list, kind: wantType };
    await sendMessage(chatId, msg);
  }
  else if (trimmedText.match(/^\/r[cg]\d+$/)) {
    if (userState.step !== "selecting_rubika_target") { await sendMessage(chatId, "❌ اول /channels یا /groups را بزن."); return; }
    const idx = parseInt(trimmedText.replace(/^\/r[cg]/, "")) - 1;
    const target = userState.list[idx];
    if (!target) { await sendMessage(chatId, "❌ شماره نامعتبر."); return; }
    state.userStates[chatId] = { step: "waiting_for_tg_source_link", target };
    await sendMessage(chatId, `✅ "${target.title}" انتخاب شد.\n\nحالا لینک کانال/گروه تلگرامی مبدأ را بفرست:\n(مثال: https://t.me/example)`);
  }
  else if (userState.step === "waiting_for_tg_source_link") {
    const link = trimmedText;
    try {
      const username = link.replace(/https?:\/\/t\.me\//, "").replace("/", "");
      const entity = await state.tgClient.getEntity(username);
      await attachRealtimeForward(userState.target.chat_id, entity, entity.title || username);

      state.forwardMappings = state.forwardMappings.filter((m) => m.targetChatId !== userState.target.chat_id);
      state.forwardMappings.push({ name: entity.title || username, link, targetChatId: userState.target.chat_id, targetTitle: userState.target.title });
      saveData();

      await sendMessage(chatId, `✅ با موفقیت وصل شد!\n\nاز الان هر پیامی در "${entity.title || username}" منتشر بشه، بلافاصله توی "${userState.target.title}" (روبیکا) میاد.`);
      state.userStates[chatId] = { step: "idle" };
    } catch (err) {
      await sendMessage(chatId, "❌ خطا: " + err.message);
    }
  }
  else if (trimmedText === "/saved") {
    if (state.forwardMappings.length === 0) { await sendMessage(chatId, "💾 هیچ اتصالی فعال نیست."); return; }
    let msg = "💾 اتصال‌های فعال:\n\n";
    state.forwardMappings.forEach((m, i) => { msg += `${i + 1}. ${m.name} → ${m.targetTitle}\n`; });
    await sendMessage(chatId, msg);
  }
  else if (trimmedText === "/bot") {
    if (!state.isTgLoggedIn) { await sendMessage(chatId, "❌ ابتدا باید از پنل وب لاگین کنید."); return; }
    state.userStates[chatId] = { step: "waiting_for_bot_username" };
    await sendMessage(chatId, "🤖 آیدی یا لینک ربات تلگرامی را بفرست:\n(مثال: @BotFather)");
  }
  else if (userState.step === "waiting_for_bot_username") {
    await startBotRelay(chatId, trimmedText);
  }
  else if (trimmedText === "/stoprelay") {
    stopBotRelay(chatId);
    await sendMessage(chatId, "⏹ رله ربات تلگرامی متوقف شد.");
  }
  else if (trimmedText.match(/^\/btn\d+$/)) {
    await clickRelayButton(chatId, trimmedText);
  }
  else {
    await sendMessage(chatId, "❓ دستور نامعتبر.\n\n/start برای راهنما");
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
      try {
        if (DEBUG_UPDATES) log("info", "RAW UPDATE:", JSON.stringify(update));

        if (update.type === "StartedBot" || update.type === "StoppedBot") {
          await handleBotMembershipUpdate(update);
          continue;
        }

        const { chatId, text, senderType } = extractMessageFromUpdate(update);
        if (!chatId || senderType === "Bot") continue;

        state.messageCount += 1;
        if (text) await handleTextMessage(chatId, text);
      } catch (innerErr) {
        log("error", "خطا در پردازش یک آپدیت (نادیده گرفته شد):", innerErr.message);
      }
    }

    if (nextOffsetId) state.offsetId = nextOffsetId;
    state.lastError = null;
  } catch (err) {
    log("error", "خطا در getUpdates:", err.message);
    state.lastError = err.message;
  } finally {
    if (state.running) state.pollTimeout = setTimeout(pollOnce, 2000);
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
    running: state.running, messageCount: state.messageCount, lastError: state.lastError,
    hasRubikaToken: Boolean(config.rubikaToken), hasTgConfig: Boolean(config.tgApiId && config.tgApiHash),
    isTgLoggedIn: state.isTgLoggedIn, tgConnecting: state.tgConnecting, codeSent: state.codeSent,
    knownChannels: state.rubikaChats.filter((c) => c.type === "Channel").length,
    knownGroups: state.rubikaChats.filter((c) => c.type === "Group").length,
    activeForwards: state.forwardMappings.length
  });
});

app.post("/api/config", (req, res) => {
  const { rubikaToken, tgApiId, tgApiHash, tgPhone } = req.body || {};
  if (rubikaToken !== undefined) config.rubikaToken = rubikaToken.trim();
  if (tgApiId !== undefined) config.tgApiId = tgApiId.trim();
  if (tgApiHash !== undefined) config.tgApiHash = tgApiHash.trim();
  if (tgPhone !== undefined) config.tgPhone = tgPhone.trim();
  const saved = saveConfig();
  res.json({ ok: saved, message: saved ? "تنظیمات ذخیره شد." : "خطا در ذخیره",
    debug: { hasToken: !!config.rubikaToken, apiId: config.tgApiId, hasHash: !!config.tgApiHash } });
});

app.post("/api/send-code", async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "شماره تلفن الزامی است" });
    if (!config.tgApiId || !config.tgApiHash) return res.status(400).json({ success: false, message: "ابتدا API ID و API Hash را ذخیره کنید" });
    config.tgPhone = phone.trim(); saveConfig();
    res.json(await sendTgCodeFromWeb(phone));
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

app.post("/api/verify-code", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "کد الزامی است" });
    res.json(await verifyTgCodeFromWeb(code));
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

app.post("/api/start", async (req, res) => {
  try {
    if (state.running) return res.json({ ok: true, message: "ربات از قبل در حال اجراست." });
    if (!config.rubikaToken) return res.status(400).json({ ok: false, message: "ابتدا توکن ربات روبیکا را وارد کنید." });

    state.running = true;
    state.messageCount = 0;
    pollOnce();

    if (config.tgApiId && config.tgApiHash) {
      ensureTgClient()
        .then(async () => { if (state.isTgLoggedIn) await restoreForwardMappings(); })
        .catch((err) => log("error", "اتصال اولیه تلگرام:", err.message));
    }

    res.json({ ok: true, message: "ربات راه‌اندازی شد." });
  } catch (err) {
    log("error", "خطا در راه‌اندازی:", err.message);
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post("/api/stop", (req, res) => {
  state.running = false;
  if (state.pollTimeout) clearTimeout(state.pollTimeout);
  res.json({ ok: true, message: "ربات متوقف شد." });
});

app.listen(PORT, () => console.log(`پنل روی پورت ${PORT} اجراست.`));

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
  #toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--card); border: 1px solid var(--border); padding: 10px 18px; border-radius: 10px; font-size: 13px; display: none; max-width: 90%; z-index: 1000; }
  #toast.show { display: block; }
  #toast.ok { border-color: var(--green); }
  #toast.error { border-color: var(--red); }
  .hidden { display: none; }
  .alert-box { background: rgba(234,179,8,0.1); border: 1px solid var(--yellow); border-radius: 8px; padding: 12px; margin-bottom: 14px; color: var(--yellow); font-size: 13px; }
  .debug-box { background: #0b1220; padding: 10px; border-radius: 8px; margin-top: 10px; font-size: 12px; font-family: monospace; }
</style>
</head>
<body>
<div class="container">
  <h1>🤖 پنل ربات پیشرفته روبیکا</h1>
  <div class="subtitle">مدیریت کانال‌ها، گروه‌ها و ربات‌های تلگرامی</div>

  <div class="card">
    <h2>وضعیت سیستم</h2>
    <span id="statusBadge" class="status-badge status-off"><span class="dot"></span> در حال بارگذاری...</span>
    <div class="info-grid" id="infoGrid"></div>
  </div>

  <div class="card">
    <h2>تنظیمات ربات</h2>
    <label>توکن ربات روبیکا</label>
    <input id="rubikaToken" type="text" placeholder="توکن ربات روبیکا" />
    <label>API ID تلگرام</label>
    <input id="tgApiId" type="text" placeholder="عدد API ID" />
    <label>API Hash تلگرام</label>
    <input id="tgApiHash" type="text" placeholder="کاراکترهای API Hash" />
    <button class="btn-primary" onclick="saveConfig()" style="width:100%">💾 ذخیره تنظیمات</button>
    <div id="debugInfo" class="debug-box"></div>
  </div>

  <div class="card" id="loginCard">
    <h2>🔐 اتصال به تلگرام</h2>
    <div id="loginStep1">
      <label>شماره تلفن تلگرام (با کد کشور)</label>
      <input id="tgPhone" type="text" placeholder="+989xxxxxxxxx" />
      <button class="btn-success" onclick="sendCode()" style="width:100%">📱 ارسال کد تایید</button>
    </div>
    <div id="loginStep2" class="hidden">
      <div class="alert-box">✅ کد تایید ارسال شد! تلگرام را چک کنید.</div>
      <label>🔑 کد تایید تلگرام</label>
      <input id="tgCode" type="text" placeholder="کد تایید" autofocus />
      <button class="btn-success" onclick="verifyCode()" style="width:100%">✅ تایید و اتصال</button>
      <button class="btn-primary" onclick="resendCode()" style="width:100%; margin-top:10px">🔄 ارسال مجدد کد</button>
    </div>
  </div>

  <div class="card">
    <h2>کنترل ربات</h2>
    <div class="row">
      <button class="btn-success" onclick="startBot()" style="flex:1">▶️ راه‌اندازی ربات</button>
      <button class="btn-danger" onclick="stopBot()" style="flex:1">⏹ توقف ربات</button>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>
  function showToast(msg, ok) { const el = document.getElementById('toast'); el.textContent = msg; el.className = 'show ' + (ok ? 'ok' : 'error'); setTimeout(() => { el.className = ''; }, 4000); }
  async function saveConfig() {
    try {
      const data = { rubikaToken: document.getElementById('rubikaToken').value, tgApiId: document.getElementById('tgApiId').value, tgApiHash: document.getElementById('tgApiHash').value };
      const res = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await res.json();
      showToast(result.message, result.ok);
      if (result.debug) document.getElementById('debugInfo').innerHTML = \`<div>✅ توکن: \${result.debug.hasToken ? 'دارد' : 'ندارد'}</div><div>✅ API ID: \${result.debug.apiId || 'خالی'}</div><div>✅ API Hash: \${result.debug.hasHash ? 'دارد' : 'ندارد'}</div>\`;
      refreshStatus();
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }
  async function sendCode() {
    const phone = document.getElementById('tgPhone').value;
    if (!phone) { showToast('شماره تلفن را وارد کن', false); return; }
    try {
      const res = await fetch('/api/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
      const data = await res.json();
      if (data.success) { showToast('✅ کد ارسال شد', true); document.getElementById('loginStep1').classList.add('hidden'); document.getElementById('loginStep2').classList.remove('hidden'); document.getElementById('tgCode').focus(); }
      else showToast('❌ ' + data.message, false);
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }
  async function resendCode() {
    const phone = document.getElementById('tgPhone').value;
    try {
      const res = await fetch('/api/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
      const data = await res.json();
      showToast(data.success ? '✅ کد مجدد ارسال شد' : '❌ ' + data.message, data.success);
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }
  async function verifyCode() {
    const code = document.getElementById('tgCode').value;
    try {
      const res = await fetch('/api/verify-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      const data = await res.json();
      if (data.success) { showToast('✅ متصل شدید', true); refreshStatus(); } else showToast('❌ ' + data.message, false);
    } catch (e) { showToast('خطا: ' + e.message, false); }
  }
  async function startBot() { try { const res = await fetch('/api/start', { method: 'POST' }); const data = await res.json(); showToast(data.message, data.ok); refreshStatus(); } catch (e) { showToast('خطا: ' + e.message, false); } }
  async function stopBot() { try { const res = await fetch('/api/stop', { method: 'POST' }); const data = await res.json(); showToast(data.message, data.ok); refreshStatus(); } catch (e) { showToast('خطا: ' + e.message, false); } }
  async function refreshStatus() {
    try {
      const s = await (await fetch('/api/status')).json();
      const badge = document.getElementById('statusBadge');
      if (s.running) { badge.className = 'status-badge status-on'; badge.innerHTML = '<span class="dot"></span> در حال اجرا'; }
      else { badge.className = 'status-badge status-off'; badge.innerHTML = '<span class="dot"></span> متوقف'; }
      let tgStatus = '❌ متصل نیست';
      if (s.tgConnecting) tgStatus = '⏳ در حال اتصال...'; else if (s.isTgLoggedIn) tgStatus = '✅ متصل';
      document.getElementById('infoGrid').innerHTML = \`<div><span>پیام‌ها</span>\${s.messageCount}</div><div><span>وضعیت تلگرام</span>\${tgStatus}</div><div><span>کانال‌های شناخته‌شده</span>\${s.knownChannels}</div><div><span>گروه‌های شناخته‌شده</span>\${s.knownGroups}</div><div><span>اتصال‌های فعال</span>\${s.activeForwards}</div>\`;
      if (s.isTgLoggedIn) document.getElementById('loginCard').innerHTML = '<h2>✅ تلگرام متصل است</h2>';
      else if (s.codeSent) { document.getElementById('loginStep1').classList.add('hidden'); document.getElementById('loginStep2').classList.remove('hidden'); }
    } catch (e) { console.error(e); }
  }
  refreshStatus();
  setInterval(refreshStatus, 3000);
</script>
</body>
</html>`;
}
