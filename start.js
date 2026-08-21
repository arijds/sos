const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs-extra');
const path = require('path');
const input = require('input'); // برای لاگین اولیه در صورت نیاز

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- متغیرهای سراسری ---
let RUBIKA_TOKEN = '';
let tgClient = null;
let tgApiId = 0;
let tgApiHash = '';
let tgPhone = '';
let phoneCodeHash = '';
let isLoggedIn = false;
let savedChannels = [];
let userState = {}; // وضعیت کاربر در ربات روبیکا
let lastUpdateId = 0;

const CONFIG_FILE = path.join(__dirname, 'config.json');
const DATA_FILE = path.join(__dirname, 'data.json');

// بارگذاری داده‌ها
async function loadConfig() {
    if (await fs.pathExists(CONFIG_FILE)) {
        const config = await fs.readJson(CONFIG_FILE);
        RUBIKA_TOKEN = config.rubikaToken || '';
        tgApiId = config.apiId || 0;
        tgApiHash = config.apiHash || '';
        tgPhone = config.phone || '';
    }
    if (await fs.pathExists(DATA_FILE)) {
        const data = await fs.readJson(DATA_FILE);
        savedChannels = data.savedChannels || [];
        if (data.session) {
            const stringSession = new StringSession(data.session);
            if (tgApiId && tgApiHash) {
                tgClient = new TelegramClient(stringSession, tgApiId, tgApiHash, { connectionRetries: 5 });
            }
        }
    }
}

async function saveConfig() {
    await fs.writeJson(CONFIG_FILE, { rubikaToken: RUBIKA_TOKEN, apiId: tgApiId, apiHash: tgApiHash, phone: tgPhone });
}

async function saveData() {
    await fs.writeJson(DATA_FILE, { session: tgClient?.session?.save() || '', savedChannels });
}

// --- توابع ارتباط با روبیکا ---
async function rubikaRequest(method, params = {}, isFormData = false) {
    try {
        const url = `https://botapi.rubika.ir/bot${RUBIKA_TOKEN}/${method}`;
        if (isFormData) {
            return await axios.post(url, params, { headers: params.getHeaders() });
        } else {
            return await axios.post(url, params);
        }
    } catch (e) {
        console.error(`Rubika API Error (${method}):`, e.response?.data || e.message);
        return { ok: false, description: e.message };
    }
}

async function sendMessage(chatId, text, keyboard = null) {
    const params = { chat_id: chatId, text };
    if (keyboard) params.reply_markup = JSON.stringify({ inline_keyboard: keyboard });
    return await rubikaRequest('sendMessage', params);
}

async function sendPhoto(chatId, buffer, caption = '') {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', buffer, { filename: 'photo.jpg', contentType: 'image/jpeg' });
    if (caption) form.append('caption', caption);
    return await rubikaRequest('sendPhoto', form, true);
}

async function sendDocument(chatId, buffer, fileName, caption = '') {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', buffer, { filename: fileName, contentType: 'application/octet-stream' });
    if (caption) form.append('caption', caption);
    return await rubikaRequest('sendDocument', form, true);
}

// --- منوی اصلی ربات ---
function getMainMenu() {
    return [
        [{ text: '🔍 جستجو در چنل', callback_data: 'search_channel' }],
        [{ text: '⚡ دانلود سریع همه پیام‌ها', callback_data: 'fast_download' }],
        [{ text: '💾 چنل‌های ذخیره شده', callback_data: 'saved_channels' }]
    ];
}

// --- پردازش آپدیت‌های روبیکا ---
async function processUpdate(update) {
    if (update.update_id <= lastUpdateId) return;
    lastUpdateId = update.update_id;

    let chatId = '';
    let text = '';
    let callbackData = '';

    if (update.message) {
        chatId = update.message.chat.id;
        text = update.message.text || '';
    } else if (update.callback_query) {
        chatId = update.callback_query.message.chat.id;
        callbackData = update.callback_query.data;
        await rubikaRequest('answerCallbackQuery', { callback_query_id: update.callback_query.id });
    } else return;

    // مدیریت وضعیت‌ها (State Machine)
    if (!userState[chatId]) userState[chatId] = { state: 'idle' };
    const state = userState[chatId];

    // اگر دکمه‌ای زده شده
    if (callbackData) {
        if (callbackData === 'search_channel') {
            state.state = 'waiting_for_link';
            state.action = 'search';
            await sendMessage(chatId, '🔗 لینک چنل تلگرام را ارسال کنید:\n(مثال: https://t.me/durov)');
        } else if (callbackData === 'fast_download') {
            state.state = 'waiting_for_link';
            state.action = 'fast';
            await sendMessage(chatId, '🔗 لینک چنل تلگرام را برای دانلود سریع ارسال کنید:');
        } else if (callbackData === 'saved_channels') {
            await showSavedChannels(chatId);
        } else if (callbackData.startsWith('save_ch_')) {
            const link = callbackData.replace('save_ch_', '');
            if (!savedChannels.find(c => c.link === link)) {
                savedChannels.push({ link, name: state.currentChannelName || link });
                await saveData();
                await sendMessage(chatId, '✅ چنل با موفقیت ذخیره شد!');
            } else {
                await sendMessage(chatId, '⚠️ این چنل قبلاً ذخیره شده است.');
            }
            state.state = 'idle';
            await sendMessage(chatId, 'منوی اصلی:', getMainMenu());
        }
        return;
    }

    // مدیریت پیام‌های متنی بر اساس وضعیت
    if (state.state === 'waiting_for_code') {
        // وارد کردن کد تلگرام
        try {
            await tgClient.invoke(new (require('telegram').Api).auth.SignIn({
                phoneNumber: tgPhone,
                phoneCodeHash: phoneCodeHash,
                phoneCode: text.trim()
            }));
            isLoggedIn = true;
            await saveData();
            await sendMessage(chatId, '✅ با موفقیت به تلگرام متصل شدیم!\nحالا می‌تونی از منوی اصلی استفاده کنی.');
            state.state = 'idle';
            await sendMessage(chatId, 'منوی اصلی:', getMainMenu());
        } catch (e) {
            await sendMessage(chatId, '❌ کد اشتباه است یا خطایی رخ داد: ' + e.message);
        }
    } 
    else if (state.state === 'waiting_for_link') {
        state.currentChannelLink = text.trim();
        if (state.action === 'search') {
            state.state = 'waiting_for_count';
            await sendMessage(chatId, '🔢 چند تا از آخرین پیام‌ها رو بفرستم؟ (مثلاً: 10)');
        } else if (state.action === 'fast') {
            state.state = 'busy';
            await sendMessage(chatId, '⏳ در حال دانلود سریع همه پیام‌ها...');
            await fetchAndSendMessages(chatId, state.currentChannelLink, 100, true);
            state.state = 'idle';
            await sendMessage(chatId, 'منوی اصلی:', getMainMenu());
        }
    } 
    else if (state.state === 'waiting_for_count') {
        const count = parseInt(text);
        if (isNaN(count) || count < 1) {
            await sendMessage(chatId, '❌ لطفاً یک عدد معتبر وارد کنید.');
            return;
        }
        state.state = 'busy';
        await sendMessage(chatId, `⏳ در حال دریافت ${count} پیام آخر...`);
        await fetchAndSendMessages(chatId, state.currentChannelLink, count, false);
        
        // پرسیدن برای ذخیره
        const keyboard = [[{ text: '✅ ذخیره چنل', callback_data: `save_ch_${state.currentChannelLink}` }]];
        await sendMessage(chatId, 'آیا می‌خواهید این چنل را ذخیره کنید؟', keyboard);
        state.state = 'idle';
    } 
    else if (text === '/start') {
        if (!isLoggedIn) {
            await sendMessage(chatId, '⚠️ ابتدا باید از طریق سایت تنظیمات، اکانت تلگرام را متصل کنید.');
        } else {
            await sendMessage(chatId, '👋 خوش آمدید!\nاز منوی زیر انتخاب کنید:', getMainMenu());
        }
    }
}

// --- دریافت و ارسال پیام‌ها از تلگرام به روبیکا ---
async function fetchAndSendMessages(chatId, channelLink, count, isFast) {
    try {
        let username = channelLink.replace('https://t.me/', '').replace('http://t.me/', '').replace('/', '');
        const entity = await tgClient.getEntity(username);
        userState[chatId].currentChannelName = entity.title;
        
        const messages = await tgClient.getMessages(entity, { limit: count });
        
        if (messages.length === 0) {
            await sendMessage(chatId, '❌ پیامی در این چنل یافت نشد.');
            return;
        }

        await sendMessage(chatId, `📥 شروع ارسال ${messages.length} پیام از چنل "${entity.title}"...`);

        for (const msg of messages) {
            let caption = msg.message || '';
            if (caption.length > 1000) caption = caption.substring(0, 1000) + '...';

            if (msg.photo) {
                try {
                    const buffer = await tgClient.downloadMedia(msg, {});
                    if (buffer) await sendPhoto(chatId, buffer, caption);
                } catch (e) {
                    await sendMessage(chatId, `📝 [متن پیام]:\n${caption}`);
                }
            } else if (msg.document) {
                try {
                    const buffer = await tgClient.downloadMedia(msg, {});
                    const fileName = msg.document.attributes?.[0]?.fileName || 'file';
                    if (buffer) await sendDocument(chatId, buffer, fileName, caption);
                } catch (e) {
                    await sendMessage(chatId, `📝 [متن پیام]:\n${caption}`);
                }
            } else {
                if (caption) await sendMessage(chatId, `📝 ${caption}`);
            }
        }
        await sendMessage(chatId, '✅ ارسال همه پیام‌ها تمام شد!');
    } catch (e) {
        await sendMessage(chatId, '❌ خطا در دریافت پیام‌ها: ' + e.message);
    }
}

// --- نمایش چنل‌های ذخیره شده ---
async function showSavedChannels(chatId) {
    if (savedChannels.length === 0) {
        await sendMessage(chatId, '💾 هیچ چنلی ذخیره نشده است.');
        return;
    }
    let text = '💾 لیست چنل‌های ذخیره شده:\n\n';
    const keyboard = [];
    savedChannels.forEach((ch, index) => {
        text += `${index + 1}. ${ch.name}\n`;
        keyboard.push([{ text: `🔍 جستجو در ${ch.name}`, callback_data: `saved_search_${index}` }]);
    });
    // نکته: برای سادگی، کلیک روی چنل‌های ذخیره شده رو اینجا هندل نکردیم، 
    // ولی می‌تونی مشابه بالا state رو تغییر بدی.
    await sendMessage(chatId, text);
}

// --- شروع ربات (Polling) ---
async function startRubikaPolling() {
    console.log('🤖 شروع دریافت پیام‌های روبیکا...');
    setInterval(async () => {
        if (!RUBIKA_TOKEN) return;
        try {
            const res = await axios.get(`https://botapi.rubika.ir/bot${RUBIKA_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=1`);
            if (res.data.ok && res.data.result.length > 0) {
                for (const update of res.data.result) {
                    await processUpdate(update);
                }
            }
        } catch (e) {
            // خطاهای تایم‌اوت رو نادیده بگیر
        }
    }, 2000);
}

// --- مسیرهای سایت (برای تنظیمات اولیه) ---
app.get('/', (req, res) => {
    if (RUBIKA_TOKEN && isLoggedIn) {
        return res.send('<h2 style="text-align:center;font-family:Tahoma;">✅ ربات فعال است. به روبیکا بروید!</h2>');
    }
    res.send(`
        <!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><title>تنظیمات ربات</title>
        <style>body{font-family:Tahoma;background:#f4f4f9;padding:20px;} .box{max-width:400px;margin:50px auto;background:#fff;padding:30px;border-radius:10px;box-shadow:0 0 10px rgba(0,0,0,0.1);} input{width:100%;padding:10px;margin:10px 0;border:1px solid #ddd;border-radius:5px;} button{width:100%;padding:12px;background:#007bff;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:16px;}</style>
        </head><body><div class="box"><h2 style="text-align:center;">⚙️ تنظیمات ربات</h2>
        <form method="POST" action="/setup">
        <label>توکن ربات روبیکا:</label><input type="text" name="rubikaToken" required>
        <label>Telegram API ID:</label><input type="text" name="apiId" required>
        <label>Telegram API Hash:</label><input type="text" name="apiHash" required>
        <label>شماره تلفن تلگرام (با کد کشور):</label><input type="text" name="phone" placeholder="+989..." required>
        <button type="submit">ذخیره و شروع</button>
        </form></div></body></html>
    `);
});

app.post('/setup', async (req, res) => {
    RUBIKA_TOKEN = req.body.rubikaToken;
    tgApiId = parseInt(req.body.apiId);
    tgApiHash = req.body.apiHash;
    tgPhone = req.body.phone;

    await saveConfig();

    // اتصال به تلگرام
    const stringSession = new StringSession('');
    tgClient = new TelegramClient(stringSession, tgApiId, tgApiHash, { connectionRetries: 5 });
    await tgClient.connect();

    try {
        const result = await tgClient.sendCode({ apiId: tgApiId, apiHash: tgApiHash }, tgPhone);
        phoneCodeHash = result.phoneCodeHash;
        
        // پیدا کردن چت ادمین در روبیکا (فرض بر اینه که اولین کسی که استارت بزنه ادمینه)
        // در یک نسخه پیشرفته‌تر باید chat_id ادمین رو از قبل داشته باشیم.
        res.send('<h2 style="text-align:center;font-family:Tahoma;color:green;">✅ تنظیمات ذخیره شد.<br>کد به تلگرام شما ارسال شد.<br>لطفاً در روبیکا به ربات پیام دهید و کد را وارد کنید.</h2>');
        
        // تنظیم وضعیت برای اولین کاربری که پیام داد
        userState['admin'] = { state: 'waiting_for_code' }; 
    } catch (e) {
        res.send('<h2 style="text-align:center;font-family:Tahoma;color:red;">❌ خطا: ' + e.message + '</h2>');
    }
});

// --- شروع سرور ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`🌐 سرور روی پورت ${PORT} اجرا شد`);
    await loadConfig();
    if (RUBIKA_TOKEN) {
        startRubikaPolling();
        if (tgClient) {
            try {
                await tgClient.connect();
                isLoggedIn = true;
                console.log('✅ کلاینت تلگرام متصل شد.');
            } catch (e) {
                console.log('⚠️ کلاینت تلگرام نیاز به لاگین دارد.');
            }
        }
    }
});
