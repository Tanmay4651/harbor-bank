'use strict';
const emiCalc = (p, n, r) => { const i = r / 1200, f = Math.pow(1 + i, n); return Math.round(p * i * f / (f - 1)); };
const loadRzp = () => window.Razorpay ? Promise.resolve() : new Promise((ok, no) => {
  const s = document.createElement('script'); s.src = 'https://checkout.razorpay.com/v1/checkout.js';
  s.onload = ok; s.onerror = () => no(new Error('Could not load Razorpay.')); document.head.append(s); });

async function renderMore() {
  const box = $('more'); if (!box) return;
  let f; try { f = await api('/features'); } catch (x) { return; }
  const note = h('p', { role: 'status' }); if (window.__msg) { say(note, window.__msg, true); window.__msg = ''; }
  const act = async (path, body, msg, method = 'POST') => { try { await api(path, method, body); window.__msg = msg; await load(); } catch (x) { say(note, x.message); } };
  const v = id => $(id).value;
  const card = (title, ...kids) => h('div', { class: 'card' }, h('h2', {}, title), ...kids);
  const btn = (t, fn, cls = '') => h('button', { type: 'button', class: cls, onclick: fn }, t);

  const add = card('Add money (Razorpay)',
    f.razorpay ? '' : h('p', { class: 'err' }, 'Payments are not configured. Set RZP_KEY_ID and RZP_KEY_SECRET on the server.'),
    field('rzamt', 'Amount (₹1 to ₹50,000)', 'text', { inputmode: 'decimal' }),
    btn('Pay with Razorpay', async () => { try {
      const o = await api('/add-money', 'POST', { amount: v('rzamt') }); await loadRzp();
      new Razorpay({ key: o.keyId, amount: o.amount, currency: 'INR', order_id: o.orderId, name: 'Harbor Bank',
        handler: r => act('/verify-payment', { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }, 'Payment received.') }).open();
    } catch (x) { say(note, x.message); } }));

  const pay = card('Payees',
    ...(f.payees.length ? f.payees.map(p => h('div', { class: 'row' }, h('div', {}, h('strong', {}, p.name), h('div', { class: 'mut' }, p.number)),
      h('div', {}, btn('Send', () => { $('to').value = p.number; window.scrollTo(0, 0); $('amt').focus(); }, 'alt'), ' ',
        btn('Remove', () => act('/payees/' + p.id, undefined, 'Payee removed.', 'DELETE'), 'alt')))) : [h('p', { class: 'mut' }, 'No saved payees.')]),
    field('pn', 'Name', 'text', { maxlength: '60' }), field('pnum', 'Account number', 'text', { inputmode: 'numeric', maxlength: '12' }),
    btn('Save payee', () => act('/payees', { name: v('pn'), number: v('pnum') }, 'Payee saved.')));

  const pct = Math.min(100, Math.round(f.pot.balance / f.pot.goal * 100));
  const sav = card('Savings pot', h('div', { class: 'big' }, inr(f.pot.balance)),
    h('p', { class: 'mut' }, f.pot.goalName + ': ' + pct + '% of ' + inr(f.pot.goal)),
    h('progress', { max: '100', value: String(pct), style: 'width:100%', 'aria-label': 'Goal progress' }),
    field('sv', 'Amount (₹)', 'text', { inputmode: 'decimal' }),
    btn('Move to savings', () => act('/pot', { action: 'deposit', amount: v('sv') }, 'Moved to savings.')), ' ',
    btn('Withdraw', () => act('/pot', { action: 'withdraw', amount: v('sv') }, 'Withdrawn to your account.'), 'alt'),
    field('gn', 'Goal name', 'text', { value: f.pot.goalName, maxlength: '40' }), field('gt', 'Goal amount (₹)', 'text', { value: String(f.pot.goal / 100) }),
    btn('Save goal', () => act('/pot/goal', { name: v('gn'), target: v('gt') }, 'Goal saved.'), 'alt'));

  const emiOut = h('strong', {}, inr(emiCalc(10000000, 12, f.rate)));
  const upd = () => { const p = Math.round(parseFloat(v('lp')) * 100), n = +v('lm'); emiOut.textContent = p > 0 && n > 0 ? inr(emiCalc(p, n, f.rate)) : '—'; };
  const loans = card('Loans', h('p', { class: 'mut' }, 'Demo rate ' + f.rate + '% a year. ₹1,000 to ₹10,00,000, up to 3 active loans.'),
    field('lp', 'Amount (₹)', 'text', { value: '100000', inputmode: 'decimal', oninput: upd }),
    field('lm', 'Months (6, 12, 24, 36 or 60)', 'text', { value: '12', oninput: upd }),
    h('p', {}, 'Monthly EMI: ', emiOut),
    btn('Apply and get funds', () => act('/loans', { amount: v('lp'), months: v('lm') }, 'Loan approved. Money added to your account.')),
    ...f.loans.map(l => h('div', { class: 'row' }, h('div', {}, h('strong', {}, inr(l.principal)),
      h('div', { class: 'mut' }, l.remaining + ' of ' + l.months + ' EMIs left · ' + inr(l.emi))), btn('Pay EMI', () => act('/loans/' + l.id + '/emi', {}, 'EMI paid.')))));

  const cd = card('Debit card',
    h('div', { style: 'border-radius:14px;padding:18px;background:#0E1B2C;color:#fff;opacity:' + (f.card.frozen ? '.5' : '1') },
      h('div', {}, '•••• •••• •••• ' + f.last4), h('div', {}, f.card.frozen ? 'FROZEN' : 'ACTIVE')),
    h('p', { class: 'mut' }, 'Spent this month: ' + inr(f.card.spent) + ' of ' + inr(f.card.limit)),
    btn(f.card.frozen ? 'Unfreeze card' : 'Freeze card', () => act('/card', { frozen: !f.card.frozen }, f.card.frozen ? 'Card unfrozen.' : 'Card frozen.')),
    field('cl', 'Monthly limit (₹)', 'text', { value: String(f.card.limit / 100) }), btn('Save limit', () => act('/card/limit', { limit: v('cl') }, 'Limit saved.'), 'alt'),
    field('cm', 'Test card payment: merchant', 'text', { maxlength: '40' }), field('ca', 'Amount (₹)', 'text', { inputmode: 'decimal' }),
    btn('Pay with card', () => act('/card/pay', { merchant: v('cm'), amount: v('ca') }, 'Card payment done.')));

  const sec = card('Account', h('a', { href: '/api/statement.csv', download: 'harbor-statement.csv' }, 'Download statement (CSV)'),
    field('pw0', 'Current password', 'password', { autocomplete: 'current-password' }),
    field('pw1', 'New password (10+ characters)', 'password', { autocomplete: 'new-password' }),
    btn('Change password', () => act('/password', { current: v('pw0'), next: v('pw1') }, 'Password changed.'), 'alt'));

  box.replaceChildren(note, h('div', { class: 'grid' }, add, sav, loans, cd, pay, sec));
}
