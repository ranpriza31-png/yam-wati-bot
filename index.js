const {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');
const pino = require('pino');

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PHONE_NUMBER = (process.env.PHONE_NUMBER || '972535466659').replace(/\D/g, '');

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
    model: 'claude-haiku-4-5-20251001', max_tokens: 500, system: systemPrompt, messages
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
    session.state = 'menu'; session.history = [];
    await sock.sendMessage(from, { text: MENU_TEXT }, { quoted: msg }); return;
  }
  if (session.state === 'menu') {
    if (trimmed === '1' || trimmed === 'גבייה') {
      session.state = 'billing'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי גבייה 💳\nאנא תארו את הפנייה שלכם:' }, { quoted: msg });
    } else if (trimmed === '2' || trimmed === 'תקלות') {
      session.state = 'issues'; session.history = [];
      await sock.sendMessage(from, { text: 'מעולה! אשמח לעזור בנושאי תקלות 🔧\nאנא תארו את הבעיה + כתובת הנכס:' }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: MENU_TEXT }, { quoted: msg });
    }
    return;
  }
  if (session.state === 'billing') {
    const reply = await askClaude(PROMPT_BILLING, session.history, trimmed);
    await sock.sendMessage(from, { text: reply + '\n\n_(לחזרה לתפריט הראשי שלחו *תפריט*)_' }, { quoted: msg }); return;
  }
  if (session.state === 'issues') {
    const reply = await askClaude(PROMPT_ISSUES, session.history, trimmed);
    await sock.sendMessage(from, { text: reply + '\n\n_(לחזרה לתפריט הראשי שלחו *תפריט*)_' }, { quoted: msg }); return;
  }
}

let sock = null;
let pairingCode = null;
let isConnected = false;
let pairingRequested = false;

const AUTH_DIR = require('fs').existsSync('/data') ? '/data/auth_info' : './auth_info';

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['Yam Bot', 'Chrome', '120.0.0'], markOnlineOnConnect: false
  });
  if (!state.creds.registered) console.log('Not registered. Visit /pair to get a pairing code.');
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      isConnected = true; pairingCode = null; pairingRequested = false;
      console.log('WhatsApp connected! Bot is live.');
    } else if (connection === 'close') {
      isConnected = false;
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
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
      if (!text.trim()) continue;
      const from = msg.key.remoteJid;
      console.log(`[IN]  ${from}: ${text}`);
      try { await sock.readMessages([msg.key]); await handleMessage(from, text, msg); }
      catch (err) { console.error('Error:', err.message); }
    }
  });
}

startBot().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });

app.get('/', (req, res) => res.json({
  status: 'running', connected: isConnected,
  pairingCode: pairingCode || (isConnected ? 'connected' : 'visit /pair to link'),
  authDir: AUTH_DIR
}));

app.get('/pair', async (req, res) => {
  if (isConnected) return res.json({ status: 'already connected' });
  if (pairingRequested) return res.json({ pairingCode, status: 'code already generated — enter it in WhatsApp' });
  if (!sock) return res.status(503).json({ error: 'socket not ready, retry in a few seconds' });
  try {
    pairingRequested = true;
    await new Promise(r => setTimeout(r, 2000));
    const code = await sock.requestPairingCode(PHONE_NUMBER);
    pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    console.log(`\n=== PAIRING CODE: ${pairingCode} ===\n`);
    res.json({ pairingCode, instructions: 'WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead' });
  } catch (e) {
    pairingRequested = false;
    res.status(500).json({ error: e.message });
  }
});

app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
