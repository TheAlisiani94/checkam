/* CheckAm partner portal: manufacturer sign-up, application, documents and verification status. */
(() => {
'use strict';
const { $, esc, fmtDate, STATES, CHECKS, DOCS, statusTag, toast, sb, publicRpc, errText, renderChecks, progress, parseGS1 } = window.CK;
const MCOLS = 'id,owner,status,kind,legal_name,trading_name,rc_number,gs1_prefix,factory_address,city,state,website,official_email,public_phone,contact_name,contact_role,contact_phone,foreign_manufacturer,foreign_country,status_reason,created_at,submitted_at,approved_at';
const EDITABLE = ['kind', 'legal_name', 'trading_name', 'rc_number', 'gs1_prefix', 'factory_address', 'city', 'state', 'website', 'official_email', 'public_phone', 'contact_name', 'contact_role', 'contact_phone', 'foreign_manufacturer', 'foreign_country'];
const STEPS = [['company', 'Company'], ['contact', 'Contact'], ['products', 'Products'], ['documents', 'Documents'], ['submit', 'Review and submit']];
let session = null, mfr = null, products = [], docs = [], checks = [], events = [], step = 'company';
const view = $('view');
const SVG_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#0b6b45"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

if (!sb) { view.innerHTML = '<div class="card"><h2>Not connected</h2><p class="sub" style="margin-top:8px">The partner portal needs the CheckAm database. Check config.js.</p></div>'; return; }

/* ---------- header ---------- */
function renderWho() {
  $('who').innerHTML = session
    ? '<span class="note">' + esc(session.user.email) + '</span><button class="btn soft small" id="outBtn" type="button">Sign out</button>'
    : '<a class="btn soft small" href="#demo">See the demo</a>';
  const o = $('outBtn'); if (o) o.addEventListener('click', async () => { await sb.auth.signOut(); location.hash = ''; });
}

/* ---------- routing ---------- */
async function route() {
  renderWho();
  if (location.hash === '#demo') return renderDemo();
  if (!session) return renderWelcome();
  try { await loadMine(); } catch (e) { view.innerHTML = '<div class="card"><h2>Could not load your account</h2><p class="err">' + esc(errText(e)) + '</p></div>'; return; }
  if (!mfr || mfr.status === 'draft' || mfr.status === 'rejected') renderApplication(); else renderStatus();
}
addEventListener('hashchange', route);
sb.auth.onAuthStateChange((_e, s) => { const changed = (s && s.user && s.user.id) !== (session && session.user && session.user.id); session = s; if (changed) route(); });
sb.auth.getSession().then(({ data }) => { session = data.session; route(); });

async function loadMine() {
  const uid = session.user.id;
  const r = await sb.from('manufacturers').select(MCOLS).eq('owner', uid).maybeSingle();
  if (r.error) throw r.error;
  mfr = r.data; products = []; docs = []; checks = []; events = [];
  if (!mfr) return;
  const [p, d, c, a] = await Promise.all([
    sb.from('mfr_products').select('*').eq('manufacturer_id', mfr.id).order('created_at'),
    sb.from('mfr_documents').select('*').eq('manufacturer_id', mfr.id).order('uploaded_at'),
    sb.from('mfr_checks').select('*').eq('manufacturer_id', mfr.id),
    sb.from('audit_log').select('action,detail,at').eq('manufacturer_id', mfr.id).order('at', { ascending: false }).limit(30)
  ]);
  products = p.data || []; docs = d.data || []; checks = c.data || []; events = (a.data || []).filter(x => x.action !== 'code_wrong');
}

/* ---------- welcome & sign in ---------- */
function renderWelcome() {
  view.innerHTML =
    '<section class="hero"><div class="stack">' +
      '<h1>Prove your medicines are genuine. Free.</h1>' +
      '<p class="sub" style="font-size:18px">When a buyer scans one of your packs with CheckAm, they see <b>Genuine, confirmed by the manufacturer</b>. When someone reports a suspicious pack of yours, you get the details privately, with the shop and town, so you can act.</p>' +
      '<ul class="benefits">' +
        ['Free for verified manufacturers and importers', 'Uses the GS1 codes you already print for NAFDAC traceability. No new labels.', 'Private reports about suspected fakes of your products', 'Your company is checked against NAFDAC, PCN, CAC and GS1 records, so nobody can pretend to be you', 'Upload batches and serial numbers so each genuine pack can be confirmed'].map(t => '<li>' + SVG_OK + '<span>' + esc(t) + '</span></li>').join('') +
      '</ul>' +
      '<div class="row"><button class="btn" type="button" id="goUp">Create a partner account</button><button class="btn soft" type="button" id="goIn">Sign in</button><a class="btn soft" href="#demo">See the demo dashboard</a></div>' +
    '</div><div class="art" aria-label="The 8 verification checks">' +
      '<h3 style="color:#fff">How we verify every company</h3>' +
      CHECKS.map((c, i) => '<div class="line"><b>' + (i + 1) + '</b>' + esc(c.title) + '</div>').join('') +
      '<p style="opacity:.9;font-size:15px">When all ' + CHECKS.length + ' pass, approval is automatic. NAFDAC and PCN are informed and can object at any time.</p>' +
    '</div></section>' +
    '';
  $('goUp').addEventListener('click', () => renderAuth('up'));
  $('goIn').addEventListener('click', () => renderAuth('in'));
}
const dlg = $('authDlg');
$('authX').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); });
function renderAuth(mode) {
  $('authBody').innerHTML = '<h2 id="authH">' + (mode === 'up' ? 'Create a partner account' : 'Sign in') + '</h2>' +
    (mode === 'up' ? '<p class="sub" style="margin-top:6px">Any email works for your login. You will give your official company email in the application, and we verify it there.</p>' : '') +
    '<form id="authForm" novalidate>' +
      '<label class="f" for="aEmail">Email</label><input class="input" id="aEmail" type="email" autocomplete="email" required>' +
      '<label class="f" for="aPass">Password <small>(at least 10 characters)</small></label><input class="input" id="aPass" type="password" autocomplete="' + (mode === 'up' ? 'new-password' : 'current-password') + '" required>' +
      '<p class="err" id="aErr" role="alert"></p>' +
      '<div class="stack" style="gap:10px"><button class="btn" id="aGo" type="submit">' + (mode === 'up' ? 'Create account' : 'Sign in') + '</button>' +
      '<button class="btn soft" type="button" id="aSwap">' + (mode === 'up' ? 'I already have an account' : 'Create an account instead') + '</button></div>' +
    '</form>';
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('aEmail').focus(), 50);
  $('aSwap').addEventListener('click', () => renderAuth(mode === 'up' ? 'in' : 'up'));
  $('authForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('aEmail').value.trim(), password = $('aPass').value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('aErr').textContent = 'Enter a valid email.'; return; }
    if (password.length < 10) { $('aErr').textContent = 'Use at least 10 characters for the password.'; return; }
    const btn = $('aGo'); btn.disabled = true; btn.textContent = 'Please wait…';
    const r = mode === 'up' ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
    btn.disabled = false; btn.textContent = mode === 'up' ? 'Create account' : 'Sign in';
    if (r.error) { $('aErr').textContent = errText(r.error); return; }
    if (mode === 'up' && !r.data.session) { $('authBody').innerHTML = '<h2 id="authH">Check your email</h2><p class="sub" style="margin-top:8px">We sent a link to ' + esc(email) + '. Open it to confirm your account, then sign in.</p>'; return; }
    dlg.close();
  });
}

/* ---------- application (draft / needs changes) ---------- */
const val = k => (mfr && mfr[k]) || '';
const field = (k, label, opt = {}) => '<label class="f" for="f_' + k + '">' + esc(label) + (opt.hint ? ' <small>' + esc(opt.hint) + '</small>' : '') + '</label>' +
  (opt.select ? '<select class="input" id="f_' + k + '">' + opt.select + '</select>'
    : '<input class="input" id="f_' + k + '" type="' + (opt.type || 'text') + '" value="' + esc(val(k)) + '"' + (opt.ph ? ' placeholder="' + esc(opt.ph) + '"' : '') + (opt.ac ? ' autocomplete="' + opt.ac + '"' : '') + '>');

function stepDone(s) {
  if (!mfr) return false;
  if (s === 'company') return !!(mfr.legal_name && mfr.rc_number && mfr.gs1_prefix && mfr.factory_address && mfr.state);
  if (s === 'contact') return !!(mfr.official_email && mfr.public_phone && mfr.contact_name);
  if (s === 'products') return products.some(p => p.nafdac_no);
  if (s === 'documents') return ['cac', 'nafdac', 'pcn', 'gs1'].every(k => docs.some(d => d.kind === k));
  return false;
}
function renderApplication() {
  const rej = mfr && mfr.status === 'rejected';
  view.innerHTML =
    (rej ? '<div class="banner bad" style="margin-bottom:16px"><h3>Your application needs changes</h3><p>' + esc(mfr.status_reason || 'Please review the notes below, update your application and submit it again.') + '</p></div>' : '') +
    '<div class="row" style="justify-content:space-between;margin-bottom:14px"><div><h2>Your application</h2><p class="sub">Fill in each section. Your progress is saved as you go.</p></div>' + (mfr ? statusTag(mfr.status) : statusTag('draft')) + '</div>' +
    '<nav class="steps-nav" aria-label="Application sections">' + STEPS.map(([k, l]) => '<button type="button" data-step="' + k + '"' + (k === step ? ' aria-current="step"' : '') + '>' + esc(l) + (k !== 'submit' ? '<span class="dot' + (stepDone(k) ? ' done' : '') + '" aria-label="' + (stepDone(k) ? 'complete' : 'incomplete') + '"></span>' : '') + '</button>').join('') + '</nav>' +
    '<section class="card" id="stepBody"></section>';
  view.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => { step = b.dataset.step; renderApplication(); }));
  ({ company: stepCompany, contact: stepContact, products: stepProducts, documents: stepDocuments, submit: stepSubmit })[step]();
}
async function saveFields(keys) {
  const patch = {}; keys.forEach(k => { const el = $('f_' + k); if (el) patch[k] = el.value.trim(); });
  if (!mfr) {
    const r = await sb.from('manufacturers').insert(Object.assign({ owner: session.user.id }, patch)).select(MCOLS).single();
    if (r.error) throw r.error; mfr = r.data;
  } else {
    patch.updated_at = new Date().toISOString();
    const r = await sb.from('manufacturers').update(patch).eq('id', mfr.id).select(MCOLS).single();
    if (r.error) throw r.error; mfr = r.data;
  }
}
function saveBar(next) { return '<p class="err" id="sErr" role="alert"></p><div class="row"><button class="btn" id="sGo" type="button">Save and continue</button></div>'; }
function bindSave(keys, next, validate) {
  $('sGo').addEventListener('click', async () => {
    const msg = validate ? validate() : ''; if (msg) { $('sErr').textContent = msg; return; }
    const b = $('sGo'); b.disabled = true; b.textContent = 'Saving…';
    try { await saveFields(keys); toast('Saved'); step = next; renderApplication(); }
    catch (e) { $('sErr').textContent = errText(e); b.disabled = false; b.textContent = 'Save and continue'; }
  });
}
function stepCompany() {
  const kind = val('kind') || 'manufacturer';
  $('stepBody').innerHTML = '<h3>Company details</h3><p class="sub" style="margin-top:4px">Use exactly the details on your CAC and NAFDAC records. We compare them.</p>' +
    '<label class="f" for="f_kind">You are</label><select class="input" id="f_kind"><option value="manufacturer"' + (kind === 'manufacturer' ? ' selected' : '') + '>A manufacturer in Nigeria</option><option value="importer"' + (kind === 'importer' ? ' selected' : '') + '>An importer holding NAFDAC registrations for a foreign manufacturer</option></select>' +
    '<div class="grid2"><div>' + field('legal_name', 'Company legal name', { hint: 'as on CAC', ac: 'organization' }) + '</div><div>' + field('trading_name', 'Trading or brand name', { hint: 'optional' }) + '</div></div>' +
    '<div class="grid2"><div>' + field('rc_number', 'CAC RC number', { ph: 'e.g. RC 123456' }) + '</div><div>' + field('gs1_prefix', 'GS1 company prefix', { ph: 'e.g. 6151234', hint: 'from your GS1 certificate' }) + '</div></div>' +
    field('factory_address', 'Factory or warehouse address', { hint: 'the address on your NAFDAC and PCN records', ac: 'street-address' }) +
    '<div class="grid2"><div>' + field('city', 'Town or city') + '</div><div>' + field('state', 'State', { select: '<option value="">Choose a state</option>' + STATES.map(s => '<option' + (s === val('state') ? ' selected' : '') + '>' + s + '</option>').join('') }) + '</div></div>' +
    field('website', 'Company website', { type: 'url', ph: 'https://', hint: 'must match your email domain' }) +
    '<div id="impBox"' + (kind === 'importer' ? '' : ' hidden') + '><div class="grid2"><div>' + field('foreign_manufacturer', 'Foreign manufacturer') + '</div><div>' + field('foreign_country', 'Country of manufacture') + '</div></div><p class="note">Upload the foreign manufacturer\'s letter authorising you, under Documents.</p></div>' +
    saveBar();
  $('f_kind').addEventListener('change', () => { $('impBox').hidden = $('f_kind').value !== 'importer'; });
  bindSave(['kind', 'legal_name', 'trading_name', 'rc_number', 'gs1_prefix', 'factory_address', 'city', 'state', 'website', 'foreign_manufacturer', 'foreign_country'], 'contact', () => {
    if (!$('f_legal_name').value.trim()) return 'Enter the company legal name.';
    if (!$('f_rc_number').value.trim()) return 'Enter the CAC RC number.';
    if (!/^\d{6,12}$/.test($('f_gs1_prefix').value.trim())) return 'The GS1 company prefix should be 6 to 12 digits.';
    if (!$('f_factory_address').value.trim() || !$('f_state').value) return 'Enter the factory address and state.';
    return '';
  });
}
function stepContact() {
  $('stepBody').innerHTML = '<h3>Contact and authority</h3><p class="sub" style="margin-top:4px">We will send a code to the official email, and call the public phone number to confirm.</p>' +
    '<div class="grid2"><div>' + field('official_email', 'Official company email', { type: 'email', ph: 'quality@yourcompany.com', ac: 'email' }) + '</div><div>' + field('public_phone', 'Company phone number', { type: 'tel', hint: 'as listed publicly', ac: 'tel' }) + '</div></div>' +
    '<div class="grid2"><div>' + field('contact_name', 'Person managing this account', { ac: 'name' }) + '</div><div>' + field('contact_role', 'Their role', { ph: 'e.g. Head of Quality' }) + '</div></div>' +
    field('contact_phone', 'Their direct phone', { type: 'tel' }) + saveBar();
  bindSave(['official_email', 'public_phone', 'contact_name', 'contact_role', 'contact_phone'], 'products', () => {
    const e = $('f_official_email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Enter the official company email.';
    if (/@(gmail|yahoo|hotmail|outlook|icloud|aol)\./i.test(e)) return 'Use an email on your company\'s own domain.';
    if (!$('f_public_phone').value.trim() || !$('f_contact_name').value.trim()) return 'Enter the company phone and the contact person.';
    return '';
  });
}
function stepProducts() {
  if (!mfr) { step = 'company'; return renderApplication(); }
  $('stepBody').innerHTML = '<h3>Products</h3><p class="sub" style="margin-top:4px">List the products you want CheckAm to confirm. Each needs its NAFDAC registration number.</p>' +
    (products.length ? '<div class="scroll" style="margin-top:12px"><table class="t"><thead><tr><th>Product</th><th>Strength</th><th>Form</th><th>Pack</th><th>Product number (GTIN)</th><th>NAFDAC no.</th><th>Expires</th><th></th></tr></thead><tbody>' +
      products.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.strength) + '</td><td>' + esc(p.dosage_form) + '</td><td>' + esc(p.pack_size) + '</td><td>' + esc(p.gtin) + '</td><td>' + esc(p.nafdac_no) + '</td><td>' + esc(fmtDate(p.nafdac_expiry)) + '</td><td><button class="btn soft small" type="button" data-del="' + esc(p.id) + '">Remove</button></td></tr>').join('') +
      '</tbody></table></div>' : '<p class="note" style="margin:12px 0">No products yet.</p>') +
    '<h3 style="margin-top:20px">Add a product</h3>' +
    '<div class="grid3"><div><label class="f" for="pName">Product name</label><input class="input" id="pName"></div><div><label class="f" for="pStr">Strength</label><input class="input" id="pStr" placeholder="e.g. 500 mg"></div><div><label class="f" for="pForm">Form</label><input class="input" id="pForm" placeholder="e.g. Tablet"></div></div>' +
    '<div class="grid3"><div><label class="f" for="pPack">Pack size</label><input class="input" id="pPack" placeholder="e.g. 2 x 10"></div><div><label class="f" for="pGtin">Product number (GTIN)</label><input class="input" id="pGtin" inputmode="numeric" placeholder="14 digits"></div><div><label class="f" for="pNaf">NAFDAC no.</label><input class="input" id="pNaf" placeholder="e.g. A4-1234"></div></div>' +
    '<div class="grid3"><div><label class="f" for="pExp">NAFDAC certificate expires</label><input class="input" id="pExp" type="date"></div></div>' +
    '<p class="err" id="pErr" role="alert"></p><div class="row"><button class="btn soft" id="pAdd" type="button">Add product</button><button class="btn" id="pNext" type="button">Continue to documents</button></div>';
  view.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const r = await sb.from('mfr_products').delete().eq('id', b.dataset.del); if (r.error) return toast(errText(r.error));
    products = products.filter(p => p.id !== b.dataset.del); renderApplication();
  }));
  $('pAdd').addEventListener('click', async () => {
    const g = $('pGtin').value.replace(/\D/g, '');
    const row = { manufacturer_id: mfr.id, name: $('pName').value.trim(), strength: $('pStr').value.trim(), dosage_form: $('pForm').value.trim(), pack_size: $('pPack').value.trim(), gtin: g ? g.padStart(14, '0') : null, nafdac_no: $('pNaf').value.trim().toUpperCase(), nafdac_expiry: $('pExp').value || null };
    if (!row.name || !row.nafdac_no) { $('pErr').textContent = 'Enter at least the product name and NAFDAC number.'; return; }
    if (g && g.length < 8) { $('pErr').textContent = 'The product number (GTIN) should have 8 to 14 digits.'; return; }
    if (g && mfr.gs1_prefix && !row.gtin.slice(1).startsWith(mfr.gs1_prefix) && !row.gtin.startsWith(mfr.gs1_prefix)) { $('pErr').textContent = 'This product number does not start with your GS1 company prefix (' + mfr.gs1_prefix + ').'; return; }
    const r = await sb.from('mfr_products').insert(row).select('*').single();
    if (r.error) { $('pErr').textContent = errText(r.error); return; }
    products.push(r.data); toast('Product added'); renderApplication();
  });
  $('pNext').addEventListener('click', () => { step = 'documents'; renderApplication(); });
}
function stepDocuments() {
  if (!mfr) { step = 'company'; return renderApplication(); }
  $('stepBody').innerHTML = '<h3>Documents</h3><p class="sub" style="margin-top:4px">PDF or photo, up to 10 MB each. Only CheckAm reviewers can see them.</p><div class="stack" style="margin-top:14px">' +
    DOCS.map(d => {
      const mine = docs.filter(x => x.kind === d.kind);
      return '<div><b>' + esc(d.title) + '</b>' + (mine.length ? ' <span class="tag t-ok">Uploaded</span>' : (d.kind === 'other' ? '' : ' <span class="tag t-warn">Needed</span>')) +
        '<div class="stack" style="gap:6px;margin-top:8px">' + mine.map(x => '<div class="doc"><span>' + esc(x.file_name || 'File') + '</span><button class="btn soft small" type="button" data-rm="' + esc(x.id) + '">Remove</button></div>').join('') + '</div>' +
        ((!mine.length || d.many) ? '<label class="btn soft small" style="margin-top:8px">Upload file<input class="sr" type="file" accept="application/pdf,image/*" data-up="' + d.kind + '"></label>' : '') + '</div>';
    }).join('') + '</div><div class="row" style="margin-top:18px"><button class="btn" id="dNext" type="button">Continue to review</button></div>';
  view.querySelectorAll('[data-up]').forEach(inp => inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    if (f.size > 10 * 1024 * 1024) return toast('That file is larger than 10 MB');
    const safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-80);
    const path = mfr.id + '/' + inp.dataset.up + '/' + Date.now() + '-' + safe;
    toast('Uploading…');
    const up = await sb.storage.from('mfr-docs').upload(path, f, { upsert: false, contentType: f.type || undefined });
    if (up.error) return toast(errText(up.error));
    const r = await sb.from('mfr_documents').insert({ manufacturer_id: mfr.id, kind: inp.dataset.up, path, file_name: f.name.slice(0, 120) }).select('*').single();
    if (r.error) return toast(errText(r.error));
    docs.push(r.data); toast('Uploaded'); renderApplication();
  }));
  view.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
    const d = docs.find(x => x.id === b.dataset.rm); if (!d) return;
    await sb.storage.from('mfr-docs').remove([d.path]);
    const r = await sb.from('mfr_documents').delete().eq('id', d.id); if (r.error) return toast(errText(r.error));
    docs = docs.filter(x => x.id !== d.id); renderApplication();
  }));
  $('dNext').addEventListener('click', () => { step = 'submit'; renderApplication(); });
}
function stepSubmit() {
  const items = [
    ['Company details', stepDone('company'), 'company'], ['Contact details', stepDone('contact'), 'contact'],
    ['At least one product with a NAFDAC number', stepDone('products'), 'products'],
    ...['cac', 'nafdac', 'pcn', 'gs1'].map(k => [DOCS.find(d => d.kind === k).title, docs.some(d => d.kind === k), 'documents'])
  ];
  const ready = items.every(i => i[1]);
  $('stepBody').innerHTML = '<h3>Review and submit</h3><p class="sub" style="margin-top:4px">Once submitted, your application is locked while we verify it. You can follow every check on your dashboard.</p>' +
    '<ul style="list-style:none;padding:0;margin:16px 0;display:grid;gap:8px">' + items.map(([t, ok, s]) => '<li class="row" style="gap:10px"><span class="tag ' + (ok ? 't-ok' : 't-warn') + '">' + (ok ? 'Done' : 'Missing') + '</span>' + esc(t) + (ok ? '' : ' <button class="btn soft small" type="button" data-go="' + s + '">Fix</button>') + '</li>').join('') + '</ul>' +
    '<label class="row" style="gap:10px;align-items:flex-start;margin:10px 0"><input type="checkbox" id="decl" style="width:22px;height:22px;margin-top:2px"><span>I confirm the information and documents are true, and that I am authorised to act for this company. I understand CheckAm will inform NAFDAC and PCN when the company is approved.</span></label>' +
    '<p class="err" id="subErr" role="alert"></p><button class="btn" id="subGo" type="button"' + (ready ? '' : ' disabled') + '>Submit for verification</button>';
  view.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { step = b.dataset.go; renderApplication(); }));
  $('subGo').addEventListener('click', async () => {
    if (!$('decl').checked) { $('subErr').textContent = 'Tick the box to confirm.'; return; }
    const b = $('subGo'); b.disabled = true; b.textContent = 'Submitting…';
    const r = await sb.rpc('submit_application');
    if (r.error) { $('subErr').textContent = errText(r.error); b.disabled = false; b.textContent = 'Submit for verification'; return; }
    toast('Submitted'); await loadMine(); renderStatus();
  });
}

/* ---------- status dashboard ---------- */
function statusBanner(m) {
  if (m.status === 'approved') return '<div class="banner ok"><h2 style="color:#fff">' + esc(m.legal_name) + ' is verified</h2><p>Approved on ' + esc(fmtDate(m.approved_at)) + '. NAFDAC and PCN have been informed.</p></div>';
  if (m.status === 'suspended') return '<div class="banner bad"><h3>Your approval is paused</h3><p>' + esc(m.status_reason || '') + '</p><p class="note">Your products will not show as Genuine until this is resolved. If an agency objected, contact that agency; approval returns automatically when they withdraw the objection.</p></div>';
  return '<div class="banner warn"><h3>Verification in progress</h3><p>We are checking your company against public records. You will see each check change here. Your email code has been sent to your official email; the courier code arrives at your factory address. Enter them below.</p></div>';
}
function codeExtra(kind, x, demo) {
  if (demo || !mfr || mfr.status !== 'pending' || x.status === 'passed' || (kind !== 'email' && kind !== 'courier')) return '';
  return '<div class="code-box" style="margin-top:10px"><label class="sr" for="code_' + kind + '">Code</label><input class="input" id="code_' + kind + '" autocomplete="one-time-code" maxlength="12" placeholder="Code"><button class="btn small" type="button" data-code="' + kind + '">Confirm code</button></div>';
}
function renderStatus(demoData) {
  const demo = !!demoData, m = demo ? demoData.company : mfr, cks = demo ? demoData.checks : checks, prods = demo ? demoData.products : products, evs = demo ? demoData.events : events;
  view.innerHTML =
    (demo ? '<div class="banner demo" style="margin-bottom:16px"><h3>Demo dashboard</h3><p>This is an example company to show what a verified manufacturer sees. It is not a real business. <a href="#" id="demoUp">Create your own account</a>.</p></div>' : '') +
    '<div class="row" style="justify-content:space-between;margin-bottom:14px"><div><h2>' + esc(m.legal_name || 'Your company') + '</h2><p class="sub">' + esc([m.city, m.state].filter(Boolean).join(', ')) + (m.rc_number ? ' · ' + esc(m.rc_number) : '') + '</p></div>' + statusTag(m.status) + '</div>' +
    '<div class="stack">' + statusBanner(m) +
    '<section class="card">' + progress(cks) + '<div style="margin-top:16px">' + renderChecks(cks, { how: !demo, extra: (k, x) => codeExtra(k, x, demo) }) + '</div></section>' +
    (m.status === 'approved' ? '<section class="card" id="batchCard"></section>' : '') + '<div class="grid2"><section class="card"><h3>Your products</h3><div class="scroll" style="margin-top:10px"><table class="t"><thead><tr><th>Product</th><th>NAFDAC no.</th><th>GTIN</th></tr></thead><tbody>' +
      prods.map(p => '<tr><td>' + esc(p.name) + (p.strength ? ' <span class="note">' + esc(p.strength) + '</span>' : '') + '</td><td>' + esc(p.nafdac_no) + '</td><td>' + esc(p.gtin || '—') + '</td></tr>').join('') +
    '</tbody></table></div>' + '' + '</section>' +
    '<section class="card"><h3>Activity</h3><ul style="list-style:none;padding:0;margin:10px 0 0;display:grid;gap:8px">' +
      (evs.length ? evs.map(e => '<li><b>' + esc(e.action.replace(/_/g, ' ')) + '</b>' + (e.detail ? ' <span class="note">' + esc(e.detail) + '</span>' : '') + '<br><span class="note">' + esc(fmtDate(e.at)) + '</span></li>').join('') : '<li class="note">No activity yet.</li>') +
    '</ul></section></div></div>';
  const du = $('demoUp'); if (du) du.addEventListener('click', ev => { ev.preventDefault(); history.replaceState(null, '', location.pathname); route().then(() => { if (!session) renderAuth('up'); }); });
  if (m.status === 'approved') renderBatches(demo, demoData);
  view.querySelectorAll('[data-code]').forEach(b => b.addEventListener('click', async () => {
    const k = b.dataset.code, code = $('code_' + k).value.trim();
    if (code.length < 6) return toast('Enter the full code');
    b.disabled = true;
    const r = await sb.rpc('enter_code', { p_kind: k, p_code: code });
    b.disabled = false;
    if (r.error) return toast(errText(r.error));
    if (!r.data) return toast('That code is not right. Check it and try again.');
    toast('Code confirmed'); await loadMine(); route();
  }));
}
async function renderDemo() {
  view.innerHTML = '<p class="sub">Loading the demo…</p>';
  try { const d = await publicRpc('demo_portal'); if (!d) throw new Error('Demo not available'); window.__demoData = d; renderStatus(d); }
  catch (e) { view.innerHTML = '<div class="card"><h2>Demo not available</h2><p class="err">' + esc(errText(e)) + '</p></div>'; }
}

/* ---------- batches and serial numbers ---------- */
let batches = [], upTarget = null;
const SERIAL_OK = /^[!-~]{1,20}$/;
function parseSerials(text, gtin, lot) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let col = 0, start = 0;
  if (lines.length) {
    const head = lines[0].split(/[,;\t]/).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    const i = head.findIndex(h => /^(serial|serial number|serial_number|sn)$/.test(h));
    if (i >= 0) { col = i; start = 1; } else if (head.some(h => /[a-z]{4,}/.test(h) && !SERIAL_OK.test(h))) start = 1;
  }
  const good = new Set(); let bad = 0, wrong = 0, dup = 0;
  for (let k = start; k < lines.length; k++) {
    const line = lines[k]; let v;
    if (/^\(01\)|^\]d2|\u001d/.test(line)) {
      const f = parseGS1(line);
      if (gtin && f['01'] && f['01'] !== gtin) { wrong++; continue; }
      if (lot && f['10'] && f['10'].toUpperCase() !== lot.toUpperCase()) { wrong++; continue; }
      v = f['21'] || '';
    } else v = (line.split(/[,;\t]/)[col] || '').trim().replace(/^"|"$/g, '');
    if (!SERIAL_OK.test(v)) { bad++; continue; }
    if (good.has(v)) { dup++; continue; } good.add(v);
  }
  return { serials: [...good], bad, wrong, dup };
}
function downloadTemplate(lot) {
  const rows = ['serial'].concat(Array.from({ length: 5 }, (_, i) => (lot || 'LOT') + '-' + String(i + 1).padStart(5, '0')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
  a.download = 'checkam-serials-template.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function renderBatches(demo, demoData) {
  const card = $('batchCard'); if (!card) return;
  const prods = (demo ? demoData.products : products).filter(p => p.gtin);
  if (demo) batches = demoData.batches || [];
  else { const r = await sb.rpc('my_batches'); batches = (r.data || []); if (r.error) toast(errText(r.error)); }
  const tot = batches.reduce((a, b) => ({ s: a.s + (+b.serials || 0), sc: a.sc + (+b.scanned || 0), c: a.c + (+b.copies || 0) }), { s: 0, sc: 0, c: 0 });
  card.innerHTML = '<div class="row" style="justify-content:space-between"><div><h3>Batches and serial numbers</h3><p class="sub" style="margin-top:4px">Add each batch you release, then upload its serial numbers. Buyers who scan a pack on your list see <b>Genuine</b>. Unknown serials are flagged as likely fake.</p></div>' +
      (demo ? '<span class="tag t-warn">Example data</span>' : '') + '</div>' +
    '<div class="kpis"><div class="kpi"><b>' + batches.length + '</b><span>batches</span></div><div class="kpi"><b>' + tot.s.toLocaleString() + '</b><span>serial numbers</span></div><div class="kpi"><b>' + tot.sc.toLocaleString() + '</b><span>packs scanned by buyers</span></div><div class="kpi"><b>' + tot.c.toLocaleString() + '</b><span>possible copied codes</span></div></div>' +
    (batches.length ? '<div class="scroll"><table class="t"><thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th>Serials</th><th>Scanned</th><th>Possible copies</th><th></th></tr></thead><tbody>' +
      batches.map(b => '<tr><td>' + esc(b.product) + (b.strength ? ' <span class="note">' + esc(b.strength) + '</span>' : '') + '</td><td><b>' + esc(b.lot) + '</b>' + (b.recalled ? ' <span class="tag t-bad">Recalled</span>' : '') + '</td><td>' + esc(fmtDate(b.exp_date)) + '</td><td>' + (+b.serials).toLocaleString() + (b.quantity ? ' <span class="note">of ' + (+b.quantity).toLocaleString() + '</span>' : '') + '</td><td>' + (+b.scanned).toLocaleString() + '</td><td>' + ((+b.copies) ? '<span class="tag t-bad">' + b.copies + '</span>' : '0') + '</td>' +
        '<td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn soft small" type="button" data-upl="' + esc(b.id) + '">Upload serials</button>' + (demo ? '' : '<button class="btn soft small" type="button" data-rec="' + esc(b.id) + '">' + (b.recalled ? 'Undo recall' : 'Recall') + '</button><button class="btn soft small" type="button" data-delb="' + esc(b.id) + '">Delete</button>') + '</div></td></tr>').join('') +
      '</tbody></table></div>' : '<p class="note" style="margin:10px 0">No batches yet. Add your first one below.</p>') +
    '<details style="margin-top:16px"' + (batches.length ? '' : ' open') + '><summary><b>Add a batch</b></summary>' +
      (prods.length ? '<div class="grid3"><div><label class="f" for="bProd">Product</label><select class="input" id="bProd">' + prods.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name + (p.strength ? ' ' + p.strength : '')) + '</option>').join('') + '</select></div>' +
        '<div><label class="f" for="bLot">Batch number</label><input class="input" id="bLot" placeholder="as printed on the pack"></div><div><label class="f" for="bQty">Quantity <small>(packs)</small></label><input class="input" id="bQty" inputmode="numeric"></div></div>' +
        '<div class="grid3"><div><label class="f" for="bMfg">Manufactured</label><input class="input" id="bMfg" type="date"></div><div><label class="f" for="bExp">Expiry</label><input class="input" id="bExp" type="date"></div></div>' +
        '<p class="err" id="bErr" role="alert"></p><button class="btn" id="bAdd" type="button">' + (demo ? 'Add batch (demo, not saved)' : 'Add batch') + '</button>'
        : '<p class="note" style="margin-top:8px">None of your products has a product number (GTIN) yet. Contact CheckAm to add it.</p>') +
    '</details>' +
    '<div id="upBox"></div>';
  card.querySelectorAll('[data-upl]').forEach(b => b.addEventListener('click', () => openUploader(demo, batches.find(x => x.id === b.dataset.upl))));
  card.querySelectorAll('[data-rec]').forEach(b => b.addEventListener('click', async () => {
    const x = batches.find(y => y.id === b.dataset.rec);
    const r = await sb.from('mfr_batches').update({ recalled: !x.recalled, recall_note: x.recalled ? null : 'Recalled by the manufacturer' }).eq('id', x.id);
    if (r.error) return toast(errText(r.error));
    toast(x.recalled ? 'Recall removed' : 'Batch recalled. Buyers who scan it are told not to use it.'); renderBatches(false);
  }));
  card.querySelectorAll('[data-delb]').forEach(b => b.addEventListener('click', async () => {
    const x = batches.find(y => y.id === b.dataset.delb);
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirm delete'; b.classList.add('danger'); return; }
    const r = await sb.from('mfr_batches').delete().eq('id', x.id);
    if (r.error) return toast(errText(r.error));
    toast('Batch ' + x.lot + ' deleted with its serial numbers'); renderBatches(false);
  }));
  const add = $('bAdd'); if (add) add.addEventListener('click', async () => {
    const lot = $('bLot').value.trim(), exp = $('bExp').value;
    if (!lot || !exp) { $('bErr').textContent = 'Enter the batch number and expiry date.'; return; }
    if (demo) {
      const p = prods.find(x => x.id === $('bProd').value);
      batches.unshift({ id: 'demo-' + Date.now(), product: p.name, strength: p.strength, gtin: p.gtin, lot, exp_date: exp, quantity: +$('bQty').value || null, serials: 0, scanned: 0, copies: 0 });
      demoData.batches = batches; toast('Demo batch added (not saved)'); return renderBatches(true, demoData);
    }
    const r = await sb.from('mfr_batches').insert({ manufacturer_id: mfr.id, product_id: $('bProd').value, lot, exp_date: exp, mfg_date: $('bMfg').value || null, quantity: +$('bQty').value || null });
    if (r.error) { $('bErr').textContent = /duplicate|unique/i.test(errText(r.error)) ? 'This batch number already exists for that product.' : errText(r.error); return; }
    toast('Batch added. Now upload its serial numbers.'); renderBatches(false);
  });
}
function openUploader(demo, b) {
  upTarget = b;
  const box = $('upBox');
  box.innerHTML = '<div class="uploader"><div class="row" style="justify-content:space-between"><h3>Upload serial numbers for batch ' + esc(b.lot) + '</h3><button class="btn soft small" type="button" id="upClose">Close</button></div>' +
    '<p class="sub" style="margin-top:6px">Use a CSV or text file with one serial number per line (a column named <b>serial</b> is fine), or paste them below. Full GS1 codes such as (01)…(10)…(21)… also work. Up to 20 characters each.</p>' +
    '<div class="row" style="margin-top:12px"><label class="btn soft small">Choose file<input class="sr" type="file" id="upFile" accept=".csv,.txt,text/csv,text/plain"></label><button class="btn soft small" type="button" id="upTpl">Download a template</button>' + (demo ? '<button class="btn soft small" type="button" id="upSample">Use example serials</button>' : '') + '</div>' +
    '<label class="f" for="upText">Or paste serial numbers</label><textarea class="input" id="upText" rows="6" placeholder="ABC0000001&#10;ABC0000002&#10;ABC0000003"></textarea>' +
    '<p class="note" id="upPreview" style="margin-top:8px"></p><div class="progress" id="upProg" hidden style="margin:10px 0"><i style="width:0"></i></div>' +
    '<p class="err" id="upErr" role="alert"></p><button class="btn" id="upGo" type="button" disabled>Upload</button></div>';
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let parsed = { serials: [] };
  const preview = () => {
    parsed = parseSerials($('upText').value, b.gtin, b.lot);
    $('upPreview').textContent = parsed.serials.length.toLocaleString() + ' serial numbers ready' + (parsed.dup ? ', ' + parsed.dup + ' duplicates skipped' : '') + (parsed.bad ? ', ' + parsed.bad + ' lines not valid' : '') + (parsed.wrong ? ', ' + parsed.wrong + ' codes from another product or batch skipped' : '') + '.';
    $('upGo').disabled = !parsed.serials.length;
    $('upGo').textContent = demo ? 'Upload ' + parsed.serials.length.toLocaleString() + ' (demo, not saved)' : 'Upload ' + parsed.serials.length.toLocaleString() + ' serial numbers';
  };
  $('upClose').addEventListener('click', () => { box.innerHTML = ''; });
  $('upTpl').addEventListener('click', () => downloadTemplate(b.lot));
  const smp = $('upSample'); if (smp) smp.addEventListener('click', () => { $('upText').value = 'serial\n' + Array.from({ length: 25 }, (_, i) => 'DEMO' + String(201 + i).padStart(4, '0')).join('\n'); preview(); });
  $('upText').addEventListener('input', preview);
  $('upFile').addEventListener('change', async ev => {
    const f = ev.target.files && ev.target.files[0]; if (!f) return;
    if (f.size > 20 * 1024 * 1024) return toast('That file is larger than 20 MB. Split it into parts.');
    $('upText').value = await f.text(); preview();
  });
  $('upGo').addEventListener('click', async () => {
    const list = parsed.serials; if (!list.length) return;
    const go = $('upGo'), bar = $('upProg'); go.disabled = true; bar.hidden = false; $('upErr').textContent = '';
    let done = 0, added = 0;
    try {
      for (let i = 0; i < list.length; i += 2000) {
        const chunk = list.slice(i, i + 2000);
        if (demo) await new Promise(r => setTimeout(r, 350)); else { const r = await sb.rpc('add_serials', { p_batch: b.id, p_serials: chunk }); if (r.error) throw r.error; added += r.data || 0; }
        done += chunk.length; bar.firstChild.style.width = (done / list.length * 100) + '%'; go.textContent = 'Uploading… ' + done.toLocaleString() + ' of ' + list.length.toLocaleString();
      }
      if (demo) { b.serials = (+b.serials || 0) + list.length; toast(list.length + ' serial numbers uploaded (demo). In your account these packs would now scan as Genuine.'); renderBatches(true, Object.assign(window.__demoData || {}, { batches })); return; }
      toast(added.toLocaleString() + ' new serial numbers added' + (added < list.length ? ' (' + (list.length - added) + ' were already on your list)' : ''));
      renderBatches(false);
    } catch (e) { $('upErr').textContent = errText(e) + ' (' + done.toLocaleString() + ' uploaded before the error)'; go.disabled = false; go.textContent = 'Try again'; }
  });
}
})();
