'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const categories = require('./categories');
const PORT = Number(process.env.PORT || 3000), PUB = path.join(__dirname, 'public');

let DATA = path.resolve(process.env.DB_PATH || './data/finance.json');
try {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
} catch (e) {
  DATA = '/tmp/finance.json';
}
let db = { users: [], transactions: [], plans: [], audit: [], sessions: [], seq: { user: 0, transaction: 0, plan: 0, audit: 0 } };
if (fs.existsSync(DATA)) {
  try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { console.error('Invalid data file', e); }
}
if (!db.sessions) db.sessions = [];
if (!db.seq) db.seq = { user: 0, transaction: 0, plan: 0, audit: 0 };

const sessions = new Map(), attempts = new Map();
const save = () => {
  try {
    const tmp = DATA + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DATA);
  } catch (e) {
    if (DATA !== '/tmp/finance.json') {
      DATA = '/tmp/finance.json';
      save();
    }
  }
};

const id = t => ++db.seq[t]; const now = () => new Date().toISOString(); const money = v => Math.round(Number(v) * 100); const amount = v => Number((v / 100).toFixed(2));
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(x => x.trim().split('=')));
const sessionOf = req => {
  const tokenHeader = req.headers['x-session-token'];
  const sid = (tokenHeader ? tokenHeader.split(':')[0] : '') || cookie(req).sid;
  if (!sid) return null;
  let s = (db.sessions || []).find(x => x.sid === sid);
  if (!s && sessions.has(sid)) s = sessions.get(sid);
  return s || null;
};
const userOf = req => { const s = sessionOf(req); return s && db.users.find(u => u.id === s.userId); };
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((resolve, reject) => { let s = ''; req.on('data', c => { s += c; if (s.length > 2e6) { reject(new Error('Payload too large')); req.destroy(); } }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('Invalid JSON')); } }); });
const hashPassword = p => { const salt = crypto.randomBytes(16); const hash = crypto.scryptSync(p, salt, 64); return `${salt.toString('hex')}:${hash.toString('hex')}`; };
const verify = (p, stored) => { const [s, h] = stored.split(':'); const a = crypto.scryptSync(p, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const audit = (uid, action, entity, eid = null) => { db.audit.push({ id: id('audit'), userId: uid, action, entity, entityId: eid, at: now() }); save(); };
const auth = (req, res) => { const u = userOf(req); if (!u) { json(res, 401, { error: 'Authentication required' }); return null; } return u; };
const csrf = (req, res) => { const s = sessionOf(req); if (!s || req.headers['x-csrf-token'] !== s.csrf) { json(res, 403, { error: 'Invalid security token' }); return false; } return true; };
const clean = t => {
  const type = String(t.type || '').toLowerCase(), category = String(t.category || '').trim(), amt = Number(t.amount), date = String(t.txn_date || '');
  if (!categories[type]?.includes(category)) throw Error('Invalid category');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Invalid date');
  if (!Number.isFinite(amt) || amt < 0 || amt > 1e10) throw Error('Invalid amount');
  return { txn_date: date, type, category, amount_paise: money(amt), account: String(t.account || '').slice(0, 80), payment_mode: String(t.payment_mode || '').slice(0, 50), merchant: String(t.merchant || '').slice(0, 120), notes: String(t.notes || '').slice(0, 500), recurring: !!t.recurring, updated_at: now() };
};

const createSession = (userId) => {
  const sid = crypto.randomBytes(32).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const sessionObj = { sid, userId, csrf: token, at: now() };
  sessions.set(sid, sessionObj);
  if (!db.sessions) db.sessions = [];
  db.sessions.push(sessionObj);
  if (db.sessions.length > 500) db.sessions = db.sessions.slice(-500);
  save();
  return { sid, token, sessionToken: `${sid}:${token}` };
};

// Seed demo account if db.users is empty
if (!db.users || db.users.length === 0) {
  const demoEmail = 'demo@finance.com';
  const demoUser = { id: id('user'), name: 'Demo Account', email: demoEmail, password_hash: hashPassword('Password1234!'), currency: 'INR', created_at: now() };
  db.users.push(demoUser);
  save();
}

async function geminiFinance(user, message, year) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw Error('Gemini is not configured. Add GEMINI_API_KEY to the server environment.');
  
  const tx = db.transactions.filter(x => x.userId === user.id && x.txn_date.startsWith(String(year))).sort((a, b) => b.txn_date.localeCompare(a.txn_date));
  const totals = { income: 0, expense: 0, investment: 0, liability: 0 };
  const map = {};
  for (const t of tx) {
    totals[t.type] += amount(t.amount_paise);
    const ck = t.type + '|' + t.category;
    map[ck] = (map[ck] || 0) + amount(t.amount_paise);
  }
  
  const savings = totals.income - totals.expense - totals.liability;
  const netCashFlow = savings - totals.investment;
  const savingsRate = totals.income ? Number((savings / totals.income * 100).toFixed(1)) : 0;
  const investmentRate = totals.income ? Number((totals.investment / totals.income * 100).toFixed(1)) : 0;
  
  const topExpenses = Object.entries(map)
    .filter(([k]) => k.startsWith('expense|'))
    .map(([k, v]) => ({ category: k.split('|')[1], total: v }))
    .sort((a, b) => b.total - a.total).slice(0, 10);

  const activePlans = db.plans.filter(x => x.userId === user.id && x.plan_year === Number(year)).map(x => ({ type: x.plan_type, category: x.category, target: amount(x.target_paise) }));
  const recent = tx.slice(0, 40).map(t => ({ date: t.txn_date, type: t.type, category: t.category, amount: amount(t.amount_paise), merchant: t.merchant, notes: t.notes }));

  const dashboardContext = {
    year: Number(year),
    totals,
    savings,
    netCashFlow,
    savingsRatePercentage: savingsRate,
    investmentRatePercentage: investmentRate,
    topExpenseCategories: topExpenses,
    activeBudgetPlans: activePlans,
    recentTransactionsCount: tx.length,
    recentTransactions: recent
  };

  const prompt = `You are a secure, intelligent personal finance assistant for an Indian user.
Current Date: ${new Date().toISOString().slice(0, 10)}. Currency: INR (₹).

User Dashboard Financial Context (${year}):
${JSON.stringify(dashboardContext, null, 2)}

Valid Categories by Type:
${JSON.stringify(categories, null, 2)}

User Message: "${message}"

Your Capabilities & Instructions:
1. FULL DASHBOARD ACCESS: You can inspect all financial summary metrics, savings rates, investment performance, top expenses, and active annual plans.
2. RECOGNIZE & ADD TRANSACTIONS: If the user states a financial entry (expense, income, investment, or liability, e.g. "spent 1200 on groceries", "got 85000 salary", "invested 10000 in PPF", "paid 15000 home loan EMI"), return action "add_transaction". Choose the closest EXACT category from the Valid Categories list. Infer today's date if omitted.
3. FINANCIAL ADVICE & SUMMARY: If the user asks for a dashboard summary, savings advice, budget recommendations, expense breakdown, or how to improve their finances, return action "answer" with a friendly, well-structured, actionable response.

Return ONLY a valid JSON object matching this schema:
{
  "action": "add_transaction" | "answer",
  "reply": "Clear and helpful explanation or response for the user",
  "transaction": null | {
    "txn_date": "YYYY-MM-DD",
    "type": "income|expense|investment|liability",
    "category": "exact valid category name",
    "amount": number,
    "merchant": "string",
    "account": "string",
    "payment_mode": "string",
    "notes": "string",
    "recurring": false
  }
}`;

  const models = ['gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'];
  let lastErr = null;

  for (const model of models) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
        })
      });
      const out = await r.json();
      if (!r.ok) {
        lastErr = out?.error?.message || `Gemini API request failed (${r.status}).`;
        continue;
      }
      const text = out?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
      return JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw Error(lastErr || 'Gemini service unavailable. Check your API key.');
}

function staticFile(req, res) {
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  p = path.normalize(p).replace(/^\.\.(\/|\\)/, '');
  const f = path.join(PUB, p);
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return false;
  const ext = path.extname(f), types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  fs.createReadStream(f).pipe(res);
  return true;
}

const serverHandler = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (!u.pathname.startsWith('/api/')) {
      if (staticFile(req, res)) return;
      return staticFile({ ...req, url: '/' }, res);
    }
    if (req.method === 'GET' && u.pathname === '/api/config') {
      const s = sessionOf(req);
      return json(res, 200, { categories, csrfToken: s?.csrf || '', authenticated: !!userOf(req) });
    }
    if (req.method === 'POST' && ['/api/login', '/api/register'].includes(u.pathname)) {
      const key = req.socket?.remoteAddress || 'local', a = attempts.get(key) || { n: 0, t: 0 };
      if (Date.now() - a.t < 15 * 60e3 && a.n >= 20) return json(res, 429, { error: 'Too many attempts. Try later.' });
      const b = await body(req);
      if (u.pathname === '/api/register') {
        const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
        if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 6) return json(res, 400, { error: 'Use a valid name, email, and password of at least 6 characters.' });
        if (db.users.some(x => x.email === email)) return json(res, 409, { error: 'An account with this email already exists.' });
        const user = { id: id('user'), name, email, password_hash: hashPassword(password), currency: 'INR', created_at: now() };
        db.users.push(user);
        audit(user.id, 'create', 'user', user.id);
        const { sid, token, sessionToken } = createSession(user.id);
        return json(res, 200, { ok: true, csrfToken: token, sessionToken }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
      }
      const emailInput = String(b.email || '').trim().toLowerCase();
      const user = db.users.find(x => x.email === emailInput);
      if (!user) {
        return json(res, 401, { error: `No account found for "${emailInput}". Click "Create account" to sign up.` });
      }
      if (!verify(String(b.password || ''), user.password_hash)) {
        attempts.set(key, { n: a.n + 1, t: Date.now() });
        return json(res, 401, { error: 'Incorrect password.' });
      }
      attempts.delete(key);
      const { sid, token, sessionToken } = createSession(user.id);
      audit(user.id, 'login', 'session');
      return json(res, 200, { ok: true, csrfToken: token, sessionToken }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
    }

    const user = auth(req, res); if (!user) return;
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !csrf(req, res)) return;

    if (req.method === 'POST' && u.pathname === '/api/logout') {
      const s = sessionOf(req);
      if (s) {
        sessions.delete(s.sid);
        db.sessions = (db.sessions || []).filter(x => x.sid !== s.sid);
        save();
      }
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (req.method === 'GET' && u.pathname === '/api/me') return json(res, 200, { user: { id: user.id, name: user.name, email: user.email, currency: user.currency, created_at: user.created_at }, csrfToken: sessionOf(req).csrf });
    if (req.method === 'GET' && u.pathname === '/api/transactions') {
      const year = u.searchParams.get('year') || String(new Date().getFullYear());
      return json(res, 200, db.transactions.filter(x => x.userId === user.id && x.txn_date.startsWith(year)).sort((a, b) => b.txn_date.localeCompare(a.txn_date) || b.id - a.id).map(x => ({ ...x, amount: amount(x.amount_paise) })));
    }
    if (req.method === 'POST' && u.pathname === '/api/transactions') {
      const t = clean(await body(req)); t.id = id('transaction'); t.userId = user.id; t.created_at = now();
      db.transactions.push(t); audit(user.id, 'create', 'transaction', t.id);
      return json(res, 200, { ...t, amount: amount(t.amount_paise) });
    }
    let m = u.pathname.match(/^\/api\/transactions\/(\d+)$/);
    if (m && req.method === 'PUT') {
      const t = db.transactions.find(x => x.id === Number(m[1]) && x.userId === user.id);
      if (!t) return json(res, 404, { error: 'Transaction not found.' });
      Object.assign(t, clean(await body(req))); audit(user.id, 'update', 'transaction', t.id);
      return json(res, 200, { ok: true });
    }
    if (m && req.method === 'DELETE') {
      const i = db.transactions.findIndex(x => x.id === Number(m[1]) && x.userId === user.id);
      if (i < 0) return json(res, 404, { error: 'Transaction not found.' });
      db.transactions.splice(i, 1); audit(user.id, 'delete', 'transaction', Number(m[1]));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/plans') {
      const y = Number(u.searchParams.get('year'));
      return json(res, 200, db.plans.filter(x => x.userId === user.id && x.plan_year === y).map(x => ({ ...x, target: amount(x.target_paise) })));
    }
    if (req.method === 'POST' && u.pathname === '/api/plans') {
      const b = await body(req), y = Number(b.plan_year), type = String(b.plan_type), cat = String(b.category), target = Number(b.target);
      if (!categories[type]?.includes(cat) || !Number.isFinite(target) || target < 0) return json(res, 400, { error: 'Invalid plan.' });
      let p = db.plans.find(x => x.userId === user.id && x.plan_year === y && x.plan_type === type && x.category === cat);
      if (p) { p.target_paise = money(target); p.notes = String(b.notes || '').slice(0, 300); }
      else { p = { id: id('plan'), userId: user.id, plan_year: y, plan_type: type, category: cat, target_paise: money(target), notes: String(b.notes || '').slice(0, 300) }; db.plans.push(p); }
      audit(user.id, 'upsert', 'plan', p.id); return json(res, 200, { ok: true });
    }
    m = u.pathname.match(/^\/api\/plans\/(\d+)$/);
    if (m && req.method === 'DELETE') {
      db.plans = db.plans.filter(x => !(x.id === Number(m[1]) && x.userId === user.id));
      audit(user.id, 'delete', 'plan', Number(m[1])); return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/api/summary') {
      const y = u.searchParams.get('year') || String(new Date().getFullYear()), tx = db.transactions.filter(x => x.userId === user.id && x.txn_date.startsWith(y)), totals = { income: 0, expense: 0, investment: 0, liability: 0 }, monthly = [], map = {};
      for (const t of tx) {
        totals[t.type] += t.amount_paise; const mo = Number(t.txn_date.slice(5, 7)), mk = mo + '|' + t.type;
        map[mk] = (map[mk] || 0) + t.amount_paise; const ck = t.type + '|' + t.category; map[ck] = (map[ck] || 0) + t.amount_paise;
      }
      for (let mo = 1; mo <= 12; mo++) for (const type of Object.keys(totals)) if (map[mo + '|' + type]) monthly.push({ month: mo, type, total: amount(map[mo + '|' + type]) });
      const byCategory = []; for (const type of Object.keys(totals)) for (const cat of categories[type]) if (map[type + '|' + cat]) byCategory.push({ type, category: cat, total: amount(map[type + '|' + cat]) });
      const tm = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, amount(v)])), savings = tm.income - tm.expense - tm.liability;
      const plans = db.plans.filter(x => x.userId === user.id && x.plan_year === Number(y)).map(x => ({ type: x.plan_type, category: x.category, target: amount(x.target_paise) }));
      return json(res, 200, { year: Number(y), totals: tm, netCashFlow: savings - tm.investment, savings, savingsRate: tm.income ? savings / tm.income * 100 : 0, investmentRate: tm.income ? tm.investment / tm.income * 100 : 0, monthly, byCategory: byCategory.sort((a, b) => b.total - a.total), plans });
    }
    if (req.method === 'GET' && u.pathname === '/api/export.csv') {
      const y = u.searchParams.get('year'), rows = db.transactions.filter(x => x.userId === user.id && x.txn_date.startsWith(y)), esc = v => `"${String(v ?? '').replaceAll('"', '""')}"`, csv = ['Date,Type,Category,Amount INR,Account,Payment Mode,Merchant,Notes,Recurring', ...rows.map(r => [r.txn_date, r.type, r.category, amount(r.amount_paise), r.account, r.payment_mode, r.merchant, r.notes, r.recurring ? 'Yes' : 'No'].map(esc).join(','))].join('\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="finance-${y}.csv"` }); return res.end('\uFEFF' + csv);
    }
    if (req.method === 'POST' && u.pathname === '/api/ai/chat') {
      const b = await body(req), message = String(b.message || '').trim(), year = Number(b.year || new Date().getFullYear());
      if (!message || message.length > 2000) return json(res, 400, { error: 'Enter a message up to 2,000 characters.' });
      const result = await geminiFinance(user, message, year); let added = null;
      if (result.action === 'add_transaction' && result.transaction) {
        const t = clean(result.transaction); t.id = id('transaction'); t.userId = user.id; t.created_at = now();
        db.transactions.push(t); audit(user.id, 'ai_create', 'transaction', t.id); added = { ...t, amount: amount(t.amount_paise) };
      }
      return json(res, 200, { reply: String(result.reply || 'Done.'), added });
    }
    if (req.method === 'GET' && u.pathname === '/api/backup') {
      const payload = { format: 'lifetime-finance-tracker-v1', exportedAt: now(), user: { name: user.name, email: user.email, currency: user.currency }, transactions: db.transactions.filter(x => x.userId === user.id), plans: db.plans.filter(x => x.userId === user.id) };
      return json(res, 200, payload, { 'Content-Disposition': `attachment; filename="finance-backup-${now().slice(0, 10)}.json"` });
    }
    if (req.method === 'POST' && u.pathname === '/api/restore') {
      const b = await body(req); if (b?.format !== 'lifetime-finance-tracker-v1' || !Array.isArray(b.transactions) || !Array.isArray(b.plans)) return json(res, 400, { error: 'Invalid backup file.' });
      db.transactions = db.transactions.filter(x => x.userId !== user.id); db.plans = db.plans.filter(x => x.userId !== user.id);
      for (const x of b.transactions) { const t = { ...x, id: id('transaction'), userId: user.id }; db.transactions.push(t); }
      for (const x of b.plans) { db.plans.push({ ...x, id: id('plan'), userId: user.id }); }
      audit(user.id, 'restore', 'backup'); return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) { console.error(e); return json(res, 400, { error: e.message || 'Request failed' }); }
};

const server = http.createServer(serverHandler);
if (require.main === module) {
  server.listen(PORT, () => console.log(`Lifetime Finance Tracker running on http://localhost:${PORT}`));
}

module.exports = serverHandler;
