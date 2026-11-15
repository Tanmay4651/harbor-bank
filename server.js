'use strict';
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const crypto = require('crypto'), path = require('path'), Database = require('better-sqlite3');

const PROD = process.env.NODE_ENV === 'production';
const DEMO = process.env.DEMO_MODE === 'true';
const SECRET = process.env.JWT_SECRET;
const MAX = parseInt(process.env.MAX_TRANSFER_PAISE || '10000000', 10);
if (!SECRET || SECRET.length < 32) { console.error('Set JWT_SECRET (32+ characters). See .env.example'); process.exit(1); }

// ---------- Database ----------
const db = new Database(process.env.DB_FILE || 'bank.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS accounts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  number TEXT NOT NULL UNIQUE,
  balance_paise INTEGER NOT NULL DEFAULT 0 CHECK(balance_paise >= 0));
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('debit','credit','topup')),
  amount_paise INTEGER NOT NULL CHECK(amount_paise > 0),
  balance_after_paise INTEGER NOT NULL, counterparty TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ledger_acct ON ledger(account_id, id DESC);
CREATE TABLE IF NOT EXISTS transfers(
  id INTEGER PRIMARY KEY, from_user INTEGER NOT NULL, idem_key TEXT NOT NULL,
  result TEXT NOT NULL, UNIQUE(from_user, idem_key));
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
`);

// ---------- Helpers ----------
const E = (status, error) => Object.assign(new Error(error), { status });
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY = bcrypt.hashSync('timing-equaliser', 12);
const toPaise = v => {
  const s = String(v ?? '').trim();
  return /^\d{1,9}(\.\d{1,2})?$/.test(s) ? Math.round(parseFloat(s) * 100) : 0;
};
const newNumber = () => {
  for (;;) {
    const n = String(crypto.randomInt(100000000000, 1000000000000));
    if (!db.prepare('SELECT 1 FROM accounts WHERE number=?').get(n)) return n;
  }
};
const setSession = (res, uid) => res.cookie('sid', jwt.sign({ uid }, SECRET, { algorithm: 'HS256', expiresIn: '30m' }),
  { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 30 * 60 * 1000 });
const auth = (req, res, next) => {
  try { req.uid = jwt.verify(req.cookies.sid, SECRET, { algorithms: ['HS256'] }).uid; next(); }
  catch { next(E(401, 'Please log in.')); }
};

// ---------- App ----------
const app = express();
if (PROD) app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  'script-src': ["'self'", 'https://checkout.razorpay.com'],
  'frame-src': ['https://api.razorpay.com', 'https://checkout.razorpay.com'],
  'connect-src': ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
  'img-src': ["'self'", 'data:', 'https:'] } } }));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' } });

app.post('/api/signup', authLimiter, wrap(async (req, res) => {
  const { name, email, password } = req.body || {};
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 80) throw E(400, 'Enter your full name.');
  if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email)) throw E(400, 'Enter a valid email.');
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw E(400, 'Password must be 10 to 200 characters.');
  const hash = await bcrypt.hash(password, 12);
  let uid;
  try {
    uid = db.transaction(() => {
      const id = db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name.trim(), email.toLowerCase(), hash).lastInsertRowid;
      db.prepare('INSERT INTO accounts(user_id,number) VALUES(?,?)').run(id, newNumber());
      return id;
    })();
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) throw E(409, 'This email is already registered.');
    throw e;
  }
  setSession(res, uid); res.status(201).json({ ok: true });
}));

app.post('/api/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || password.length > 200) throw E(400, 'Enter email and password.');
  const u = db.prepare('SELECT id,password_hash FROM users WHERE email=?').get(email.toLowerCase());
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY);
  if (!u || !ok) throw E(401, 'Wrong email or password.');
  setSession(res, u.id); res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => { res.clearCookie('sid'); res.json({ ok: true }); });

app.get('/api/me', auth, wrap((req, res) => {
  const user = db.prepare('SELECT name,email FROM users WHERE id=?').get(req.uid);
  const account = db.prepare('SELECT id,number,balance_paise AS balance FROM accounts WHERE user_id=?').get(req.uid);
  if (!user || !account) throw E(401, 'Please log in.');
  const ledger = db.prepare('SELECT kind,amount_paise AS amount,balance_after_paise AS balanceAfter,counterparty,note,created_at AS at FROM ledger WHERE account_id=? ORDER BY id DESC LIMIT 50').all(account.id);
  res.json({ user, account: { number: account.number, balance: account.balance }, ledger, demo: DEMO });
}));

const doTransfer = db.transaction((uid, toNumber, amt, note, key) => {
  const prev = db.prepare('SELECT result FROM transfers WHERE from_user=? AND idem_key=?').get(uid, key);
  if (prev) return JSON.parse(prev.result);
  const from = db.prepare('SELECT * FROM accounts WHERE user_id=?').get(uid);
  const to = db.prepare('SELECT * FROM accounts WHERE number=?').get(toNumber);
  if (!to) throw E(404, 'No account with that number.');
  if (to.id === from.id) throw E(400, 'You cannot send money to yourself.');
  if (from.balance_paise < amt) throw E(400, 'Insufficient balance.');
  const fb = from.balance_paise - amt, tb = to.balance_paise + amt;
  db.prepare('UPDATE accounts SET balance_paise=? WHERE id=?').run(fb, from.id);
  db.prepare('UPDATE accounts SET balance_paise=? WHERE id=?').run(tb, to.id);
  const ins = db.prepare('INSERT INTO ledger(account_id,kind,amount_paise,balance_after_paise,counterparty,note) VALUES(?,?,?,?,?,?)');
  ins.run(from.id, 'debit', amt, fb, to.number, note);
  ins.run(to.id, 'credit', amt, tb, from.number, note);
  const result = { ok: true, balance: fb };
  db.prepare('INSERT INTO transfers(from_user,idem_key,result) VALUES(?,?,?)').run(uid, key, JSON.stringify(result));
  return result;
});

app.post('/api/transfer', auth, wrap((req, res) => {
  const { toNumber, amount, note, idemKey } = req.body || {};
  const amt = toPaise(amount);
  if (typeof toNumber !== 'string' || !/^\d{12}$/.test(toNumber)) throw E(400, 'Enter a valid 12-digit account number.');
  if (!amt) throw E(400, 'Enter a valid amount.');
  if (amt > MAX) throw E(400, 'Amount is above the per-transfer limit.');
  if (typeof idemKey !== 'string' || idemKey.length < 8 || idemKey.length > 64) throw E(400, 'Missing request key.');
  const n = typeof note === 'string' ? note.trim().slice(0, 60) : '';
  res.json(doTransfer.immediate(req.uid, toNumber, amt, n, idemKey));
}));

if (DEMO) {
  const topup = db.transaction((uid, amt) => {
    const a = db.prepare('SELECT * FROM accounts WHERE user_id=?').get(uid), nb = a.balance_paise + amt;
    db.prepare('UPDATE accounts SET balance_paise=? WHERE id=?').run(nb, a.id);
    db.prepare("INSERT INTO ledger(account_id,kind,amount_paise,balance_after_paise,counterparty) VALUES(?,?,?,?,'DEMO')").run(a.id, 'topup', amt, nb);
  });
  app.post('/api/dev/topup', auth, wrap((req, res) => {
    const amt = toPaise(req.body?.amount);
    if (!amt || amt > 10000000) throw E(400, 'Amount must be up to 1,00,000.');
    topup.immediate(req.uid, amt); res.json({ ok: true });
  }));
}

require('./features')(app, { db, auth, wrap, E, toPaise, lim: authLimiter });

// ---------- Static Files & Root Route Fix ----------
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, _next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error.' });
});
app.listen(process.env.PORT || 3000, () => console.log('Harbor Bank on port ' + (process.env.PORT || 3000) + (DEMO ? ' (DEMO MODE)' : '')));