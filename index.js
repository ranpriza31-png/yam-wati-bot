const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT_BILLING = process.env.PROMPT_BILLING ||
  `אתה נציג גבייה של חברת ים אחזקות - חברה לניהול ואחזקת מבנים בישראל.
תפקידך לסייע בנושאי גבייה: דמי ועד בית, חובות, חשבוניות, הוראות קבע.
ענה תמיד בעברית, בצורה מקצועית, ידידותית וקצרה.
אם אינך יודע - אמור "אעביר לנציג" ואל תמציא מידע.`;

const PROMPT_ISSUES = process.env.PROMPT_ISSUES ||
  `אתה נציג תחזוקה של חברת ים אחזקות - חברה לניהול ואחזקת מבנים בישראל.
תפקידך לקבל דיווחי תקלות: תיאור הבעיה, כתובת, פרטי דייר.
לאחר קבלת הפרטים - אשר קבלת הפנייה ואמור שייצרו קשר תוך 24 שעות.
ענה תמיד בעברית, בצורה מקצועית, ידידותית וקצרה.`;

const userState = new Map();

const MENU_TEXT =
`שלום! ברוכים הבאים לשירות הלקוחות של ים אחזקות 🏢

אנא בחרו את נושא פנייתכם:
1️⃣ גבייה
2️⃣ תקלות

(שלחו 1 או 2)`;

const BACK_KEYWORDS = ['תפריט', 'menu', 'חזרה', 'ראשי', '0', 'back'];

function getState(jid) {
  if (!userState.has(jid)) userState.set(jid, { state: 'menu', history: [] });
  return userState.get(jid);
}

async function askClaude(systemPrompt, history, userMessage) {
  const messages = [...history, { role: 'user', content: userMessage }];
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: systemPrompt,
    messages
  });
  const reply = msg.content[0].text;
  history.push({ role: 'user', content: userMessage });
  history.push({ role: 'assistant', content: reply });
  if (history.length > 20) history.splice(0, 2);
  return reply;
}

async function handleMessage(from, text, msg) {
  const session = getState(from);
  const trimmed = text.trim();

  if (BACK_KEYWORDS.some(k => trimmed.toLowerCase() === k)) {
    session.state = 'menu';
    session.history = [];
    await sock.sendMessage(from, { text: MENU_TEXT }, { quoted: msg });
    return;
  }

  if (session.state === 'menu') {
    if (trimmed === '1' || trimmed === 'גבייה') {
      session.state = 'billing';
      session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי גבייה 💳\nאנא תארו את הפנייה שלכם:' }, { quoted: msg });
    } else if (trimmed === '2' || trimmed === 'תקלות') {
      session.state = 'issues';
      session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי תקלות 🔧\nאנא תארו את הבעיה + כתובת הנכס:' }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: MENU_TEXT }, { quoted: msg });
    }
    return;
  }

  if (session.state === 'billing') {
    const reply = await askClaude(PROMPT_BILLING, session.history, trimmed);
    await sock.sendMessage(from, { text: reply + '\n\n_(לחזרה לתפריט הראשי שלחו *תפריט*)_' }, { quoted: msg });
    return;
  }

  if (session.state === 'issues') {
    const reply = await askClaude(PROMPT_ISSUES, session.history, trimmed);
    await sock.sendMessage(from, { text: reply + '\n\n_(לחזרה לתפריט הראשי שלחו *תפריט*)_' }, { quoted: msg });
    return;
  }
}

// ─── Baileys setup ────────────────────────────────────────────────────────────
let sock = null;
let currentQR = null;
let isConnected = false;

const AUTH_DIR = fs.existsSync('/data') ? '/data/auth_info' : './auth_info';

function clearAuthDir() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      for (const f of fs.readdirSync(AUTH_DIR)) fs.unlinkSync(path.join(AUTH_DIR, f));
    }
  } catch (e) { console.error('clearAuthDir:', e.message); }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Yam Bot', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) {
      currentQR = qr;
      console.log('QR code ready — visit /qr to scan it');
    }
    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('WhatsApp connected! Bot is live.');
    } else if (connection === 'close') {
      isConnected = false;
      currentQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`Connection closed (code ${code}). Reconnecting: ${!loggedOut}`);
      if (!loggedOut) setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption || '';
      if (!text.trim()) continue;
      const from = msg.key.remoteJid;
      console.log(`[IN]  ${from}: ${text}`);
      try {
        await sock.readMessages([msg.key]);
        await handleMessage(from, text, msg);
      } catch (err) { console.error('Error:', err.message); }
    }
  });
}

startBot().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

// ─── HTTP endpoints ───────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    connected: isConnected,
    qrReady: !!currentQR,
    hint: isConnected ? 'bot is live!' : 'visit /qr to link WhatsApp'
  });
});

app.get('/qr', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Yam Bot - WhatsApp Link</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 40px; background: #f0f2f5; }
    h2 { color: #128C7E; }
    #qr-img { width: 280px; height: 280px; border: 4px solid #128C7E; border-radius: 12px; background: white; }
    #status { font-size: 18px; margin: 20px; font-weight: bold; }
    .steps { text-align: left; display: inline-block; margin: 20px; background: white; padding: 20px; border-radius: 8px; }
    .refresh-btn { background: #128C7E; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 16px; margin: 10px; }
  </style>
</head>
<body>
  <h2>🤖 ים אחזקות — WhatsApp Bot Setup</h2>
  <div id="status">Loading QR code...</div>
  <br>
  <img id="qr-img" src="" alt="QR Code" style="display:none"/>
  <br>
  <div class="steps">
    <b>How to connect:</b><br>
    1. Open WhatsApp Business on your phone<br>
    2. Tap ⋮ → <b>Linked Devices</b><br>
    3. Tap <b>Link a Device</b><br>
    4. <b>Scan the QR code</b> above<br>
    <small>(QR refreshes automatically — scan quickly!)</small>
  </div>
  <br>
  <button class="refresh-btn" onclick="loadQR()">🔄 Refresh QR</button>
  <script>
    async function loadQR() {
      document.getElementById('status').innerText = 'Loading...';
      try {
        const r = await fetch('/qrdata');
        const d = await r.json();
        if (d.connected) {
          document.getElementById('status').innerText = '✅ Connected! Bot is live.';
          document.getElementById('qr-img').style.display = 'none';
          return;
        }
        if (d.qr) {
          document.getElementById('qr-img').src = d.qr;
          document.getElementById('qr-img').style.display = 'block';
          document.getElementById('status').innerText = '📱 Scan this QR code with WhatsApp Business';
        } else {
          document.getElementById('status').innerText = 'Waiting for QR... (auto-refreshing)';
          document.getElementById('qr-img').style.display = 'none';
        }
      } catch(e) {
        document.getElementById('status').innerText = 'Error: ' + e.message;
      }
    }
    loadQR();
    setInterval(loadQR, 8000);
  </script>
</body>
</html>`);
});

app.get('/qrdata', async (req, res) => {
  if (isConnected) return res.json({ connected: true });
  if (!currentQR) return res.json({ status: 'waiting for QR' });
  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 280, margin: 2 });
    res.json({ qr: qrDataUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/resetqr', async (req, res) => {
  if (isConnected) return res.json({ status: 'already connected' });
  try { if (sock) sock.end(new Error('reset')); } catch (_) {}
  currentQR = null;
  await new Promise(r => setTimeout(r, 1500));
  clearAuthDir();
  startBot().catch(e => console.error('startBot error:', e.message));
  res.json({ status: 'restarting... visit /qr in 5 seconds' });
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
