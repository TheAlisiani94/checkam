/* Shared helpers for the CheckAm partner, admin and agency pages. */
(() => {
'use strict';
const CFG = window.CHECKAM_CONFIG || {};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = v => { if (!v) return '—'; const d = new Date(v); return isNaN(d) ? '—' : d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); };
const STATES = ['Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara'];

// The eight checks, in the order they are shown, with who confirms each and how.
const CHECKS = [
  { kind: 'nafdac', title: 'NAFDAC registration', who: 'Checked against the NAFDAC Greenbook', how: 'Every product listed must appear in the Greenbook under your company name with an active status.' },
  { kind: 'pcn', title: 'PCN premises licence', who: 'Checked against PCN\'s Verify Premises record', how: 'Your premises must be registered with the Pharmacy Council of Nigeria and the licence current.' },
  { kind: 'cac', title: 'CAC company record', who: 'Checked against the CAC public search', how: 'Your company must be active, with the same name and address as your application.' },
  { kind: 'gs1', title: 'GS1 product numbers', who: 'Checked with Verified by GS1', how: 'The GS1 company prefix must be licensed to your company, so nobody else can register your products.' },
  { kind: 'email', title: 'Official email', who: 'Code sent automatically to your official email', how: 'Enter the code we email to your company address. It proves you control the company\'s email.' },
  { kind: 'courier', title: 'Factory address', who: 'Code sent by courier', how: 'We send a code by courier to the factory address on your public records. Enter it here when it arrives.' }
];
const CHECK = Object.fromEntries(CHECKS.map(c => [c.kind, c]));
const DOCS = [
  { kind: 'cac', title: 'CAC certificate of incorporation' },
  { kind: 'nafdac', title: 'NAFDAC certificate(s) of registration', many: true },
  { kind: 'pcn', title: 'PCN premises licence (current year)' },
  { kind: 'gs1', title: 'GS1 Nigeria membership certificate' },
  { kind: 'other', title: 'Other supporting documents (optional)', many: true }
];
const STATUS = {
  draft: ['Draft', 't-info'], pending: ['Being verified', 't-warn'], approved: ['Verified', 't-ok'],
  suspended: ['Suspended', 't-bad'], rejected: ['Needs changes', 't-bad']
};
const statusTag = s => { const v = STATUS[s] || [s, 't-info']; return '<span class="tag ' + v[1] + '">' + esc(v[0]) + '</span>'; };
const icon = st => st === 'passed' ? '✓' : st === 'failed' ? '✕' : '…';

let toastT;
function toast(msg) { const t = $('toast'); if (!t) return; t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200); }

const sb = (window.supabase && CFG.SUPABASE_URL) ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

// Plain call for public functions (works without signing in).
async function publicRpc(name, body) {
  const r = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY }, body: JSON.stringify(body || {})
  });
  const txt = await r.text(); const data = txt ? JSON.parse(txt) : null;
  if (!r.ok) throw new Error((data && (data.message || data.msg)) || ('Error ' + r.status));
  return data;
}
const errText = e => String((e && (e.message || e.error_description || e.msg)) || e || 'Something went wrong').replace(/^.*?ERROR:\s*/, '');

function renderChecks(checks, opts = {}) {
  const by = Object.fromEntries((checks || []).map(c => [c.kind, c]));
  return '<div class="checks">' + CHECKS.map(c => {
    const x = by[c.kind] || { status: 'pending' };
    const st = x.status || 'pending';
    return '<div class="check"><span class="ic ' + st + '" aria-hidden="true">' + icon(st) + '</span><div><h3>' + esc(c.title) + '</h3><p class="who">' + esc(c.who) + '</p>' +
      (opts.how && st !== 'passed' ? '<p class="note" style="margin-top:4px">' + esc(c.how) + '</p>' : '') +
      (x.note ? '<p style="margin-top:6px;font-size:15px">' + (st === 'failed' ? '<b>Reason: </b>' : '') + esc(x.note) + '</p>' : '') +
      (opts.extra ? opts.extra(c.kind, x) : '') +
      '</div><span class="tag ' + (st === 'passed' ? 't-ok' : st === 'failed' ? 't-bad' : 't-info') + '">' + (st === 'passed' ? 'Passed' : st === 'failed' ? 'Needs attention' : 'Waiting') + '</span></div>';
  }).join('') + '</div>';
}
function progress(checks) {
  const n = (checks || []).filter(c => c.status === 'passed' && CHECK[c.kind]).length;
  return '<div class="row" style="justify-content:space-between;margin-bottom:6px"><b>' + n + ' of ' + CHECKS.length + ' checks passed</b><span class="note">' + (n === CHECKS.length ? 'Complete' : 'Approval is automatic when all ' + CHECKS.length + ' pass') + '</span></div><div class="progress"><i style="width:' + (n / CHECKS.length * 100) + '%"></i></div>';
}

function parseGS1(text) {
  let t = String(text).trim(); const out = {};
  if (/^\(\d{2,4}\)/.test(t)) { const re = /\((\d{2,4})\)([^(]*)/g; let m; while ((m = re.exec(t))) out[m[1]] = m[2].trim(); return out; }
  t = t.replace(/^\]d2|^\]C1/, '').replace(/^\u001d/, '');
  const fixed = { '01': 14, '11': 6, '17': 6 }; let i = 0, guard = 0;
  while (i < t.length && guard++ < 12) {
    const two = t.slice(i, i + 2);
    if (fixed[two]) { out[two] = t.slice(i + 2, i + 2 + fixed[two]); i += 2 + fixed[two]; continue; }
    if (two === '10' || two === '21') { let j = t.indexOf('\u001d', i + 2); if (j < 0) j = t.length; out[two] = t.slice(i + 2, j); i = j + 1; continue; }
    break;
  }
  return out;
}
window.CK = { CFG, $, esc, fmtDate, STATES, CHECKS, CHECK, DOCS, STATUS, statusTag, toast, sb, publicRpc, errText, renderChecks, progress, parseGS1 };
})();
