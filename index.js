const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const app = express();
app.use(express.json());

// ─── WATI קבועים ──────────────────────────────────────────
const WATI_TENANT = process.env.WATI_TENANT || '10196040';
const WATI_BASE   = `https://live-mt-server.wati.io/${WATI_TENANT}`;
const WATI_TOKEN  = process.env.WATI_TOKEN;

// מספר הטלפון של המנהל (רן) - מי שיכול לשלוח פקודות לבוט
const ADMIN_PHONE = process.env.ADMIN_PHONE || '972502091601';

const YAM_APP_ID  = '6969f5fd4292729be5bcdab3';
const YAM_BASE    = `https://yamholding.co.il/api/apps/${YAM_APP_ID}`;

// מספרי טלפון של העובדים לשליחת משימות יומית
// פורמט: ללא + ללא -, לדוג' 972507888685
const WORKER_PHONES = {
  'יובל ורן': process.env.PHONE_YUVAL || '',
  'חיים':     process.env.PHONE_CHAIM || '',
  'לאון':     process.env.PHONE_LEON  || '972507888685',
  'מאור':     process.env.PHONE_MAOR  || '972535712559',
};

// ─── WATI send ────────────────────────────────────────────
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
  console.log(`📤 sendMsg → ${phone}: ${data.result || data.error || r.status}`);
  return data;
}

// ─── Yam Auth ─────────────────────────────────────────────
let yamToken = process.env.YAM_TOKEN || '';

async function getYamToken() {
  if (yamToken) return yamToken;
  const r = await fetch('https://yamholding.co.il/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.YAM_EMAIL, password: process.env.YAM_PASSWORD })
  }).then(r => r.json());
  yamToken = r.token || r.access_token || '';
  console.log('🔑 Yam token refreshed');
  return yamToken;
}

async function yamFetch(path, opts = {}) {
  const token = await getYamToken();
  const r = await fetch(YAM_BASE + path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  if (r.status === 401) { yamToken = ''; return yamFetch(path, opts); }
  return r.json();
}

// ─── שליחת משימות יומית (7:00 ו-12:30) ──────────────────
async function sendDailyTasks(emoji) {
  if (new Date().getDay() === 6) return; // שבת
  console.log(`📤 שולח משימות ${emoji}`);

  const [emps, tasks, blds] = await Promise.all([
    yamFetch('/entities/Employee'),
    yamFetch('/entities/Task?q={"is_archived":false}'),
    yamFetch('/entities/Building'),
  ]);
  const bldMap = {};
  blds.forEach(b => { bldMap[b.id] = b.address; });

  for (const [workerName, phone] of Object.entries(WORKER_PHONES)) {
    if (!phone) continue;
    const firstName = workerName.split(' ')[0];
    const emp = emps.find(e => e.name && e.name.includes(firstName));
    if (!emp) continue;
    const workerTasks = tasks.filter(t => t.assigned_to === emp.id);
    if (workerTasks.length === 0) continue;

    const lines = workerTasks.map(t => {
      const addr = bldMap[t.building_id];
      return (addr ? `📍 ${addr}\n` : '') + `📌 ${t.title}`;
    }).join('\n\n');

    await sendMsg(phone, `${emoji} משימות - ${workerName}\n\n${lines}`);
  }
  console.log('✅ משימות נשלחו');
}

cron.schedule('0 7 * * *',   () => sendDailyTasks('🌅'));
cron.schedule('30 12 * * *', () => sendDailyTasks('🌞'));

// ─── Claude tools ─────────────────────────────────────────
const tools = [
  {
    name: 'get_tasks',
    description: 'קבל משימות פתוחות, אפשר לסנן לפי עובד או בניין',
    input_schema: {
      type: 'object',
      properties: {
        worker_name: { type: 'string', description: 'שם עובד (אופציונלי)' },
        building:    { type: 'string', description: 'כתובת בניין (אופציונלי)' }
      }
    }
  },
  {
    name: 'create_task',
    description: 'פתח משימה חדשה ב-Yam',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'כותרת המשימה' },
        worker_name: { type: 'string', description: 'שם העובד' },
        building:    { type: 'string', description: 'כתובת בניין (אופציונלי)' }
      },
      required: ['title', 'worker_name']
    }
  },
  {
    name: 'close_task',
    description: 'סגור / ארכב משימה קיימת',
    input_schema: {
      type: 'object',
      properties: {
        task_title:  { type: 'string', description: 'חלק מכותרת המשימה לסגירה' },
        worker_name: { type: 'string', description: 'שם העובד לצמצום חיפוש (אופציונלי)' }
      },
      required: ['task_title']
    }
  },
  {
    name: 'send_whatsapp',
    description: 'שלח הודעת WhatsApp לעובד ספציפי',
    input_schema: {
      type: 'object',
      properties: {
        worker_name: { type: 'string', description: 'שם העובד' },
        message:     { type: 'string', description: 'תוכן ההודעה' }
      },
      required: ['worker_name', 'message']
    }
  },
  {
    name: 'send_tasks_now',
    description: 'שלח עכשיו את רשימת המשימות לכל העובדים',
    input_schema: { type: 'object', properties: {} }
  }
];

async function executeTool(name, input) {
  if (name === 'get_tasks') {
    const [emps, tasks, blds] = await Promise.all([
      yamFetch('/entities/Employee'),
      yamFetch('/entities/Task?q={"is_archived":false}'),
      yamFetch('/entities/Building'),
    ]);
    let filtered = tasks;
    if (input.worker_name) {
      const emp = emps.find(e => e.name && e.name.includes(input.worker_name));
      if (emp) filtered = filtered.filter(t => t.assigned_to === emp.id);
    }
    if (input.building) {
      const bld = blds.find(b => b.address && b.address.includes(input.building));
      if (bld) filtered = filtered.filter(t => t.building_id === bld.id);
    }
    const empMap = {}; emps.forEach(e => { empMap[e.id] = e.name; });
    const bldMap = {}; blds.forEach(b => { bldMap[b.id] = b.address; });
    return filtered.slice(0, 30).map(t => ({
      title: t.title, worker: empMap[t.assigned_to] || '?',
      building: bldMap[t.building_id] || '', status: t.status
    }));
  }

  if (name === 'create_task') {
    const [emps, blds] = await Promise.all([
      yamFetch('/entities/Employee'), yamFetch('/entities/Building')
    ]);
    const emp = emps.find(e => e.name && e.name.includes(input.worker_name));
    if (!emp) return { error: 'עובד לא נמצא: ' + input.worker_name };
    const bld = input.building ? blds.find(b => b.address && b.address.includes(input.building)) : null;
    const task = await yamFetch('/entities/Task', {
      method: 'POST',
      body: JSON.stringify({ title: input.title, assigned_to: emp.id, building_id: bld?.id || null, is_archived: false })
    });
    return { success: true, title: task.title };
  }

  if (name === 'close_task') {
    const [emps, tasks] = await Promise.all([
      yamFetch('/entities/Employee'),
      yamFetch('/entities/Task?q={"is_archived":false}')
    ]);
    let candidates = tasks.filter(t => t.title && t.title.includes(input.task_title));
    if (input.worker_name) {
      const emp = emps.find(e => e.name && e.name.includes(input.worker_name));
      if (emp) candidates = candidates.filter(t => t.assigned_to === emp.id);
    }
    if (!candidates.length) return { error: 'משימה לא נמצאה' };
    await yamFetch(`/entities/Task/${candidates[0].id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_archived: true })
    });
    return { success: true, closed: candidates[0].title };
  }

  if (name === 'send_whatsapp') {
    const entry = Object.entries(WORKER_PHONES).find(([k]) =>
      k.includes(input.worker_name) || input.worker_name.includes(k.split(' ')[0])
    );
    if (!entry) return { error: 'עובד לא נמצא: ' + input.worker_name };
    if (!entry[1]) return { error: 'מספר טלפון לא מוגדר עבור: ' + entry[0] };
    await sendMsg(entry[1], input.message);
    return { success: true };
  }

  if (name === 'send_tasks_now') {
    await sendDailyTasks('📋');
    return { success: true };
  }

  return { error: 'כלי לא מוכר: ' + name };
}

// ─── Claude processing ────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function processWithClaude(text, replyPhone) {
  const SYSTEM = `אתה עוזרת ניהול של חברת ים אחזקות. עני תמיד בעברית קצרה וברורה.
עובדים: יובל ורן, חיים, לאון, מאור.
בצעי בקשות ישירות. היי תמציתית.`;

  const messages = [{ role: 'user', content: text }];
  let response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM,
    tools,
    messages
  });

  while (response.stop_reason === 'tool_use') {
    const uses = response.content.filter(b => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });
    const results = await Promise.all(uses.map(async u => ({
      type: 'tool_result',
      tool_use_id: u.id,
      content: JSON.stringify(await executeTool(u.name, u.input))
    })));
    messages.push({ role: 'user', content: results });
    response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: SYSTEM,
      tools,
      messages
    });
  }

  const reply = response.content.find(b => b.type === 'text')?.text;
  if (reply) {
    await sendMsg(replyPhone, reply);
    console.log('✅ Reply:', reply.substring(0, 80));
  }
}

// ─── WATI Webhook ─────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    console.log('📨 Webhook:', JSON.stringify(body).substring(0, 200));

    const waId = body.waId || body.senderWaId;
    const text = (body.text || body.message || '').trim();
    const msgType = body.type || body.messageType;

    if (!text || msgType !== 'text') return;
    if (waId !== ADMIN_PHONE) {
      console.log(`⚠️ Message from ${waId} ignored (not admin)`);
      return;
    }

    console.log(`📨 Admin: ${text}`);
    await processWithClaude(text, ADMIN_PHONE);
  } catch (err) {
    console.error('❌', err.message);
  }
});

app.get('/', (req, res) => res.send('✅ Yam WATI Bot פעיל'));

app.get('/test', async (req, res) => {
  try {
    const r = await fetch(`${WATI_BASE}/api/v1/getContacts?pageSize=1`, {
      headers: { 'Authorization': `Bearer ${WATI_TOKEN}` }
    });
    const data = await r.json();
    res.json({ status: 'ok', wati: data.result });
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('🚀 Yam WATI Bot מוכן'));
