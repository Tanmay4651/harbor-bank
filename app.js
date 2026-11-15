'use strict';
const $ = id => document.getElementById(id), root = $('app');
const h = (t, a = {}, ...c) => { const e = document.createElement(t);
  for (const [k, v] of Object.entries(a)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  e.append(...c); return e; };
const inr = p => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(p / 100);
const say = (el, t, ok) => { el.textContent = t; el.className = ok ? 'ok' : 'err'; };
const field = (id, label, type = 'text', x = {}) => h('div', {}, h('label', { for: id }, label), h('input', { id, type, ...x }));
let flash = '';
const label = l => l.kind === 'topup' ? 'Demo top-up' : /^\d{12}$/.test(l.counterparty)
  ? (l.kind === 'debit' ? 'Sent to ' : 'Received from ') + l.counterparty
  : (l.kind === 'debit' ? 'Paid: ' : 'Received: ') + l.counterparty;

async function api(p, method = 'GET', body) {
  const r = await fetch('/api' + p, { method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong.'), { status: r.status });
  return d;
}

function authView(signup) {
  const note = h('p', { role: 'alert' });
  const form = h('form', { onsubmit: async e => { e.preventDefault();
      try { await api(signup ? '/signup' : '/login', 'POST', { name: signup ? $('name').value : undefined, email: $('email').value, password: $('pw').value }); load(); }
      catch (x) { say(note, x.message); } } },
    h('h1', {}, signup ? 'Open an account' : 'Log in'),
    ...(signup ? [field('name', 'Full name', 'text', { autocomplete: 'name', required: '' })] : []),
    field('email', 'Email', 'email', { autocomplete: 'email', required: '' }),
    field('pw', 'Password', 'password', { autocomplete: signup ? 'new-password' : 'current-password', required: '', minlength: signup ? '10' : '1' }),
    h('button', { type: 'submit' }, signup ? 'Create account' : 'Log in'), note,
    h('button', { type: 'button', class: 'link', onclick: () => authView(!signup) }, signup ? 'I already have an account' : 'New here? Open an account'));
  root.replaceChildren(h('div', { class: 'card narrow' }, form));
}

function dashView(me) {
  let key = crypto.randomUUID();
  const note = h('p', { role: 'status' }); if (flash) { say(note, flash, true); flash = ''; }
  const send = h('form', { onsubmit: async e => { e.preventDefault();
      try { await api('/transfer', 'POST', { toNumber: $('to').value.trim(), amount: $('amt').value, note: $('nt').value, idemKey: key });
        key = crypto.randomUUID(); flash = 'Money sent.'; load(); } catch (x) { say(note, x.message); } } },
    h('h2', {}, 'Send money'),
    field('to', 'Recipient account number', 'text', { inputmode: 'numeric', required: '', pattern: '\\d{12}', maxlength: '12' }),
    field('amt', 'Amount (₹)', 'text', { inputmode: 'decimal', required: '' }),
    field('nt', 'Note (optional)', 'text', { maxlength: '60' }),
    h('button', { type: 'submit' }, 'Send'), note);
  const rows = me.ledger.length ? me.ledger.map(l => h('div', { class: 'row' },
    h('div', {}, h('strong', {}, label(l)),
      h('div', { class: 'mut' }, new Date(l.at.replace(' ', 'T') + 'Z').toLocaleString('en-IN') + (l.note ? ' · ' + l.note : ''))),
    h('strong', {}, (l.kind === 'debit' ? '−' : '+') + inr(l.amount)))) : [h('p', { class: 'mut' }, 'No transactions yet.')];
  const top = me.demo ? h('button', { class: 'alt', onclick: async () => { try { await api('/dev/topup', 'POST', { amount: '1000' }); flash = 'Added ₹1,000 test money.'; load(); } catch (x) { alert(x.message); } } }, 'Add ₹1,000 test money') : '';
  root.replaceChildren(
    h('div', { class: 'bar' }, h('h1', {}, 'Harbor Bank'), h('button', { class: 'alt', onclick: async () => { await api('/logout', 'POST'); authView(false); } }, 'Log out')),
    h('div', { class: 'card', style: 'margin-top:18px' }, h('div', { class: 'mut' }, 'Hello, ' + me.user.name),
      h('div', { class: 'big' }, inr(me.account.balance)), h('div', { class: 'mut' }, 'Account number: ' + me.account.number), top),
    h('div', { class: 'grid' }, h('div', { class: 'card' }, send), h('div', { class: 'card' }, h('h2', {}, 'Recent activity'), ...rows)), h('div', { id: 'more' }));
  if (typeof renderMore === 'function') renderMore();
}

async function load() { try { dashView(await api('/me')); } catch (x) { if (x.status === 401) authView(false); else root.textContent = x.message; } }
load();
