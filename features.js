'use strict';
const crypto = require('crypto'), bcrypt = require('bcryptjs');

module.exports = function mount(app, { db, auth, wrap, E, toPaise, lim }) {
  const KEY_ID = process.env.RZP_KEY_ID, KEY_SECRET = process.env.RZP_KEY_SECRET, RATE = 10.5;
  db.exec(`
  CREATE TABLE IF NOT EXISTS payees(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, number TEXT NOT NULL, UNIQUE(user_id,number));
  CREATE TABLE IF NOT EXISTS loans(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), principal INTEGER NOT NULL, months INTEGER NOT NULL, emi INTEGER NOT NULL, remaining INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS pots(user_id INTEGER PRIMARY KEY REFERENCES users(id), balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), goal_name TEXT NOT NULL DEFAULT 'My goal', goal INTEGER NOT NULL DEFAULT 10000000);
  CREATE TABLE IF NOT EXISTS cards(user_id INTEGER PRIMARY KEY REFERENCES users(id), frozen INTEGER NOT NULL DEFAULT 0, monthly_limit INTEGER NOT NULL DEFAULT 5000000);
  CREATE TABLE IF NOT EXISTS payments(order_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, payment_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'created');`);

  const q = s => db.prepare(s);
  const acct = uid => q('SELECT * FROM accounts WHERE user_id=?').get(uid);
  const ensure = uid => { q('INSERT OR IGNORE INTO pots(user_id) VALUES(?)').run(uid); q('INSERT OR IGNORE INTO cards(user_id) VALUES(?)').run(uid); };
  const amount = (v, max) => { const a = toPaise(v); if (!a) throw E(400, 'Enter a valid amount.'); if (a > max) throw E(400, 'Amount is too large.'); return a; };
  const text = (v, min, max, msg) => { const s = typeof v === 'string' ? v.trim() : ''; if (s.length < min || s.length > max) throw E(400, msg); return s; };
  const emiOf = (p, n) => { const i = RATE / 1200, f = Math.pow(1 + i, n); return Math.round(p * i * f / (f - 1)); };
  const spent = uid => q("SELECT COALESCE(SUM(amount_paise),0) s FROM ledger WHERE account_id=? AND kind='debit' AND counterparty LIKE 'CARD %' AND created_at>=strftime('%Y-%m-01','now')").get(acct(uid).id).s;

  // Must run inside a transaction. Moves money on the main account and writes the ledger.
  function adjust(uid, delta, who, note = '') {
    const a = acct(uid), nb = a.balance_paise + delta;
    if (nb < 0) throw E(400, 'Insufficient balance.');
    q('UPDATE accounts SET balance_paise=? WHERE id=?').run(nb, a.id);
    q('INSERT INTO ledger(account_id,kind,amount_paise,balance_after_paise,counterparty,note) VALUES(?,?,?,?,?,?)')
      .run(a.id, delta > 0 ? 'credit' : 'debit', Math.abs(delta), nb, who, note);
    return nb;
  }
  const route = (method, path, fn) => app[method](path, auth, wrap((req, res) => {
    ensure(req.uid);
    res.json(db.transaction(fn).immediate(req.uid, req.body || {}, req.params));
  }));

  app.get('/api/features', auth, wrap((req, res) => {
    const u = req.uid; ensure(u);
    const pot = q('SELECT balance,goal,goal_name goalName FROM pots WHERE user_id=?').get(u);
    const c = q('SELECT frozen,monthly_limit FROM cards WHERE user_id=?').get(u);
    res.json({
      rate: RATE, razorpay: !!(KEY_ID && KEY_SECRET), last4: acct(u).number.slice(-4), pot,
      card: { frozen: !!c.frozen, limit: c.monthly_limit, spent: spent(u) },
      payees: q('SELECT id,name,number FROM payees WHERE user_id=? ORDER BY name').all(u),
      loans: q('SELECT id,principal,months,emi,remaining FROM loans WHERE user_id=? AND remaining>0 ORDER BY id DESC').all(u)
    });
  }));

  // ----- Payees -----
  route('post', '/api/payees', (uid, b) => {
    const name = text(b.name, 1, 60, 'Enter a name.');
    if (typeof b.number !== 'string' || !/^\d{12}$/.test(b.number)) throw E(400, 'Enter a valid 12-digit account number.');
    const target = q('SELECT user_id FROM accounts WHERE number=?').get(b.number);
    if (!target) throw E(404, 'No account with that number.');
    if (target.user_id === uid) throw E(400, 'That is your own account.');
    if (q('INSERT OR IGNORE INTO payees(user_id,name,number) VALUES(?,?,?)').run(uid, name, b.number).changes === 0) throw E(409, 'Already saved.');
    return { ok: true };
  });
  route('delete', '/api/payees/:id', (uid, b, p) => { q('DELETE FROM payees WHERE id=? AND user_id=?').run(+p.id, uid); return { ok: true }; });

  // ----- Savings pot -----
  route('post', '/api/pot', (uid, b) => {
    const amt = amount(b.amount, 1000000000), pot = q('SELECT balance FROM pots WHERE user_id=?').get(uid);
    if (b.action === 'deposit') { adjust(uid, -amt, 'SAVINGS', 'To savings'); q('UPDATE pots SET balance=balance+? WHERE user_id=?').run(amt, uid); }
    else if (b.action === 'withdraw') {
      if (pot.balance < amt) throw E(400, 'Not enough in savings.');
      q('UPDATE pots SET balance=balance-? WHERE user_id=?').run(amt, uid); adjust(uid, amt, 'SAVINGS', 'From savings');
    } else throw E(400, 'Unknown action.');
    return { ok: true };
  });
  route('post', '/api/pot/goal', (uid, b) => {
    q('UPDATE pots SET goal_name=?, goal=? WHERE user_id=?').run(text(b.name, 1, 40, 'Enter a goal name.'), amount(b.target, 100000000000), uid);
    return { ok: true };
  });

  // ----- Loans -----
  route('post', '/api/loans', (uid, b) => {
    const p = amount(b.amount, 100000000), n = parseInt(b.months, 10);
    if (p < 100000) throw E(400, 'Minimum loan is 1,000.');
    if (![6, 12, 24, 36, 60].includes(n)) throw E(400, 'Choose 6, 12, 24, 36 or 60 months.');
    if (q('SELECT COUNT(*) c FROM loans WHERE user_id=? AND remaining>0').get(uid).c >= 3) throw E(400, 'You already have 3 active loans.');
    q('INSERT INTO loans(user_id,principal,months,emi,remaining) VALUES(?,?,?,?,?)').run(uid, p, n, emiOf(p, n), n);
    adjust(uid, p, 'LOAN', 'Loan disbursed');
    return { ok: true };
  });
  route('post', '/api/loans/:id/emi', (uid, b, p) => {
    const l = q('SELECT * FROM loans WHERE id=? AND user_id=? AND remaining>0').get(+p.id, uid);
    if (!l) throw E(404, 'Loan not found.');
    adjust(uid, -l.emi, 'EMI', 'Loan EMI');
    q('UPDATE loans SET remaining=remaining-1 WHERE id=?').run(l.id);
    return { ok: true };
  });

  // ----- Debit card -----
  route('post', '/api/card', (uid, b) => { q('UPDATE cards SET frozen=? WHERE user_id=?').run(b.frozen ? 1 : 0, uid); return { ok: true }; });
  route('post', '/api/card/limit', (uid, b) => { q('UPDATE cards SET monthly_limit=? WHERE user_id=?').run(amount(b.limit, 1000000000), uid); return { ok: true }; });
  route('post', '/api/card/pay', (uid, b) => {
    const amt = amount(b.amount, 1000000000), m = text(b.merchant, 1, 40, 'Enter a merchant name.');
    const c = q('SELECT * FROM cards WHERE user_id=?').get(uid);
    if (c.frozen) throw E(400, 'Your card is frozen.');
    if (spent(uid) + amt > c.monthly_limit) throw E(400, 'This would pass your monthly card limit.');
    adjust(uid, -amt, 'CARD ' + m, 'Card payment');
    return { ok: true };
  });

  // ----- Razorpay add money (test mode with test keys) -----
  app.post('/api/add-money', auth, wrap(async (req, res) => {
    if (!KEY_ID || !KEY_SECRET) throw E(503, 'Payments are not configured on this server.');
    const amt = amount(req.body && req.body.amount, 5000000);
    if (amt < 100) throw E(400, 'Minimum is 1.');
    const r = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64') },
      body: JSON.stringify({ amount: amt, currency: 'INR', receipt: 'u' + req.uid + '_' + Date.now() }) });
    const o = await r.json().catch(() => ({}));
    if (!r.ok || !o.id) { console.error('Razorpay order error', r.status, o); throw E(502, 'Payment provider error. Try again.'); }
    q('INSERT INTO payments(order_id,user_id,amount) VALUES(?,?,?)').run(o.id, req.uid, amt);
    res.json({ orderId: o.id, amount: amt, keyId: KEY_ID });
  }));
  const credit = db.transaction((uid, orderId, paymentId) => {
    const p = q('SELECT * FROM payments WHERE order_id=? AND user_id=?').get(orderId, uid);
    if (!p) throw E(404, 'Unknown order.');
    if (p.status === 'paid') return { ok: true };            // already credited: never credit twice
    q("UPDATE payments SET status='paid', payment_id=? WHERE order_id=?").run(paymentId, orderId);
    adjust(uid, p.amount, 'RAZORPAY', 'Add money');
    return { ok: true };
  });
  app.post('/api/verify-payment', auth, wrap((req, res) => {
    const { orderId, paymentId, signature } = req.body || {};
    if (!KEY_SECRET || [orderId, paymentId, signature].some(v => typeof v !== 'string' || v.length > 100)) throw E(400, 'Invalid payment data.');
    const exp = crypto.createHmac('sha256', KEY_SECRET).update(orderId + '|' + paymentId).digest('hex');
    if (signature.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(signature))) throw E(400, 'Payment verification failed.');
    res.json(credit.immediate(req.uid, orderId, paymentId));
  }));

  // ----- Account -----
  app.post('/api/password', lim, auth, wrap(async (req, res) => {
    const { current, next } = req.body || {};
    if (typeof current !== 'string' || typeof next !== 'string' || current.length > 200 || next.length < 10 || next.length > 200) throw E(400, 'New password must be 10 to 200 characters.');
    const u = q('SELECT password_hash FROM users WHERE id=?').get(req.uid);
    if (!(await bcrypt.compare(current, u.password_hash))) throw E(400, 'Current password is wrong.');
    q('UPDATE users SET password_hash=? WHERE id=?').run(await bcrypt.hash(next, 12), req.uid);
    res.json({ ok: true });
  }));
  app.get('/api/statement.csv', auth, wrap((req, res) => {
    const rows = q('SELECT created_at,kind,amount_paise,balance_after_paise,counterparty,note FROM ledger WHERE account_id=? ORDER BY id DESC').all(acct(req.uid).id);
    const c = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = ['Date,Type,Amount (INR),Balance after (INR),Counterparty,Note'].concat(rows.map(r =>
      [c(r.created_at), c(r.kind), (r.amount_paise / 100).toFixed(2), (r.balance_after_paise / 100).toFixed(2), c(r.counterparty), c(r.note)].join(','))).join('\r\n');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="harbor-statement.csv"' }).send(csv);
  }));
};
