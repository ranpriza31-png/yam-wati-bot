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
const BACK_KEYWORDS = ['תפריט', 'menu', 'חזרה', 'ראשי', '0', 'back'];

async function sendMenu(jid, quotedMsg) {
  try {
    await sock.sendMessage(jid, {
      listMessage: {
        title: 'ים אחזקות 🏢',
        text: 'שלום! ברוכים הבאים לשירות הלקוחות שלנו.\nאנא בחרו את נושא פנייתכם:',
        footerText: 'שירות לקוחות ים אחזקות',
        buttonText: '📋 בחרו נושא',
        sections: [{
          title: 'נושאי פנייה',
          rows: [
            { title: '💳 גבייה', description: 'דמי ועד, חשבוניות, תשלומים, הוראות קבע', rowId: 'billing' },
            { title: '🔧 תקלות', description: 'דיווח על תקלות ובעיות בנכס', rowId: 'issues' }
          ]
        }]
      }
    }, quotedMsg ? { quoted: quotedMsg } : undefined);
  } catch (e) {
    await sock.sendMessage(jid, {
      text: 'שלום! ברוכים הבאים לשירות הלקוחות של ים אחזקות 🏢\n\nאנא בחרו:\n1️⃣ גבייה\n2️⃣ תקלות'
    }, quotedMsg ? { quoted: quotedMsg } : undefined);
  }
}

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

  const listResponse = msg.message?.listResponseMessage;
  if (listResponse) {
    const rowId = listResponse.singleSelectReply?.selectedRowId;
    if (rowId === 'billing') {
      session.state = 'billing'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי גבייה 💳\nאנא תארו את הפנייה שלכם:' }, { quoted: msg });
      return;
    }
    if (rowId === 'issues') {
      session.state = 'issues'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי תקלות 🔧\nאנא תארו את הבעיה + כתובת הנכס:' }, { quoted: msg });
      return;
    }
  }

  if (BACK_KEYWORDS.some(k => trimmed.toLowerCase() === k)) {
    session.state = 'menu'; session.history = [];
    await sendMenu(from, msg);
    return;
  }

  if (session.state === 'menu') {
    if (trimmed === '1' || trimmed === 'גבייה' || trimmed === 'billing') {
      session.state = 'billing'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי גבייה 💳\nאנא תארו את הפנייה שלכם:' }, { quoted: msg });
      return;
    }
    if (trimmed === '2' || trimmed === 'תקלות' || trimmed === 'תקלה' || trimmed === 'issues') {
      session.state = 'issues'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי תקלות 🔧\nאנא תארו את הבעיה + כתובת הנכס:' }, { quoted: msg });
      return;
    }
    const classify = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      system: 'Classify as one word: "billing" (payments/invoices/fees) or "issues" (maintenance/repair/problems) or "menu" (unclear/greeting). Reply with only that word.',
      messages: [{ role: 'user', content: trimmed }]
    });
    const intent = classify.content[0].text.trim().toLowerCase();
    if (intent === 'billing') {
      session.state = 'billing'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי גבייה 💳\nאנא תארו את הפנייה שלכם:' }, { quoted: msg });
      return;
    }
    if (intent === 'issues') {
      session.state = 'issues'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי תקלות 🔧\nאנא תארו את הבעיה + כתובת הנכס:' }, { quoted: msg });
      return;
    }
    await sendMenu(from, msg);
    return;
  }

  if (session.state === 'billing') {
    const reply = await askClaude(PROMPT_BILLING, session.history, trimmed);
    await sock.sendMessage(from, { text: reply + '\n\n_(לחזרה לתפריט שלחו *תפריט*)_' }, { quoted: msg });
    return;
  }

  if (session.state === 'issues') {
    const reply = await askClaude(PROMPT_ISSUES, session.history, trimmed);
    await sock.sendMessage(from, { text: reply + '\n\n_(לחזרה לתפריט שלחו *תפריט*)_' }, { quoted: msg });
    return;
  }
}

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
    version, auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Yam Bot', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) { currentQR = qr; console.log('QR ready — visit /qr'); }
    if (connection === 'open') {
      isConnected = true; currentQR = null;
      console.log('WhatsApp connected!');
    } else if (connection === 'close') {
      isConnected = false; currentQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
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
        msg.message?.imageMessage?.caption ||
        msg.message?.listResponseMessage?.title || '';
      const isListResponse = !!msg.message?.listResponseMessage;
      if (!text.trim() && !isListResponse) continue;
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

app.get('/', (req, res) => res.json({
  status: 'running', connected: isConnected,
  qrReady: !!currentQR, hint: isConnected ? 'bot is live!' : 'visit /qr to link WhatsApp'
}));

app.get('/qr', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Yam Bot QR</title>
  <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}h2{color:#128C7E}
  #qr-img{width:280px;height:280px;border:4px solid #128C7E;border-radius:12px;background:white}
  #status{font-size:18px;margin:20px;font-weight:bold}
  .steps{text-align:left;display:inline-block;margin:20px;background:white;padding:20px;border-radius:8px}
  .btn{background:#128C7E;color:white;border:none;padding:12px 24px;border-radius:8px;cursor:pointer;font-size:16px}</style>
  </head><body>
  <h2>🤖 ים אחזקות — WhatsApp Bot Setup</h2>
  <div id="status">Loading...</div><br>
  <img id="qr-img" src="" style="display:none"/><br>
  <div class="steps"><b>How to connect:</b><br>1. Open WhatsApp Business<br>2. ⋮ → Linked Devices → Link a Device<br>3. Scan the QR code<br><small>(auto-refreshes every 8s)</small></div><br>
  <button class="btn" onclick="loadQR()">🔄 Refresh</button>
  <script>
  async function loadQR(){
    try{const r=await fetch('/qrdata'),d=await r.json();
    if(d.connected){document.getElementById('status').innerText='✅ Connected!';document.getElementById('qr-img').style.display='none';return;}
    if(d.qr){document.getElementById('qr-img').src=d.qr;document.getElementById('qr-img').style.display='block';document.getElementById('status').innerText='📱 Scan with WhatsApp Business';}
    else{document.getElementById('status').innerText='Waiting for QR...';document.getElementById('qr-img').style.display='none';}}
    catch(e){document.getElementById('status').innerText='Error: '+e.message;}}
  loadQR();setInterval(loadQR,8000);
  </script></body></html>`);
});

app.get('/qrdata', async (req, res) => {
  if (isConnected) return res.json({ connected: true });
  if (!currentQR) return res.json({ status: 'waiting' });
  try {
    const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 280, margin: 2 });
    res.json({ qr: qrDataUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/resetqr', async (req, res) => {
  if (isConnected) return res.json({ status: 'already connected' });
  try { if (sock) sock.end(new Error('reset')); } catch (_) {}
  currentQR = null;
  await new Promise(r => setTimeout(r, 1500));
  clearAuthDir();
  startBot().catch(e => console.error(e.message));
  res.json({ status: 'restarting... visit /qr in 5s' });
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
