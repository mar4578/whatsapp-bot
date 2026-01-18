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
            status: 'disconnected', 
            phone: ''
        };
        saveDB();
    }
}

// --- إدارة اتصالات الواتساب ---
const waSessions = {}; 

// استعادة الجلسات عند التشغيل
async function restoreSessions() {
    console.log('Restoring sessions...', activeSessionsList);
    for (const sessionId of activeSessionsList) {
        await startWASession(sessionId, { isRestore: true });
    }
}
restoreSessions();

async function startWASession(sessionId, options = {}) {
    const { isRestore = false, usePairingCode = false, phoneNumber = '' } = options;
    
    if (!activeSessionsList.includes(sessionId)) {
        activeSessionsList.push(sessionId);
        saveSessionsList();
    }

    initUserDB(sessionId);
    db.users[sessionId].status = 'connecting';
    
    // إرسال التحديث فقط لمن يراقب هذه الجلسة (الغرفة)
    io.to(sessionId).emit('sessionUpdate', { sessionId, data: db.users[sessionId] });

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

    if (usePairingCode && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log(`Pairing code for ${sessionId}: ${code}`);
                // إرسال الكود للغرفة الخاصة بالجلسة فقط
                io.to(sessionId).emit('pairingCode', { sessionId, code });
            } catch (err) {
                console.error('Failed to request pairing code:', err);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !usePairingCode) {
            try {
                const qrImage = await QRCode.toDataURL(qr);
                // إرسال QR للغرفة الخاصة بالجلسة فقط
                io.to(sessionId).emit('qr', { sessionId, src: qrImage });
            } catch (err) { console.error(err); }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            db.users[sessionId].status = 'disconnected';
            io.to(sessionId).emit('sessionUpdate', { sessionId, data: db.users[sessionId] });

            if (shouldReconnect) {
                startWASession(sessionId, { isRestore: true });
            } else {
                if(activeSessionsList.includes(sessionId)) {
                     io.to(sessionId).emit('log', { message: `تم تسجيل الخروج من الجلسة: ${sessionId}` });
                }
                delete waSessions[sessionId];
            }

        } else if (connection === 'open') {
            const userPhone = sock.user.id.split(':')[0];
            db.users[sessionId].status = 'connected';
            db.users[sessionId].phone = userPhone;
            saveDB();
            
            io.to(sessionId).emit('sessionUpdate', { sessionId, data: db.users[sessionId] });
            io.to(sessionId).emit('sessionConnected', sessionId); // إشعار للمستخدم لحفظ الجلسة
            io.to(sessionId).emit('log', { message: `✅ الجلسة ${sessionId} متصلة (${userPhone})` });

            if (db.users[sessionId].isRunning) {
                processQueue(sessionId);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

async function deleteSession(sessionId) {
    try {
        if (waSessions[sessionId]) {
            await waSessions[sessionId].logout();
            delete waSessions[sessionId];
        }
    } catch (e) { console.error('Logout error', e); }

    activeSessionsList = activeSessionsList.filter(id => id !== sessionId);
    saveSessionsList();
    
    if (db.users[sessionId]) {
        delete db.users[sessionId];
        saveDB();
    }
    
    try { fs.removeSync(path.join(SESSIONS_DIR, sessionId)); } catch(e) {}
    
    io.to(sessionId).emit('sessionDeleted', sessionId);
}

async function processQueue(sessionId) {
    const userData = db.users[sessionId];
    const sock = waSessions[sessionId];

    if (!userData || !userData.isRunning || !sock) return;

    if (userData.currentIndex >= userData.queue.length) {
        userData.isRunning = false;
        saveDB();
        io.to(sessionId).emit('sessionUpdate', { sessionId, data: userData });
        io.to(sessionId).emit('log', { message: `🎉 اكتملت قائمة الروابط للجلسة ${sessionId}` });
        return;
    }

    const code = userData.queue[userData.currentIndex];
    
    try {
        io.to(sessionId).emit('log', { message: `[${sessionId}] جاري الانضمام للرابط ${userData.currentIndex + 1}...` });
        
        await sock.groupAcceptInvite(code);
        
        userData.totalJoined++;
        io.to(sessionId).emit('log', { message: `✅ [${sessionId}] تم الانضمام بنجاح!` });

    } catch (error) {
        const errStr = error.toString();
        let logMsg = `❌ [${sessionId}] فشل (${code}): `;

        if (errStr.includes('429')) {
            userData.isRunning = false;
            saveDB();
            io.to(sessionId).emit('sessionUpdate', { sessionId, data: userData });
            io.to(sessionId).emit('log', { message: `🚨 [${sessionId}] توقف أمني (Rate Limit).` });
            return;
        } else if (errStr.includes('401') || errStr.includes('Gone')) {
            logMsg += "رابط منتهي";
        } else if (errStr.includes('409') || errStr.includes('Participant')) {
            logMsg += "مشترك بالفعل";
        } else {
            logMsg += "خطأ غير معروف";
        }
        
        io.to(sessionId).emit('log', { message: logMsg });
    }

    userData.currentIndex++;
    saveDB();
    io.to(sessionId).emit('sessionUpdate', { sessionId, data: userData });

    const waitTime = userData.interval * 1000;
    setTimeout(() => {
        processQueue(sessionId);
    }, waitTime);
}

// --- Socket.IO Handlers (نظام الغرف) ---
io.on('connection', (socket) => {
    
    // المستخدم يطلب الاشتراك في جلساته الخاصة فقط
    socket.on('subscribe', (mySessions) => {
        if(Array.isArray(mySessions)) {
            mySessions.forEach(sessId => {
                socket.join(sessId); // الانضمام لغرفة الجلسة
                if(db.users[sessId]) {
                    // إرسال بيانات الجلسة فوراً
                    socket.emit('sessionUpdate', { sessionId: sessId, data: db.users[sessId] });
                }
            });
        }
    });

    socket.on('createSession', ({ sessionId, method, phoneNumber }) => {
        if (!sessionId) return;
        
        // الانضمام لغرفة هذه الجلسة فوراً لاستقبال الـ QR
        socket.join(sessionId); 

        startWASession(sessionId, { 
            usePairingCode: method === 'phone', 
            phoneNumber: phoneNumber 
        });
    });

    socket.on('deleteSession', (sessionId) => {
        deleteSession(sessionId);
    });

    socket.on('addLinks', ({ sessionIds, links }) => {
        const urlRegex = /(?:chat\.whatsapp\.com\/|whatsapp\.com\/channel\/)([0-9A-Za-z]{20,24})/g;
        let match;
        const validCodes = [];
        while ((match = urlRegex.exec(links)) !== null) validCodes.push(match[1]);

        if (validCodes.length === 0) return;

        sessionIds.forEach(id => {
            if (db.users[id]) {
                const unique = validCodes.filter(c => !db.users[id].queue.includes(c));
                db.users[id].queue.push(...unique);
                saveDB();
                // تحديث الغرفة الخاصة بهذه الجلسة
                io.to(id).emit('sessionUpdate', { sessionId: id, data: db.users[id] });
                io.to(id).emit('log', { message: `📥 تم إضافة ${unique.length} رابط جديد.` });
            }
        });
    });

    // إصلاح مشكلة الوقت والتحكم
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
                // التأكد من تحويل القيمة لرقم صحيح
                const newInterval = parseInt(value);
                if (!isNaN(newInterval) && newInterval > 0) {
                    db.users[id].interval = newInterval;
                }
            } else if (action === 'clear') {
                db.users[id].queue = [];
                db.users[id].currentIndex = 0;
                db.users[id].isRunning = false;
                db.users[id].totalJoined = 0;
            }
            
            // تحديث الغرفة الخاصة
            io.to(id).emit('sessionUpdate', { sessionId: id, data: db.users[id] });
        });
        saveDB();
        
        if(action === 'interval') {
            socket.emit('log', { message: `⏱️ تم تحديث الوقت لـ ${value} ثواني` });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});