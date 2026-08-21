const express = require('express');
const bodyParser = require('body-parser');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs-extra');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- متغیرهای سراسری ---
let client = null;
let stringSession = new StringSession('');
let isLoggedIn = false;
let savedChannels = [];
let pendingLogin = {}; // ذخیره اطلاعات لاگین موقت

// بارگذاری چنل‌های ذخیره شده
const DATA_FILE = path.join(__dirname, 'data.json');
async function loadData() {
    try {
        if (await fs.pathExists(DATA_FILE)) {
            const data = await fs.readJson(DATA_FILE);
            savedChannels = data.savedChannels || [];
            if (data.sessionString) {
                stringSession = new StringSession(data.sessionString);
            }
        }
    } catch (e) {
        console.log('خطا در بارگذاری داده‌ها:', e.message);
    }
}

async function saveData() {
    try {
        await fs.writeJson(DATA_FILE, {
            sessionString: stringSession.save(),
            savedChannels: savedChannels
        });
    } catch (e) {
        console.log('خطا در ذخیره داده‌ها:', e.message);
    }
}

// --- صفحه اصلی ---
app.get('/', (req, res) => {
    res.send(getHTML());
});

// --- API: شروع لاگین ---
app.post('/api/login', async (req, res) => {
    try {
        const { apiId, apiHash, phone } = req.body;

        if (!apiId || !apiHash || !phone) {
            return res.json({ success: false, message: 'همه فیلدها را پر کنید' });
        }

        client = new TelegramClient(
            stringSession,
            parseInt(apiId),
            apiHash,
            { connectionRetries: 5 }
        );

        await client.connect();

        const result = await client.sendCode(
            { apiId: parseInt(apiId), apiHash: apiHash },
            phone
        );

        pendingLogin = {
            apiId: parseInt(apiId),
            apiHash: apiHash,
            phone: phone,
            phoneCodeHash: result.phoneCodeHash
        };

        res.json({ success: true, message: 'کد تایید ارسال شد. کد را وارد کنید.' });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- API: وارد کردن کد تایید ---
app.post('/api/verify', async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.json({ success: false, message: 'کد را وارد کنید' });
        }

        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber: pendingLogin.phone,
                phoneCodeHash: pendingLogin.phoneCodeHash,
                phoneCode: code
            })
        );

        isLoggedIn = true;
        stringSession = new StringSession(client.session.save());
        await saveData();

        res.json({ success: true, message: 'لاگین موفقیت‌آمیز بود!' });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- API: جستجو در چنل ---
app.post('/api/search-channel', async (req, res) => {
    try {
        if (!isLoggedIn) {
            return res.json({ success: false, message: 'ابتدا لاگین کنید' });
        }

        const { channelLink, count } = req.body;

        if (!channelLink || !count) {
            return res.json({ success: false, message: 'لینک و تعداد را وارد کنید' });
        }

        // استخراج نام چنل از لینک
        let channelUsername = channelLink.replace('https://t.me/', '').replace('http://t.me/', '').replace('/', '');

        const entity = await client.getEntity(channelUsername);
        const messages = await client.getMessages(entity, { limit: parseInt(count) });

        let result = [];
        for (const msg of messages) {
            let item = {
                id: msg.id,
                date: msg.date,
                text: msg.message || '',
                type: 'text'
            };

            if (msg.photo) {
                item.type = 'photo';
                try {
                    const buffer = await client.downloadMedia(msg, {});
                    if (buffer) {
                        item.mediaBase64 = Buffer.from(buffer).toString('base64');
                        item.mediaType = 'image/jpeg';
                    }
                } catch (e) {
                    item.mediaError = e.message;
                }
            } else if (msg.document) {
                item.type = 'document';
                try {
                    const buffer = await client.downloadMedia(msg, {});
                    if (buffer) {
                        item.mediaBase64 = Buffer.from(buffer).toString('base64');
                        item.mediaType = 'application/octet-stream';
                        item.fileName = msg.document.attributes?.[0]?.fileName || 'file';
                    }
                } catch (e) {
                    item.mediaError = e.message;
                }
            } else if (msg.video) {
                item.type = 'video';
                try {
                    const buffer = await client.downloadMedia(msg, {});
                    if (buffer) {
                        item.mediaBase64 = Buffer.from(buffer).toString('base64');
                        item.mediaType = 'video/mp4';
                    }
                } catch (e) {
                    item.mediaError = e.message;
                }
            }

            result.push(item);
        }

        res.json({ success: true, messages: result, channelName: entity.title });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- API: دانلود همه پیام‌ها (حالت خودکار) ---
app.post('/api/auto-download', async (req, res) => {
    try {
        if (!isLoggedIn) {
            return res.json({ success: false, message: 'ابتدا لاگین کنید' });
        }

        const { channelLink } = req.body;

        if (!channelLink) {
            return res.json({ success: false, message: 'لینک چنل را وارد کنید' });
        }

        let channelUsername = channelLink.replace('https://t.me/', '').replace('http://t.me/', '').replace('/', '');

        const entity = await client.getEntity(channelUsername);
        const messages = await client.getMessages(entity, { limit: 100 });

        let result = [];
        for (const msg of messages) {
            let item = {
                id: msg.id,
                date: msg.date,
                text: msg.message || '',
                type: 'text'
            };

            if (msg.photo) {
                item.type = 'photo';
                try {
                    const buffer = await client.downloadMedia(msg, {});
                    if (buffer) {
                        item.mediaBase64 = Buffer.from(buffer).toString('base64');
                        item.mediaType = 'image/jpeg';
                    }
                } catch (e) {
                    item.mediaError = e.message;
                }
            } else if (msg.document) {
                item.type = 'document';
                try {
                    const buffer = await client.downloadMedia(msg, {});
                    if (buffer) {
                        item.mediaBase64 = Buffer.from(buffer).toString('base64');
                        item.mediaType = 'application/octet-stream';
                        item.fileName = msg.document.attributes?.[0]?.fileName || 'file';
                    }
                } catch (e) {
                    item.mediaError = e.message;
                }
            }

            result.push(item);
        }

        res.json({ success: true, messages: result, channelName: entity.title });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- API: ذخیره چنل ---
app.post('/api/save-channel', async (req, res) => {
    try {
        const { channelLink, channelName } = req.body;

        if (!channelLink) {
            return res.json({ success: false, message: 'لینک چنل را وارد کنید' });
        }

        const exists = savedChannels.find(ch => ch.link === channelLink);
        if (exists) {
            return res.json({ success: false, message: 'این چنل قبلاً ذخیره شده' });
        }

        savedChannels.push({ link: channelLink, name: channelName || channelLink, date: new Date().toISOString() });
        await saveData();

        res.json({ success: true, message: 'چنل ذخیره شد!' });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- API: دریافت چنل‌های ذخیره شده ---
app.get('/api/saved-channels', (req, res) => {
    res.json({ success: true, channels: savedChannels });
});

// --- API: حذف چنل ذخیره شده ---
app.post('/api/delete-channel', async (req, res) => {
    try {
        const { link } = req.body;
        savedChannels = savedChannels.filter(ch => ch.link !== link);
        await saveData();
        res.json({ success: true, message: 'چنل حذف شد!' });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- API: وضعیت لاگین ---
app.get('/api/status', (req, res) => {
    res.json({ loggedIn: isLoggedIn });
});

// --- API: لاگ‌اوت ---
app.post('/api/logout', async (req, res) => {
    try {
        if (client) {
            await client.destroy();
        }
        isLoggedIn = false;
        stringSession = new StringSession('');
        await saveData();
        res.json({ success: true, message: 'خروج موفقیت‌آمیز بود!' });
    } catch (e) {
        res.json({ success: false, message: 'خطا: ' + e.message });
    }
});

// --- HTML اصلی ---
function getHTML() {
    return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ربات دانلود چنل تلگرام</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: Tahoma, Arial, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
            min-height: 100vh;
            color: #fff;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
            color: #00d4ff;
            text-shadow: 0 0 10px rgba(0, 212, 255, 0.5);
        }
        .card {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
            backdrop-filter: blur(10px);
        }
        .form-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            color: #aaa;
            font-size: 14px;
        }
        input[type="text"], input[type="password"], input[type="number"] {
            width: 100%;
            padding: 12px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 14px;
            direction: ltr;
            text-align: left;
        }
        input:focus {
            outline: none;
            border-color: #00d4ff;
            box-shadow: 0 0 5px rgba(0, 212, 255, 0.3);
        }
        .btn {
            width: 100%;
            padding: 12px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.3s;
            margin-top: 10px;
        }
        .btn-primary {
            background: linear-gradient(135deg, #00d4ff, #0099cc);
            color: #fff;
        }
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0, 212, 255, 0.4);
        }
        .btn-success {
            background: linear-gradient(135deg, #00ff88, #00cc6a);
            color: #1a1a2e;
        }
        .btn-warning {
            background: linear-gradient(135deg, #ffaa00, #ff8800);
            color: #1a1a2e;
        }
        .btn-danger {
            background: linear-gradient(135deg, #ff4444, #cc0000);
            color: #fff;
        }
        .btn-secondary {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .message-list {
            max-height: 500px;
            overflow-y: auto;
            margin-top: 15px;
        }
        .message-item {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
        }
        .message-item img {
            max-width: 100%;
            border-radius: 8px;
            margin-top: 10px;
        }
        .message-text {
            color: #ddd;
            line-height: 1.6;
            white-space: pre-wrap;
        }
        .message-date {
            color: #888;
            font-size: 12px;
            margin-top: 5px;
        }
        .alert {
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 15px;
            text-align: center;
        }
        .alert-success {
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid rgba(0, 255, 136, 0.3);
            color: #00ff88;
        }
        .alert-error {
            background: rgba(255, 68, 68, 0.1);
            border: 1px solid rgba(255, 68, 68, 0.3);
            color: #ff4444;
        }
        .alert-info {
            background: rgba(0, 212, 255, 0.1);
            border: 1px solid rgba(0, 212, 255, 0.3);
            color: #00d4ff;
        }
        .hidden { display: none; }
        .channel-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
        }
        .channel-item .name {
            color: #00d4ff;
            font-weight: bold;
        }
        .channel-item .link {
            color: #888;
            font-size: 12px;
            direction: ltr;
        }
        .loading {
            text-align: center;
            padding: 20px;
            color: #00d4ff;
        }
        .spinner {
            border: 3px solid rgba(255, 255, 255, 0.1);
            border-top: 3px solid #00d4ff;
            border-radius: 50%;
            width: 30px;
            height: 30px;
            animation: spin 1s linear infinite;
            margin: 0 auto 10px;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .menu-btn {
            display: block;
            width: 100%;
            padding: 15px;
            margin-bottom: 10px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s;
            text-align: center;
        }
        .menu-btn:hover {
            background: rgba(0, 212, 255, 0.1);
            border-color: #00d4ff;
            transform: translateX(-5px);
        }
        .status-bar {
            text-align: center;
            padding: 10px;
            margin-bottom: 20px;
            border-radius: 8px;
        }
        .status-online {
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid rgba(0, 255, 136, 0.3);
            color: #00ff88;
        }
        .status-offline {
            background: rgba(255, 68, 68, 0.1);
            border: 1px solid rgba(255, 68, 68, 0.3);
            color: #ff4444;
        }
        .download-btn {
            display: inline-block;
            padding: 5px 10px;
            background: #00d4ff;
            color: #1a1a2e;
            border-radius: 5px;
            text-decoration: none;
            font-size: 12px;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📥 ربات دانلود چنل تلگرام</h1>

        <div id="statusBar" class="status-bar status-offline">
            وضعیت: آفلاین
        </div>

        <!-- فرم لاگین -->
        <div id="loginSection" class="card">
            <h3 style="margin-bottom:15px; color:#00d4ff;">🔐 ورود به حساب تلگرام</h3>
            <div id="loginAlert"></div>
            <div class="form-group">
                <label>API ID</label>
                <input type="text" id="apiId" placeholder="مثلاً: 12345678">
            </div>
            <div class="form-group">
                <label>API Hash</label>
                <input type="text" id="apiHash" placeholder="مثلاً: abc123def456...">
            </div>
            <div class="form-group">
                <label>شماره تلفن (با کد کشور)</label>
                <input type="text" id="phone" placeholder="مثلاً: +989121234567">
            </div>
            <button class="btn btn-primary" onclick="doLogin()">ارسال کد تایید</button>
        </div>

        <!-- فرم کد تایید -->
        <div id="verifySection" class="card hidden">
            <h3 style="margin-bottom:15px; color:#00d4ff;">🔑 وارد کردن کد تایید</h3>
            <div id="verifyAlert"></div>
            <div class="form-group">
                <label>کد تایید ارسال شده به تلگرام</label>
                <input type="text" id="verifyCode" placeholder="کد 5 رقمی">
            </div>
            <button class="btn btn-success" onclick="doVerify()">تایید و ورود</button>
        </div>

        <!-- منوی اصلی -->
        <div id="mainMenu" class="card hidden">
            <h3 style="margin-bottom:15px; color:#00d4ff;">📋 منوی اصلی</h3>
            <button class="menu-btn" onclick="showSection('searchSection')">🔍 جستجو در چنل</button>
            <button class="menu-btn" onclick="showSection('autoSection')">⚡ دانلود خودکار همه پیام‌ها</button>
            <button class="menu-btn" onclick="showSavedChannels()">💾 چنل‌های ذخیره شده</button>
            <button class="btn btn-danger" onclick="doLogout()">🚪 خروج از حساب</button>
        </div>

        <!-- جستجو در چنل -->
        <div id="searchSection" class="card hidden">
            <h3 style="margin-bottom:15px; color:#00d4ff;">🔍 جستجو در چنل</h3>
            <div id="searchAlert"></div>
            <div class="form-group">
                <label>لینک چنل تلگرام</label>
                <input type="text" id="channelLink" placeholder="https://t.me/channelname">
            </div>
            <div class="form-group">
                <label>تعداد آخرین پیام‌ها</label>
                <input type="number" id="msgCount" placeholder="مثلاً: 10" value="10">
            </div>
            <button class="btn btn-primary" onclick="searchChannel()">جستجو</button>
            <button class="btn btn-success" onclick="saveCurrentChannel()">💾 ذخیره چنل</button>
            <button class="btn btn-secondary" onclick="showSection('mainMenu')">بازگشت</button>
            <div id="searchResults"></div>
        </div>

        <!-- دانلود خودکار -->
        <div id="autoSection" class="card hidden">
            <h3 style="margin-bottom:15px; color:#00d4ff;">⚡ دانلود خودکار همه پیام‌ها</h3>
            <div id="autoAlert"></div>
            <div class="form-group">
                <label>لینک چنل تلگرام</label>
                <input type="text" id="autoChannelLink" placeholder="https://t.me/channelname">
            </div>
            <button class="btn btn-warning" onclick="autoDownload()">دانلود همه پیام‌ها</button>
            <button class="btn btn-secondary" onclick="showSection('mainMenu')">بازگشت</button>
            <div id="autoResults"></div>
        </div>

        <!-- چنل‌های ذخیره شده -->
        <div id="savedSection" class="card hidden">
            <h3 style="margin-bottom:15px; color:#00d4ff;">💾 چنل‌های ذخیره شده</h3>
            <div id="savedList"></div>
            <button class="btn btn-secondary" onclick="showSection('mainMenu')">بازگشت</button>
        </div>
    </div>

    <script>
        let currentChannelLink = '';
        let currentChannelName = '';

        // بررسی وضعیت لاگین
        async function checkStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const statusBar = document.getElementById('statusBar');
                if (data.loggedIn) {
                    statusBar.className = 'status-bar status-online';
                    statusBar.textContent = '✅ وضعیت: آنلاین (متصل به تلگرام)';
                    document.getElementById('loginSection').classList.add('hidden');
                    document.getElementById('verifySection').classList.add('hidden');
                    document.getElementById('mainMenu').classList.remove('hidden');
                } else {
                    statusBar.className = 'status-bar status-offline';
                    statusBar.textContent = '❌ وضعیت: آفلاین';
                    document.getElementById('loginSection').classList.remove('hidden');
                    document.getElementById('mainMenu').classList.add('hidden');
                }
            } catch (e) {
                console.error(e);
            }
        }

        function showSection(sectionId) {
            const sections = ['loginSection', 'verifySection', 'mainMenu', 'searchSection', 'autoSection', 'savedSection'];
            sections.forEach(s => document.getElementById(s).classList.add('hidden'));
            document.getElementById(sectionId).classList.remove('hidden');
        }

        function showAlert(containerId, message, type) {
            const container = document.getElementById(containerId);
            container.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
            setTimeout(() => { container.innerHTML = ''; }, 5000);
        }

        // لاگین
        async function doLogin() {
            const apiId = document.getElementById('apiId').value;
            const apiHash = document.getElementById('apiHash').value;
            const phone = document.getElementById('phone').value;

            if (!apiId || !apiHash || !phone) {
                showAlert('loginAlert', 'همه فیلدها را پر کنید', 'error');
                return;
            }

            try {
                const res = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiId, apiHash, phone })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('loginAlert', data.message, 'success');
                    document.getElementById('loginSection').classList.add('hidden');
                    document.getElementById('verifySection').classList.remove('hidden');
                } else {
                    showAlert('loginAlert', data.message, 'error');
                }
            } catch (e) {
                showAlert('loginAlert', 'خطا در اتصال: ' + e.message, 'error');
            }
        }

        // تایید کد
        async function doVerify() {
            const code = document.getElementById('verifyCode').value;
            if (!code) {
                showAlert('verifyAlert', 'کد را وارد کنید', 'error');
                return;
            }

            try {
                const res = await fetch('/api/verify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('verifyAlert', data.message, 'success');
                    setTimeout(() => {
                        checkStatus();
                    }, 1000);
                } else {
                    showAlert('verifyAlert', data.message, 'error');
                }
            } catch (e) {
                showAlert('verifyAlert', 'خطا: ' + e.message, 'error');
            }
        }

        // جستجو در چنل
        async function searchChannel() {
            const channelLink = document.getElementById('channelLink').value;
            const count = document.getElementById('msgCount').value;

            if (!channelLink || !count) {
                showAlert('searchAlert', 'لینک و تعداد را وارد کنید', 'error');
                return;
            }

            currentChannelLink = channelLink;
            document.getElementById('searchResults').innerHTML = '<div class="loading"><div class="spinner"></div>در حال جستجو...</div>';

            try {
                const res = await fetch('/api/search-channel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channelLink, count })
                });
                const data = await res.json();
                if (data.success) {
                    currentChannelName = data.channelName;
                    showAlert('searchAlert', 'چنل "' + data.channelName + '" یافت شد. ' + data.messages.length + ' پیام دریافت شد.', 'success');
                    displayMessages(data.messages, 'searchResults');
                } else {
                    document.getElementById('searchResults').innerHTML = '';
                    showAlert('searchAlert', data.message, 'error');
                }
            } catch (e) {
                document.getElementById('searchResults').innerHTML = '';
                showAlert('searchAlert', 'خطا: ' + e.message, 'error');
            }
        }

        // دانلود خودکار
        async function autoDownload() {
            const channelLink = document.getElementById('autoChannelLink').value;
            if (!channelLink) {
                showAlert('autoAlert', 'لینک چنل را وارد کنید', 'error');
                return;
            }

            document.getElementById('autoResults').innerHTML = '<div class="loading"><div class="spinner"></div>در حال دانلود همه پیام‌ها...</div>';

            try {
                const res = await fetch('/api/auto-download', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channelLink })
                });
                const data = await res.json();
                if (data.success) {
                    showAlert('autoAlert', data.messages.length + ' پیام از چنل "' + data.channelName + '" دانلود شد.', 'success');
                    displayMessages(data.messages, 'autoResults');
                } else {
                    document.getElementById('autoResults').innerHTML = '';
                    showAlert('autoAlert', data.message, 'error');
                }
            } catch (e) {
                document.getElementById('autoResults').innerHTML = '';
                showAlert('autoAlert', 'خطا: ' + e.message, 'error');
            }
        }

        // نمایش پیام‌ها
        function displayMessages(messages, containerId) {
            let html = '<div class="message-list">';
            messages.forEach(msg => {
                html += '<div class="message-item">';
                if (msg.text) {
                    html += '<div class="message-text">' + escapeHtml(msg.text) + '</div>';
                }
                if (msg.type === 'photo' && msg.mediaBase64) {
                    html += '<img src="data:' + msg.mediaType + ';base64,' + msg.mediaBase64 + '" alt="تصویر">';
                    html += '<br><a class="download-btn" href="data:' + msg.mediaType + ';base64,' + msg.mediaBase64 + '" download="photo_' + msg.id + '.jpg">📥 دانلود تصویر</a>';
                }
                if (msg.type === 'document' && msg.mediaBase64) {
                    html += '<a class="download-btn" href="data:' + msg.mediaType + ';base64,' + msg.mediaBase64 + '" download="' + (msg.fileName || 'file') + '">📥 دانلود فایل: ' + (msg.fileName || 'فایل') + '</a>';
                }
                if (msg.mediaError) {
                    html += '<div style="color:#ff4444;font-size:12px;">خطا در دانلود مدیا: ' + msg.mediaError + '</div>';
                }
                html += '<div class="message-date">📅 ' + new Date(msg.date * 1000).toLocaleString('fa-IR') + '</div>';
                html += '</div>';
            });
            html += '</div>';
            document.getElementById(containerId).innerHTML = html;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // ذخیره چنل
        async function saveCurrentChannel() {
            if (!currentChannelLink) {
                showAlert('searchAlert', 'ابتدا یک چنل را جستجو کنید', 'error');
                return;
            }

            try {
                const res = await fetch('/api/save-channel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ channelLink: currentChannelLink, channelName: currentChannelName })
                });
                const data = await res.json();
                showAlert('searchAlert', data.message, data.success ? 'success' : 'error');
            } catch (e) {
                showAlert('searchAlert', 'خطا: ' + e.message, 'error');
            }
        }

        // نمایش چنل‌های ذخیره شده
        async function showSavedChannels() {
            showSection('savedSection');
            try {
                const res = await fetch('/api/saved-channels');
                const data = await res.json();
                if (data.success) {
                    if (data.channels.length === 0) {
                        document.getElementById('savedList').innerHTML = '<div class="alert alert-info">هنوز چنلی ذخیره نشده</div>';
                    } else {
                        let html = '';
                        data.channels.forEach(ch => {
                            html += '<div class="channel-item">';
                            html += '<div><div class="name">' + escapeHtml(ch.name) + '</div>';
                            html += '<div class="link">' + escapeHtml(ch.link) + '</div></div>';
                            html += '<button class="btn btn-danger" style="width:auto;padding:8px 15px;margin:0;" onclick="deleteChannel(\\'' + ch.link + '\\')">🗑️</button>';
                            html += '</div>';
                        });
                        document.getElementById('savedList').innerHTML = html;
                    }
                }
            } catch (e) {
                document.getElementById('savedList').innerHTML = '<div class="alert alert-error">خطا: ' + e.message + '</div>';
            }
        }

        // حذف چنل
        async function deleteChannel(link) {
            try {
                const res = await fetch('/api/delete-channel', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ link })
                });
                const data = await res.json();
                showSavedChannels();
            } catch (e) {
                alert('خطا: ' + e.message);
            }
        }

        // خروج
        async function doLogout() {
            if (!confirm('آیا مطمئن هستید؟')) return;
            try {
                await fetch('/api/logout', { method: 'POST' });
                checkStatus();
            } catch (e) {
                alert('خطا: ' + e.message);
            }
        }

        // شروع
        checkStatus();
    </script>
</body>
</html>
    `;
}

// --- شروع سرور ---
const PORT = process.env.PORT || 3000;

async function start() {
    await loadData();

    // تلاش برای اتصال مجدد با session ذخیره شده
    if (stringSession.save() !== '') {
        try {
            client = new TelegramClient(
                stringSession,
                0, // این مقادیر بعداً تنظیم می‌شوند
                '',
                { connectionRetries: 5 }
            );
            // اگر session معتبر باشد، خودکار متصل می‌شود
        } catch (e) {
            console.log('Session قبلی معتبر نیست');
        }
    }

    app.listen(PORT, () => {
        console.log('🚀 سرور روی پورت ' + PORT + ' اجرا شد');
        console.log('🌐 آدرس: https://your-app-name.up.railway.app');
    });
}

start();
