/* CheckAm admin: review manufacturer applications, record checks, issue codes, send queued messages. */
(() => {
'use strict';
const { $, esc, fmtDate, CHECKS, CHECK, DOCS, STATUS, statusTag, toast, sb, errText, progress } = window.CK;
const MCOLS = 'id,owner,is_demo,status,kind,legal_name,trading_name,rc_number,gs1_prefix,factory_address,city,state,website,official_email,public_phone,contact_name,contact_role,contact_phone,foreign_manufacturer,foreign_country,status_reason,created_at,submitted_at,approved_at';
const SITE = location.origin + location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
const view = $('view');
let session = null, tab = 'apps', filter = 'pending', list = [], current = null, me = null;

// Where a reviewer confirms each check.
const LINKS = {
  nafdac: [['NAFDAC Greenbook', 'https://greenbook.nafdac.gov.ng/'], ['NAFDAC product verification', 'https://registration.nafdac.gov.ng/']],
  pcn: [['PCN Verify Premises', 'https://pcn.gov.ng/']],
  cac: [['CAC public search', 'https://search.cac.gov.ng/']],
  gs1: [['Verified by GS1', 'https://www.gs1.org/services/verified-by-gs1']]
};
const GUIDE = {
  nafdac: 'Search each product\'s NAFDAC number. The applicant or manufacturer must be this company and the status active.',
  pcn: 'Find the premises on PCN\'s Verify Premises. The address and licence year must match.',
  cac: 'Search the RC number. Name, address and active status must match the application.',
  gs1: 'Look up one of the product numbers. It must be licensed to this company.',
  email: 'A code was emailed automatically when the company submitted (see the Outbox). They enter it on their dashboard. Resend only if they lost it.',
  courier: 'Generate a code and print the letter. Send it by courier to the factory address on the public records, not only the address on the form.'
};

if (!sb) { view.innerHTML = '<div class="card"><h2>Not connected</h2></div>'; return; }

function renderWho() {
  $('who').innerHTML = session ? '<span class="note">' + esc(session.user.email) + '</span><button class="btn soft small" id="outBtn" type="button">Sign out</button>' : '';
  const o = $('outBtn'); if (o) o.addEventListener('click', () => sb.auth.signOut());
}
sb.auth.onAuthStateChange((_e, s) => { const ch = (s && s.user && s.user.id) !== (session && session.user && session.user.id); session = s; if (ch) start(); });
sb.auth.getSession().then(({ data }) => { session = data.session; start(); });

async function start() {
  renderWho();
  if (!session) return renderSignIn();
  const r = await sb.rpc('is_admin');
  if (!r.data) return renderNotAdmin();
  const a = await sb.from('admins').select('*').eq('user_id', session.user.id).maybeSingle();
  me = a.data || { role: 'reviewer' };
  render();
}
function renderSignIn() {
  view.innerHTML = '<section class="card" style="max-width:460px;margin:30px auto"><h2>Admin sign in</h2><form id="f" novalidate>' +
    '<label class="f" for="e">Email</label><input class="input" id="e" type="email" autocomplete="email">' +
    '<label class="f" for="p">Password</label><input class="input" id="p" type="password" autocomplete="current-password">' +
    '<p class="err" id="err" role="alert"></p><button class="btn" type="submit">Sign in</button></form>' +
    '<p class="note" style="margin-top:14px">No account yet? Create one on the <a href="partner.html">partner page</a> first, then come back. The first person to claim the admin area becomes its owner.</p></section>';
  $('f').addEventListener('submit', async ev => {
    ev.preventDefault();
    const r = await sb.auth.signInWithPassword({ email: $('e').value.trim(), password: $('p').value });
    if (r.error) $('err').textContent = errText(r.error);
  });
}
function renderNotAdmin() {
  view.innerHTML = '<section class="card" style="max-width:560px;margin:30px auto"><h2>This account is not an admin</h2>' +
    '<p class="sub" style="margin-top:8px">If you are setting up CheckAm and no owner exists yet, claim the admin area now. Otherwise ask the owner to add you.</p>' +
    '<label class="f" for="n">Your name</label><input class="input" id="n" autocomplete="name"><p class="err" id="err" role="alert"></p>' +
    '<button class="btn" id="claim" type="button">Claim owner access</button></section>';
  $('claim').addEventListener('click', async () => {
    const r = await sb.rpc('claim_owner', { p_name: $('n').value.trim() });
    if (r.error) return ($('err').textContent = errText(r.error));
    if (!r.data) return ($('err').textContent = 'An owner already exists. Ask them to add you as an admin.');
    toast('You are now the owner'); start();
  });
}

/* ---------- layout ---------- */
function render() {
  view.innerHTML = '<nav class="tabs" aria-label="Admin sections">' +
    [['apps', 'Applications'], ['outbox', 'Outbox'], ['settings', 'Settings']].map(([k, l]) => '<button type="button" data-tab="' + k + '"' + (tab === k ? ' aria-current="page"' : '') + '>' + l + '</button>').join('') +
    '</nav><div id="tabBody"></div>';
  view.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(); }));
  ({ apps: renderApps, outbox: renderOutbox, settings: renderSettings })[tab]();
}

/* ---------- applications ---------- */
async function renderApps() {
  $('tabBody').innerHTML = '<div class="split"><aside id="listCol"><p class="sub">Loading…</p></aside><section id="detailCol"></section></div>';
  const r = await sb.from('manufacturers').select(MCOLS).order('submitted_at', { ascending: false, nullsFirst: false });
  if (r.error) { $('listCol').innerHTML = '<p class="err">' + esc(errText(r.error)) + '</p>'; return; }
  list = r.data || [];
  renderList();
  const pick = current && list.find(m => m.id === current) || list.find(m => m.status === filter);
  if (pick) openApp(pick.id); else $('detailCol').innerHTML = '<div class="card"><p class="sub">Choose an application.</p></div>';
}
function renderList() {
  const counts = {}; list.forEach(m => { counts[m.status] = (counts[m.status] || 0) + 1; });
  const shown = filter === 'all' ? list : list.filter(m => m.status === filter);
  $('listCol').innerHTML = '<div class="tabs">' + ['pending', 'approved', 'suspended', 'rejected', 'draft', 'all'].map(s => '<button type="button" data-f="' + s + '"' + (filter === s ? ' aria-current="page"' : '') + '>' + (s === 'all' ? 'All' : STATUS[s][0]) + ' ' + (s === 'all' ? list.length : (counts[s] || 0)) + '</button>').join('') + '</div>' +
    '<div class="stack" style="gap:8px">' + (shown.length ? shown.map(m => '<button class="list-item" type="button" data-id="' + esc(m.id) + '"' + (m.id === current ? ' aria-current="true"' : '') + '><b>' + esc(m.legal_name || '(no name yet)') + (m.is_demo ? ' <span class="tag t-info">Demo</span>' : '') + '</b><span class="note">' + esc([m.state, m.kind].filter(Boolean).join(', ')) + '</span><span class="note">Submitted ' + esc(fmtDate(m.submitted_at)) + '</span></button>').join('') : '<p class="note">Nothing here.</p>') + '</div>';
  $('listCol').querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; renderList(); }));
  $('listCol').querySelectorAll('[data-id]').forEach(b => b.addEventListener('click', () => openApp(b.dataset.id)));
}
async function openApp(id) {
  current = id; renderList();
  const col = $('detailCol'); col.innerHTML = '<div class="card"><p class="sub">Loading…</p></div>';
  const m = list.find(x => x.id === id);
  const [p, d, c, a, n] = await Promise.all([
    sb.from('mfr_products').select('*').eq('manufacturer_id', id).order('created_at'),
    sb.from('mfr_documents').select('*').eq('manufacturer_id', id).order('uploaded_at'),
    sb.from('mfr_checks').select('*').eq('manufacturer_id', id),
    sb.from('audit_log').select('*').eq('manufacturer_id', id).order('at', { ascending: false }).limit(40),
    sb.from('agency_notices').select('*').eq('manufacturer_id', id).order('created_at')
  ]);
  const products = p.data || [], docs = d.data || [], checks = c.data || [], events = a.data || [], notices = n.data || [];
  const by = Object.fromEntries(checks.map(x => [x.kind, x]));
  const info = [['Kind', m.kind], ['Trading name', m.trading_name], ['CAC RC number', m.rc_number], ['GS1 prefix', m.gs1_prefix], ['Factory address', [m.factory_address, m.city, m.state].filter(Boolean).join(', ')], ['Website', m.website], ['Official email', m.official_email], ['Company phone (from form)', m.public_phone], ['Contact', [m.contact_name, m.contact_role, m.contact_phone].filter(Boolean).join(', ')]];
  if (m.kind === 'importer') info.push(['Foreign manufacturer', [m.foreign_manufacturer, m.foreign_country].filter(Boolean).join(', ')]);
  col.innerHTML =
    '<div class="stack">' +
    '<div class="card"><div class="row" style="justify-content:space-between"><div><h2>' + esc(m.legal_name || '(no name yet)') + '</h2><p class="note">Submitted ' + esc(fmtDate(m.submitted_at)) + (m.approved_at ? ', approved ' + esc(fmtDate(m.approved_at)) : '') + '</p></div>' + statusTag(m.status) + '</div>' +
      (m.status_reason ? '<p style="margin-top:10px"><b>Reason: </b>' + esc(m.status_reason) + '</p>' : '') +
      (m.is_demo ? '<p class="note" style="margin-top:8px">Demo company shown publicly on the partner page. Do not edit.</p>' : statusActions(m)) + '</div>' +
    (m.status === 'draft' ? '<div class="banner warn"><p>This company has not submitted yet. Checks start when they submit.</p></div>' : '') +
    '<div class="card"><h3>Company</h3><table class="t" style="margin-top:8px"><tbody>' + info.map(([k, v]) => '<tr><th style="width:38%">' + esc(k) + '</th><td>' + (k === 'Website' && /^https:\/\//.test(v || '') ? '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + '</a>' : esc(v || '—')) + '</td></tr>').join('') + '</tbody></table></div>' +
    '<div class="card"><h3>Products</h3><div class="scroll"><table class="t" style="margin-top:8px"><thead><tr><th>Product</th><th>NAFDAC no.</th><th>Expires</th><th>GTIN</th></tr></thead><tbody>' + (products.map(x => '<tr><td>' + esc(x.name) + ' <span class="note">' + esc([x.strength, x.dosage_form, x.pack_size].filter(Boolean).join(', ')) + '</span></td><td>' + esc(x.nafdac_no) + '</td><td>' + esc(fmtDate(x.nafdac_expiry)) + '</td><td>' + esc(x.gtin || '—') + '</td></tr>').join('') || '<tr><td colspan="4" class="note">None</td></tr>') + '</tbody></table></div></div>' +
    '<div class="card"><h3>Documents</h3><div class="stack" style="gap:6px;margin-top:8px">' + (docs.map(x => '<div class="doc"><span><b>' + esc((DOCS.find(k => k.kind === x.kind) || {}).title || x.kind) + '</b><br><span class="note">' + esc(x.file_name) + '</span></span><button class="btn soft small" type="button" data-open="' + esc(x.path) + '">Open</button></div>').join('') || '<p class="note">None uploaded.</p>') + '</div></div>' +
    (checks.length ? '<div class="card">' + progress(checks) + '<div class="checks" style="margin-top:14px">' + CHECKS.map(ck => checkCard(m, ck, by[ck.kind] || { status: 'pending' })).join('') + '</div></div>' : '') +
    (notices.length ? '<div class="card"><h3>Agency notices</h3><table class="t" style="margin-top:8px"><thead><tr><th>Agency</th><th>Sent</th><th>Objection</th></tr></thead><tbody>' + notices.map(x => '<tr><td>' + esc(x.agency) + '</td><td>' + esc(fmtDate(x.created_at)) + '</td><td>' + (x.objection && !x.withdrawn_at ? '<span class="tag t-bad">Open</span> ' + esc(x.objection_note || '') : x.withdrawn_at ? '<span class="tag t-ok">Withdrawn</span>' : '<span class="note">None</span>') + '</td></tr>').join('') + '</tbody></table></div>' : '') +
    '<div class="card"><h3>Activity</h3><ul style="list-style:none;padding:0;margin:10px 0 0;display:grid;gap:6px">' + (events.map(e => '<li><b>' + esc(e.action.replace(/_/g, ' ')) + '</b> <span class="note">' + esc(e.detail || '') + ', ' + esc(fmtDate(e.at)) + '</span></li>').join('') || '<li class="note">None</li>') + '</ul></div>' +
    '</div>';
  bindDetail(m);
}
function statusActions(m) {
  const b = [];
  if (m.status === 'approved' || m.status === 'pending') b.push('<button class="btn soft small" type="button" data-st="suspended">Suspend</button>');
  if (m.status === 'pending') b.push('<button class="btn soft small" type="button" data-st="rejected">Send back for changes</button>');
  if (m.status === 'suspended') b.push('<button class="btn small" type="button" data-st="approved">Reinstate</button>');
  return b.length ? '<div class="row" style="margin-top:12px">' + b.join('') + '</div><div id="stForm" hidden style="margin-top:10px"><label class="f" for="stReason">Reason (sent to the company)</label><textarea class="input" id="stReason"></textarea><p class="err" id="stErr" role="alert"></p><button class="btn small" type="button" id="stGo">Confirm</button></div>' : '';
}
function checkCard(m, ck, x) {
  const st = x.status || 'pending', editable = !m.is_demo && (m.status === 'pending' || m.status === 'suspended');
  const links = (LINKS[ck.kind] || []).map(([l, u]) => '<a class="btn soft small" href="' + u + '" target="_blank" rel="noopener">' + esc(l) + '</a>').join('');
  return '<div class="check"><span class="ic ' + st + '" aria-hidden="true">' + (st === 'passed' ? '✓' : st === 'failed' ? '✕' : '…') + '</span><div>' +
    '<h3>' + esc(ck.title) + '</h3><p class="note">' + esc(GUIDE[ck.kind]) + '</p>' +
    (x.note ? '<p style="margin-top:6px;font-size:15px"><b>Recorded: </b>' + esc(x.note) + (x.checked_at ? ' <span class="note">(' + esc(fmtDate(x.checked_at)) + ')</span>' : '') + '</p>' : '') +
    (x.evidence_path ? '<button class="btn soft small" type="button" data-open="' + esc(x.evidence_path) + '" style="margin-top:6px">Open evidence</button>' : '') +
    (editable ? '<div class="row" style="margin-top:10px">' + links +
      (ck.kind === 'email' || ck.kind === 'courier' ? '<button class="btn soft small" type="button" data-code="' + ck.kind + '">' + (ck.kind === 'email' ? 'Resend email code' : 'Generate courier code') + '</button>' : '') +
      (ck.kind === 'phone' && m.public_phone ? '<a class="btn soft small" href="tel:' + esc(m.public_phone.replace(/[^\d+]/g, '')) + '">Number on form: ' + esc(m.public_phone) + '</a>' : '') +
      '</div><div id="codeOut_' + ck.kind + '"></div>' +
      '<label class="f" for="note_' + ck.kind + '">How was this confirmed?</label><input class="input" id="note_' + ck.kind + '" placeholder="e.g. Greenbook: A4-1234 listed under this company, active">' +
      '<div class="row" style="margin-top:8px"><label class="btn soft small">Attach evidence<input class="sr" type="file" accept="application/pdf,image/*" data-ev="' + ck.kind + '"></label><span class="note" id="evName_' + ck.kind + '"></span></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn small" type="button" data-set="passed" data-k="' + ck.kind + '">Passed</button><button class="btn danger small" type="button" data-set="failed" data-k="' + ck.kind + '">Failed</button>' + (st !== 'pending' ? '<button class="btn soft small" type="button" data-set="pending" data-k="' + ck.kind + '">Reset</button>' : '') + '</div>' : '') +
    '</div><span class="tag ' + (st === 'passed' ? 't-ok' : st === 'failed' ? 't-bad' : 't-info') + '">' + (st === 'passed' ? 'Passed' : st === 'failed' ? 'Failed' : 'Waiting') + '</span></div>';
}
const evidence = {};
function bindDetail(m) {
  const col = $('detailCol');
  col.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', async () => {
    const r = await sb.storage.from('mfr-docs').createSignedUrl(b.dataset.open, 300);
    if (r.error) return toast(errText(r.error));
    const a = document.createElement('a'); a.href = r.data.signedUrl; a.target = '_blank'; a.rel = 'noopener'; a.click();
  }));
  col.querySelectorAll('[data-ev]').forEach(inp => inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const path = m.id + '/evidence/' + inp.dataset.ev + '-' + Date.now() + '-' + f.name.replace(/[^\w.\-]+/g, '_').slice(-60);
    toast('Uploading…');
    const up = await sb.storage.from('mfr-docs').upload(path, f, { contentType: f.type || undefined });
    if (up.error) return toast(errText(up.error));
    evidence[inp.dataset.ev] = path; $('evName_' + inp.dataset.ev).textContent = f.name; toast('Evidence attached');
  }));
  col.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', async () => {
    const k = b.dataset.k, s = b.dataset.set, note = $('note_' + k).value.trim();
    if (s === 'failed' && !note) return toast('Explain what failed. The company will see it.');
    b.disabled = true;
    const r = await sb.rpc('admin_set_check', { p_mid: m.id, p_kind: k, p_status: s, p_note: note, p_evidence: evidence[k] || null });
    b.disabled = false;
    if (r.error) return toast(errText(r.error));
    delete evidence[k];
    toast(r.data ? 'All checks passed. Approved automatically.' : 'Saved');
    if (r.data) { filter = 'approved'; }
    renderApps();
  }));
  col.querySelectorAll('[data-code]').forEach(b => b.addEventListener('click', async () => {
    const k = b.dataset.code;
    const r = await sb.rpc('admin_issue_code', { p_mid: m.id, p_kind: k });
    if (r.error) return toast(errText(r.error));
    const code = r.data;
    $('codeOut_' + k).innerHTML = k === 'email'
      ? '<p style="margin-top:10px">Code <b style="font-family:monospace;font-size:20px;letter-spacing:.1em">' + esc(code) + '</b> is queued in the Outbox to ' + esc(m.official_email) + '. Any earlier code no longer works.</p>'
      : '<p style="margin-top:10px">Courier code <b style="font-family:monospace;font-size:20px;letter-spacing:.1em">' + esc(code) + '</b>. It is shown only once. Any earlier code no longer works.</p><button class="btn soft small" type="button" id="printLetter">Print courier letter</button>';
    const pl = $('printLetter'); if (pl) pl.addEventListener('click', () => printLetter(m, code));
  }));
  const form = $('stForm'); let target = null;
  col.querySelectorAll('[data-st]').forEach(b => b.addEventListener('click', () => {
    target = b.dataset.st;
    if (target === 'approved') return setStatus(m, 'approved', '');
    form.hidden = false; $('stReason').focus();
  }));
  const go = $('stGo'); if (go) go.addEventListener('click', () => setStatus(m, target, $('stReason').value.trim()));
}
async function setStatus(m, s, reason) {
  const r = await sb.rpc('admin_set_status', { p_mid: m.id, p_status: s, p_reason: reason });
  if (r.error) { const e = $('stErr'); if (e) e.textContent = errText(r.error); else toast(errText(r.error)); return; }
  toast('Status updated. Message queued in the Outbox.'); filter = s; renderApps();
}
function printLetter(m, code) {
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to print the letter');
  w.document.write('<!DOCTYPE html><title>CheckAm courier letter</title><body style="font:16px/1.6 Georgia,serif;max-width:640px;margin:40px auto;padding:0 20px">' +
    '<p>' + esc(fmtDate(new Date())) + '</p><p><b>' + esc(m.legal_name) + '</b><br>' + esc(m.factory_address) + '<br>' + esc([m.city, m.state].filter(Boolean).join(', ')) + '</p>' +
    '<p>Attention: ' + esc(m.contact_name || 'Head of Quality') + '</p><h2 style="font-family:Arial,sans-serif">CheckAm address verification</h2>' +
    '<p>Your company has applied to be a verified manufacturer on CheckAm, the free app that helps Nigerians check medicine packs. To confirm this address, please sign in to the CheckAm partner portal and enter this code:</p>' +
    '<p style="font:700 32px/1 monospace;letter-spacing:.15em;border:2px solid #000;display:inline-block;padding:12px 20px">' + esc(code) + '</p>' +
    '<p>Partner portal: ' + esc(SITE) + '/partner.html</p><p>If your company did not apply, please ignore this letter and contact NAFDAC.</p><p>CheckAm</p></body>');
  w.document.close(); w.focus(); w.print();
}

/* ---------- outbox ---------- */
async function renderOutbox() {
  const b = $('tabBody'); b.innerHTML = '<p class="sub">Loading…</p>';
  const r = await sb.from('outbox').select('*').order('created_at', { ascending: false }).limit(100);
  if (r.error) { b.innerHTML = '<p class="err">' + esc(errText(r.error)) + '</p>'; return; }
  const rows = r.data || [], unsent = rows.filter(x => !x.sent_at), sent = rows.filter(x => x.sent_at);
  const card = x => {
    const body = (x.body || '').replace(/\{\{SITE\}\}/g, SITE);
    const mail = x.to_email ? 'mailto:' + encodeURIComponent(x.to_email) + '?subject=' + encodeURIComponent(x.subject || '') + '&body=' + encodeURIComponent(body) : '';
    return '<div class="card"><div class="row" style="justify-content:space-between"><div><b>' + esc(x.subject) + '</b><p class="note">To ' + esc(x.to_label || '') + ': ' + (x.to_email ? esc(x.to_email) : '<span style="color:var(--hib-ink)">no email yet. Add it in Settings.</span>') + ', ' + esc(fmtDate(x.created_at)) + '</p></div>' + (x.sent_at ? '<span class="tag t-ok">Sent</span>' : '<span class="tag t-warn">To send</span>') + '</div>' +
      '<pre class="mail">' + esc(body) + '</pre>' +
      (x.sent_at ? '' : '<div class="row" style="margin-top:10px">' + (mail ? '<a class="btn small" href="' + esc(mail) + '">Open in email app</a>' : '') + '<button class="btn soft small" type="button" data-copy="' + esc(x.id) + '">Copy text</button><button class="btn soft small" type="button" data-sent="' + esc(x.id) + '">Mark as sent</button></div>') + '</div>';
  };
  b.innerHTML = '<div class="banner warn" style="margin-bottom:14px"><p><b>Messages are sent by hand for now.</b> Once getcheckam.com has an email address, CheckAm will send these automatically.</p></div>' +
    '<h3 style="margin-bottom:10px">To send (' + unsent.length + ')</h3><div class="stack">' + (unsent.map(card).join('') || '<p class="note">Nothing to send.</p>') + '</div>' +
    (sent.length ? '<details style="margin-top:20px"><summary><b>Sent (' + sent.length + ')</b></summary><div class="stack" style="margin-top:10px">' + sent.map(card).join('') + '</div></details>' : '');
  b.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
    const x = rows.find(y => y.id === btn.dataset.copy);
    try { await navigator.clipboard.writeText('To: ' + (x.to_email || '') + '\nSubject: ' + x.subject + '\n\n' + x.body.replace(/\{\{SITE\}\}/g, SITE)); toast('Copied'); } catch (e) { toast('Copy not allowed here'); }
  }));
  b.querySelectorAll('[data-sent]').forEach(btn => btn.addEventListener('click', async () => {
    const r2 = await sb.rpc('admin_mark_sent', { p_id: btn.dataset.sent }); if (r2.error) return toast(errText(r2.error));
    toast('Marked as sent'); renderOutbox();
  }));
}

/* ---------- settings ---------- */
async function renderSettings() {
  const b = $('tabBody'); b.innerHTML = '<p class="sub">Loading…</p>';
  const [ag, ad] = await Promise.all([sb.from('agency_contacts').select('*').order('agency'), sb.from('admins').select('*').order('created_at')]);
  const agencies = ag.data || [], admins = ad.data || [];
  b.innerHTML = '<div class="grid2"><section class="card"><h3>Agency contacts</h3><p class="note" style="margin-top:4px">Where approval notices and objection links are sent. Use the official addresses published on each agency\'s website.</p>' +
    agencies.map(a => '<div style="margin-top:14px"><b>' + esc(a.agency) + '</b><label class="f" for="ae_' + a.agency + '">Email</label><input class="input" id="ae_' + a.agency + '" type="email" value="' + esc(a.email || '') + '"><label class="f" for="ap_' + a.agency + '">Phone</label><input class="input" id="ap_' + a.agency + '" value="' + esc(a.phone || '') + '"><button class="btn soft small" type="button" data-ag="' + a.agency + '" style="margin-top:8px">Save ' + esc(a.agency) + '</button></div>').join('') +
    '</section><section class="card"><h3>Admins</h3><table class="t" style="margin-top:8px"><tbody>' + admins.map(a => '<tr><td>' + esc(a.name || '—') + '</td><td>' + esc(a.role) + '</td><td class="note">' + esc(fmtDate(a.created_at)) + '</td></tr>').join('') + '</tbody></table>' +
    (me.role === 'owner' ? '<h3 style="margin-top:18px">Add an admin</h3><p class="note">They must create an account on the partner page first.</p><label class="f" for="nn">Name</label><input class="input" id="nn"><label class="f" for="ne">Their account email</label><input class="input" id="ne" type="email"><label class="f" for="nr">Role</label><select class="input" id="nr"><option value="reviewer">Reviewer: checks applications</option><option value="owner">Owner: also manages admins</option></select><p class="err" id="naErr" role="alert"></p><button class="btn small" type="button" id="naGo">Add admin</button>' : '') +
    '</section></div>';
  b.querySelectorAll('[data-ag]').forEach(btn => btn.addEventListener('click', async () => {
    const a = btn.dataset.ag;
    const r = await sb.rpc('admin_set_agency', { p_agency: a, p_email: $('ae_' + a).value, p_phone: $('ap_' + a).value });
    toast(r.error ? errText(r.error) : a + ' saved');
  }));
  const go = $('naGo'); if (go) go.addEventListener('click', async () => {
    const r = await sb.rpc('admin_add', { p_email: $('ne').value, p_role: $('nr').value, p_name: $('nn').value });
    if (r.error) return ($('naErr').textContent = errText(r.error));
    toast('Admin added'); renderSettings();
  });
}
})();
