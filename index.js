const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const app = express();
app.use(express.json());

const WATI_TENANT = process.env.WATI_TENANT || '10196040';
const WATI_BASE   = `https://live-mt-server.wati.io/${WATI_TENANT}`;
const WATI_TOKEN  = process.env.WATI_TOKEN;
const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ===== הגדרת הבוט =====
// שנה את הטקסט הזה לפי הצורך
const SYSTEM_PROMPT = process.env.BOT_SYSTEM_PROMPT ||
  `אתה עוזר לחברת ים אחזקות. ענה בעברית בצורה קצרה וברורה.
אם אינך יודע את התשובה — אמור זאת בפשטות.`;
// ======================

async function sendMsg(phone, message) {
  const r = await fetch(`${WATI_BASE}/api/v1/sendSessionMessage/${phone}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WATI_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message })
  });
  const data = await r.json().catch(() => ({}));
  console.log('sendMsg', phone, data);
  return data;
}

async function askClaude(userMessage) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });
  return msg.content[0].text;
}

// Webhook מ-WATI
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const { waId, text, type } = req.body;
    if (type !== 'text' || !text || !waId) return;

    console.log(`[${waId}] ${text}`);

    const reply = await askClaude(text);
    await sendMsg(waId, reply);
  } catch (err) {
    console.error('webhook error:', err.message);
  }
});

app.get('/', (req, res) => res.send('yam-wati-bot is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
