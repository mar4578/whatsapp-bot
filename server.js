const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');

// --- إعدادات الخادم ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(express.json());

// --- إدارة الملفات وقاعدة البيانات ---
const DATA_DIR = './data';
const SESSIONS_DIR = './sessions';
fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(SESSIONS_DIR);

const DB_FILE = path.join(DATA_DIR, 'database.json');
const SESSIONS_LIST_FILE = path.join(DATA_DIR, 'sessions_list.json');

// تحميل البيانات
let db = { users: {} };
let activeSessionsList = [];

// دالة لحفظ وتحديث قائمة الجلسات النشطة
function loadData() {
    try {
        if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE));
        if (fs.existsSync(SESSIONS_LIST_FILE)) activeSessionsList = JSON.parse(fs.readFileSync(SESSIONS_LIST_FILE));
    } catch (e) {
        console.error("Error loading data:", e);
    }
}
loadData();

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function saveSessionsList() {
    fs.writeFileSync(SESSIONS_LIST_FILE, JSON.stringify(activeSessionsList, null, 2));
}

// تهيئة بيانات مستخدم جديد
function initUserDB(sessionId) {
    if (!db.users[sessionId]) {
        db.users[sessionId] = {
            queue: [],
            currentIndex: 0,
            interval: 10,
            isRunning: false,
            totalJoined: 0,
            status: 'disconnected', // disconnected, connecting, connected
            phone: ''
        };
        saveDB();
    }
}

// --- إدارة اتصالات الواتساب ---
const waSessions = {}; // تخزين كائنات الاتصال الحية

// تشغيل جميع الجلسات المحفوظة عند بدء الخادم
async function restoreSessions() {
    console.log('Restoring sessions...', activeSessionsList);
    for (const sessionId of activeSessionsList) {
        await startWASession(sessionId, { isRestore: true });
    }
}
restoreSessions();

// دالة إنشاء/استعادة جلسة
async function startWASession(sessionId, options = {}) {
    const { isRestore = false, usePairingCode = false, phoneNumber = '' } = options;
    
    // إضافة للقائمة إذا جديد
    if (!activeSessionsList.includes(sessionId)) {
        activeSessionsList.push(sessionId);
        saveSessionsList();
    }

    initUserDB(sessionId);
    
    // تحديث الحالة
    db.users[sessionId].status = 'connecting';
    io.emit('sessionUpdate', { sessionId, data: db.users[sessionId] });

    const { state, saveCreds } = await useMultiFileAuthState(path.join(SESSIONS_DIR, sessionId));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Professional Joiner", "Chrome", "3.0.0"],
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
    });

    waSessions[sessionId] = sock;

    // --- منطق كود الاقتران (Pairing Code) ---
    if (usePairingCode && !sock.authState.creds.registered) {
        // انتظار بسيط للتأكد من جاهزية الاتصال
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`Pairing code for ${sessionId}: ${code}`);
                io.emit('pairingCode', { sessionId, code });
            } catch (err) {
                console.error('Failed to request pairing code:', err);
                io.emit('log', { message: `فشل طلب كود الاقتران للجلسة ${sessionId}` });
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // إرسال QR فقط إذا لم نستخدم كود الاقتران
        if (qr && !usePairingCode) {
            try {
                const qrImage = await QRCode.toDataURL(qr);
                io.emit('qr', { sessionId, src: qrImage });
            } catch (err) { console.error(err); }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            db.users[sessionId].status = 'disconnected';
            io.emit('sessionUpdate', { sessionId, data: db.users[sessionId] });

            if (shouldReconnect) {
                startWASession(sessionId, { isRestore: true });
            } else {
                // تم تسجيل الخروج
                if(activeSessionsList.includes(sessionId)) {
                     io.emit('log', { message: `تم تسجيل الخروج من الجلسة: ${sessionId}` });
                }
                delete waSessions[sessionId];
            }

        } else if (connection === 'open') {
            const userPhone = sock.user.id.split(':')[0];
            db.users[sessionId].status = 'connected';
            db.users[sessionId].phone = userPhone;
            saveDB();
            
            io.emit('sessionUpdate', { sessionId, data: db.users[sessionId] });
            io.emit('log', { message: `✅ الجلسة ${sessionId} متصلة (${userPhone})` });

            // استكمال الانضمام إذا كان مفعلاً
            if (db.users[sessionId].isRunning) {
                processQueue(sessionId);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ملاحظة: تم إزالة الاستماع للرسائل (messages.upsert) بالكامل
    // لضمان عدم تأثر البوت بروابط الشات وعدم الرد
}

// --- معالجة الحذف وتسجيل الخروج ---
async function deleteSession(sessionId) {
    try {
        if (waSessions[sessionId]) {
            await waSessions[sessionId].logout();
            delete waSessions[sessionId];
        }
    } catch (e) { console.error('Logout error', e); }

    // حذف البيانات
    activeSessionsList = activeSessionsList.filter(id => id !== sessionId);
    saveSessionsList();
    
    if (db.users[sessionId]) {
        delete db.users[sessionId];
        saveDB();
    }
    
    // حذف ملفات الجلسة
    fs.removeSync(path.join(SESSIONS_DIR, sessionId));
    
    io.emit('sessionDeleted', sessionId);
}

// --- محرك الانضمام (Queue Processor) ---
async function processQueue(sessionId) {
    const userData = db.users[sessionId];
    const sock = waSessions[sessionId];

    if (!userData || !userData.isRunning || !sock) return;

    if (userData.currentIndex >= userData.queue.length) {
        userData.isRunning = false;
        saveDB();
        io.emit('sessionUpdate', { sessionId, data: userData });
        io.emit('log', { message: `🎉 اكتملت قائمة الروابط للجلسة ${sessionId}` });
        return;
    }

    const code = userData.queue[userData.currentIndex];
    
    try {
        io.emit('log', { message: `[${sessionId}] جاري الانضمام للرابط ${userData.currentIndex + 1}...` });
        
        await sock.groupAcceptInvite(code);
        
        userData.totalJoined++;
        io.emit('log', { message: `✅ [${sessionId}] تم الانضمام بنجاح!` });

    } catch (error) {
        const errStr = error.toString();
        let logMsg = `❌ [${sessionId}] فشل (${code}): `;

        if (errStr.includes('429')) {
            userData.isRunning = false; // إيقاف إجباري
            saveDB();
            io.emit('sessionUpdate', { sessionId, data: userData });
            io.emit('log', { message: `🚨 [${sessionId}] توقف أمني (Rate Limit).` });
            return;
        } else if (errStr.includes('401') || errStr.includes('Gone')) {
            logMsg += "رابط منتهي";
        } else if (errStr.includes('409') || errStr.includes('Participant')) {
            logMsg += "مشترك بالفعل";
        } else {
            logMsg += "خطأ غير معروف";
        }
        
        io.emit('log', { message: logMsg });
    }

    userData.currentIndex++;
    saveDB();
    io.emit('sessionUpdate', { sessionId, data: userData });

    const waitTime = userData.interval * 1000;
    setTimeout(() => {
        processQueue(sessionId);
    }, waitTime);
}

// --- Socket.IO Handlers ---
io.on('connection', (socket) => {
    // إرسال البيانات الأولية
    socket.emit('init', { 
        sessions: activeSessionsList, 
        users: db.users 
    });

    // إنشاء جلسة جديدة
    socket.on('createSession', ({ sessionId, method, phoneNumber }) => {
        if (!sessionId) return;
        startWASession(sessionId, { 
            usePairingCode: method === 'phone', 
            phoneNumber: phoneNumber 
        });
    });

    // حذف جلسة
    socket.on('deleteSession', (sessionId) => {
        deleteSession(sessionId);
    });

    // إضافة روابط (من لوحة التحكم فقط)
    socket.on('addLinks', ({ sessionIds, links }) => {
        // استخراج الروابط
        const urlRegex = /(?:chat\.whatsapp\.com\/|whatsapp\.com\/channel\/)([0-9A-Za-z]{20,24})/g;
        let match;
        const validCodes = [];
        while ((match = urlRegex.exec(links)) !== null) validCodes.push(match[1]);

        if (validCodes.length === 0) return;

        sessionIds.forEach(id => {
            if (db.users[id]) {
                const unique = validCodes.filter(c => !db.users[id].queue.includes(c));
                db.users[id].queue.push(...unique);
            }
        });
        saveDB();
        
        // إرسال تحديث شامل
        sessionIds.forEach(id => {
            io.emit('sessionUpdate', { sessionId: id, data: db.users[id] });
        });
        
        socket.emit('log', { message: `📥 تم توزيع ${validCodes.length} رابط على ${sessionIds.length} حسابات.` });
    });

    // التحكم (تشغيل/إيقاف/وقت)
    socket.on('control', ({ sessionIds, action, value }) => {
        sessionIds.forEach(id => {
            if (!db.users[id]) return;

            if (action === 'start') {
                if (!db.users[id].isRunning) {
                    db.users[id].isRunning = true;
                    processQueue(id);
                }
            } else if (action === 'stop') {
                db.users[id].isRunning = false;
            } else if (action === 'interval') {
                db.users[id].interval = parseInt(value) || 10;
            } else if (action === 'clear') {
                db.users[id].queue = [];
                db.users[id].currentIndex = 0;
                db.users[id].isRunning = false;
                db.users[id].totalJoined = 0;
            }
        });
        saveDB();
        
        // تحديث الواجهة
        sessionIds.forEach(id => {
            io.emit('sessionUpdate', { sessionId: id, data: db.users[id] });
        });
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

