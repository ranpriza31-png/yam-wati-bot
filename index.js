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

const SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT ||
  `אתה נציג שירות לקוחות של חברת ים אחזקות - חברה לניהול ואחזקת מבנים בישראל.
ענה תמיד בעברית, בצורה מקצועית, ידידותית וקצרה.
אם שאלה אינה קשורה לניהול/אחזקת נכסים - הפנה בנימוס לנושא הנכון.`;

async function askClaude(userMessage) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });
  return msg.content[0].text;
}

let sock = null;
let pairingCode = null;
let isConnected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Yam Bot', 'Chrome', '120.0.0'],
    markOnlineOnConnect: false
  });

  if (!state.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log('\n================================================');
      console.log(`PAIRING CODE: ${pairingCode}`);
      console.log('Go to WhatsApp > Settings > Linked Devices > Link a Device');
      console.log('Tap "Link with phone number instead" and enter the code above');
      console.log('================================================\n');
    } catch (e) {
      console.error('Failed to get pairing code:', e.message);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      isConnected = true;
      pairingCode = null;
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
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      const from = msg.key.remoteJid;
      console.log(`[IN]  ${from}: ${text}`);

      try {
        await sock.readMessages([msg.key]);
        const reply = await askClaude(text);
        await sock.sendMessage(from, { text: reply }, { quoted: msg });
        console.log(`[OUT] ${reply.substring(0, 80)}`);
      } catch (err) {
        console.error('Error processing message:', err.message);
      }
    }
  });
}

startBot().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    connected: isConnected,
    pairingCode: pairingCode || (isConnected ? 'connected - no code needed' : 'starting...')
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));
