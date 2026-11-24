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
let batches = [];
async function renderBatches(demo, demoData) {
  const card = $('batchCard'); if (!card) return;
  const prods = (demo ? demoData.products : products).filter(p => p.gtin);
  if (demo) batches = demoData.batches || [];
  else { const r = await sb.rpc('my_batches'); batches = (r.data || []); if (r.error) toast(errText(r.error)); }
  const tot = batches.reduce((a, b) => ({ s: a.s + (+b.serials || 0), sc: a.sc + (+b.scanned || 0), c: a.c + (+b.copies || 0) }), { s: 0, sc: 0, c: 0 });
  card.innerHTML = '<div class="row" style="justify-content:space-between"><div><h3>Batches and serial numbers</h3><p class="sub" style="margin-top:4px">Add each batch you release, then upload its serial numbers. Buyers who scan a pack on your list see <b>Genuine</b>. Unknown serials are flagged as likely fake.</p></div>' +
      (demo ? '<span class="tag t-warn">Example data</span>' : '') + '</div>' +
    '<div class="row" style="margin-top:12px"><button class="btn" type="button" id="impOpen">Import serial numbers from a file</button><span class="note">Excel or CSV export. Batches are created for you.</span></div>' +
    '<div class="kpis"><div class="kpi"><b>' + batches.length + '</b><span>batches</span></div><div class="kpi"><b>' + tot.s.toLocaleString() + '</b><span>serial numbers</span></div><div class="kpi"><b>' + tot.sc.toLocaleString() + '</b><span>packs scanned by buyers</span></div><div class="kpi"><b>' + tot.c.toLocaleString() + '</b><span>possible copied codes</span></div></div>' +
    (batches.length ? '<div class="scroll"><table class="t"><thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th>Serials</th><th>Scanned</th><th>Possible copies</th><th></th></tr></thead><tbody>' +
      batches.map(b => '<tr><td>' + esc(b.product) + (b.strength ? ' <span class="note">' + esc(b.strength) + '</span>' : '') + '</td><td><b>' + esc(b.lot) + '</b>' + (b.recalled ? ' <span class="tag t-bad">Recalled</span>' : '') + '</td><td>' + esc(fmtDate(b.exp_date)) + '</td><td>' + (+b.serials).toLocaleString() + (b.quantity && +b.serials <= +b.quantity ? ' <span class="note">of ' + (+b.quantity).toLocaleString() + '</span>' : '') + '</td><td>' + (+b.scanned).toLocaleString() + '</td><td>' + ((+b.copies) ? '<span class="tag t-bad">' + b.copies + '</span>' : '0') + '</td>' +
        '<td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn soft small" type="button" data-upl="' + esc(b.id) + '">Upload serials</button>' + (demo ? '' : '<button class="btn soft small" type="button" data-rec="' + esc(b.id) + '">' + (b.recalled ? 'Undo recall' : 'Recall') + '</button><button class="btn soft small" type="button" data-delb="' + esc(b.id) + '">Delete</button>') + '</div></td></tr>').join('') +
      '</tbody></table></div>' : '<p class="note" style="margin:10px 0">No batches yet. Add your first one below.</p>') +
    '<details style="margin-top:16px"><summary><b>Add a batch by hand</b></summary>' +
      (prods.length ? '<div class="grid3"><div><label class="f" for="bProd">Product</label><select class="input" id="bProd">' + prods.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name + (p.strength ? ' ' + p.strength : '')) + '</option>').join('') + '</select></div>' +
        '<div><label class="f" for="bLot">Batch number</label><input class="input" id="bLot" placeholder="as printed on the pack"></div><div><label class="f" for="bQty">Quantity <small>(packs)</small></label><input class="input" id="bQty" inputmode="numeric"></div></div>' +
        '<div class="grid3"><div><label class="f" for="bMfg">Manufactured</label><input class="input" id="bMfg" type="date"></div><div><label class="f" for="bExp">Expiry</label><input class="input" id="bExp" type="date"></div></div>' +
        '<p class="err" id="bErr" role="alert"></p><button class="btn" id="bAdd" type="button">' + (demo ? 'Add batch (demo, not saved)' : 'Add batch') + '</button>'
        : '<p class="note" style="margin-top:8px">None of your products has a product number (GTIN) yet. Contact CheckAm to add it.</p>') +
    '</details>' +
    '';
  if (!$('upBox')) card.insertAdjacentHTML('afterend', '<div id="upBox"></div>');
  card.querySelectorAll('[data-upl]').forEach(b => b.addEventListener('click', () => openImporter(demo, demoData, batches.find(x => x.id === b.dataset.upl))));
  $('impOpen').addEventListener('click', () => openImporter(demo, demoData, null));
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
/* ---------- smart serial importer ----------
   Accepts the file a serialisation system exports (Excel, CSV or text), finds the columns,
   groups rows by product and batch, creates missing batches, then uploads. */
const SERIAL_OK = /^[!-~]{1,20}$/;
const COLS = [['', 'Not used'], ['serial', 'Serial number'], ['gtin', 'Product number (GTIN)'], ['lot', 'Batch / lot'], ['exp', 'Expiry date'], ['gs1', 'Full GS1 code (01…21…)']];
const HDR = [
  ['gs1', /gs1|data ?matrix|2d ?code|element|full ?code|ai ?string/i],
  ['gtin', /gtin|ean|barcode|product ?(code|number|no)|^pc$|item ?code|ndc/i],
  ['lot', /batch|^lot|lot ?(no|num)/i],
  ['exp', /exp|expir|use ?by|best ?before/i],
  ['serial', /serial|^s\/?n$|^sn$|unique/i]
];
const gtinOk = g => { if (!/^\d{14}$/.test(g)) return false; const d = g.split('').map(Number), l = d.pop(); let s = 0; d.reverse().forEach((n, i) => { s += n * (i % 2 === 0 ? 3 : 1); }); return (10 - s % 10) % 10 === l; };
function toISODate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/))) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{4})$/))) { const d = new Date(+m[2], +m[1], 0); return m[2] + '-' + m[1].padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  if ((m = s.match(/^(\d{4})[\/.\-](\d{1,2})$/))) { const d = new Date(+m[1], +m[2], 0); return m[1] + '-' + m[2].padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  if ((m = s.match(/^(\d{2})(\d{2})(\d{2})$/))) { const y = 2000 + +m[1], mo = +m[2]; let d = +m[3]; if (mo < 1 || mo > 12) return null; if (!d) d = new Date(y, mo, 0).getDate(); return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  const t = Date.parse(s); return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}
function splitCSV(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const first = lines[0], delim = ['\t', ';', ',', '|'].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0];
  const d = delim[1] > 1 ? delim[0] : null;
  return lines.map(line => {
    if (!d) return [line.trim()];
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === d && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    out.push(cur.trim()); return out;
  });
}
let xlsxLoading = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!xlsxLoading) xlsxLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('Could not load the Excel reader. Check your connection, or save the file as CSV.')); document.head.appendChild(s); });
  return xlsxLoading;
}
async function readRows(file) {
  const name = (file.name || '').toLowerCase();
  if (/\.(xlsx|xlsm|xls|ods)$/.test(name)) {
    const X = await loadXLSX();
    const wb = X.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return X.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).map(r => r.map(c => (c instanceof Date ? c : String(c).trim())))
      .filter(r => r.some(c => c !== ''));
  }
  return splitCSV(await file.text());
}
function guessColumns(rows) {
  const width = Math.max(...rows.slice(0, 50).map(r => r.length));
  const head = rows[0] || [];
  const map = new Array(width).fill(''); let hasHeader = false;
  head.forEach((h, i) => { if (h instanceof Date) return; const t = String(h || ''); for (const [k, re] of HDR) if (re.test(t) && !map.includes(k)) { map[i] = k; hasHeader = true; break; } });
  if (!hasHeader && head.length && head.every(h => typeof h === 'string' && /[a-z]{3,}/i.test(h) && !/\d{4,}/.test(h))) hasHeader = true;
  const body = rows.slice(hasHeader ? 1 : 0, 400);
  const colVals = i => body.map(r => r[i]).filter(v => v !== '' && v != null);
  const looksGS1 = v => /^\(01\)\d{14}|^(\]d2)?01\d{14}.*21|\u001d/.test(String(v));
  // Content beats headers for full GS1 codes (a column called "Code" often holds them).
  for (let i = 0; i < width; i++) { const vals = colVals(i); if (vals.length && vals.filter(looksGS1).length / vals.length > .6) { map.forEach((x, j) => { if (x === 'gs1') map[j] = ''; }); map[i] = 'gs1'; break; } }
  if (!map.includes('gs1') || !map.includes('serial')) {
    for (let i = 0; i < width; i++) {
      if (map[i]) continue;
      const vals = body.map(r => r[i]).filter(v => v !== '' && v != null);
      if (!vals.length) continue;
      const share = f => vals.filter(f).length / vals.length;
      const uniq = new Set(vals.map(String)).size / vals.length;
      if (!map.includes('gs1') && share(v => /^\(01\)\d{14}|^(\]d2)?01\d{14}.*21|\u001d/.test(String(v))) > .6) map[i] = 'gs1';
      else if (!map.includes('gtin') && share(v => gtinOk(String(v).replace(/\D/g, '').padStart(14, '0')) && /^\d{8,14}$/.test(String(v))) > .8) map[i] = 'gtin';
      else if (!map.includes('exp') && share(v => !!toISODate(v) && !/^\d{7,}$/.test(String(v))) > .8) map[i] = 'exp';
      else if (!map.includes('lot') && vals.length >= 2 && uniq <= .5 && share(v => /^[A-Z0-9][A-Z0-9\-\/.]{1,19}$/i.test(String(v)) && !/^\d{8,14}$/.test(String(v))) > .9) map[i] = 'lot';
    }
    if (!map.includes('serial') && !map.includes('gs1')) {
      let best = -1, bestU = 0;
      for (let i = 0; i < width; i++) { if (map[i]) continue; const vals = body.map(r => r[i]).filter(v => v !== ''); const u = vals.length ? new Set(vals.map(String)).size / vals.length : 0; if (u > bestU) { bestU = u; best = i; } }
      if (best >= 0) map[best] = 'serial';
    }
  }
  return { map, hasHeader, width };
}
function buildRecords(rows, cfg, target) {
  const body = rows.slice(cfg.hasHeader ? 1 : 0), idx = k => cfg.map.indexOf(k);
  const iS = idx('serial'), iG = idx('gtin'), iL = idx('lot'), iE = idx('exp'), iC = idx('gs1');
  const recs = []; let bad = 0;
  for (const r of body) {
    let serial = iS >= 0 ? String(r[iS] ?? '').trim() : '', gtin = iG >= 0 ? String(r[iG] ?? '').replace(/\D/g, '') : '', lot = iL >= 0 ? String(r[iL] ?? '').trim() : '', exp = iE >= 0 ? toISODate(r[iE]) : null;
    if (iC >= 0 && r[iC]) { const f = parseGS1(String(r[iC])); serial = serial || f['21'] || ''; gtin = gtin || f['01'] || ''; lot = lot || f['10'] || ''; exp = exp || toISODate(f['17']); }
    if (gtin) gtin = gtin.padStart(14, '0');
    if (target) { gtin = gtin || target.gtin; lot = lot || target.lot; }
    if (!SERIAL_OK.test(serial)) { bad++; continue; }
    recs.push({ serial, gtin, lot, exp });
  }
  return { recs, bad };
}
function planImport(recs, prods, existing) {
  const groups = new Map(), seen = new Set(); let dup = 0;
  for (const x of recs) {
    const k = x.gtin + '|' + x.lot.toUpperCase();
    if (seen.has(k + '|' + x.serial)) { dup++; continue; } seen.add(k + '|' + x.serial);
    if (!groups.has(k)) groups.set(k, { gtin: x.gtin, lot: x.lot, exps: {}, serials: [] });
    const g = groups.get(k); g.serials.push(x.serial); if (x.exp) g.exps[x.exp] = (g.exps[x.exp] || 0) + 1;
  }
  const plan = [], skipped = [];
  for (const g of groups.values()) {
    const p = prods.find(q => q.gtin === g.gtin);
    if (!g.gtin || !p) { skipped.push({ reason: g.gtin ? 'Product number ' + g.gtin + ' is not one of your products' : 'No product number', count: g.serials.length }); continue; }
    if (!g.lot) { skipped.push({ reason: 'No batch number for ' + p.name, count: g.serials.length }); continue; }
    const b = existing.find(x => (x.product_id ? x.product_id === p.id : x.gtin === p.gtin) && String(x.lot).toUpperCase() === g.lot.toUpperCase());
    const exp = Object.entries(g.exps).sort((a, c) => c[1] - a[1])[0];
    plan.push({ product: p, lot: g.lot, batch: b || null, exp: b ? b.exp_date : (exp ? exp[0] : ''), serials: g.serials });
  }
  return { plan, skipped, dup };
}
function downloadTemplate(prods) {
  const p = prods[0] || { gtin: '06151234567891' };
  const rows = ['GTIN,Batch,Expiry,Serial'].concat(Array.from({ length: 5 }, (_, i) => p.gtin + ',LOT001,2028-12-31,SN' + String(i + 1).padStart(6, '0')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
  a.download = 'checkam-serials-template.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function openImporter(demo, demoData, target) {
  const box = $('upBox');
  const prods = (demo ? demoData.products : products).filter(p => p.gtin);
  let rows = null, cfg = null, built = null, planned = null;
  box.innerHTML = '<div class="uploader" id="imp"><div class="row" style="justify-content:space-between"><h3>' + (target ? 'Upload serial numbers for batch ' + esc(target.lot) : 'Import serial numbers') + '</h3><button class="btn soft small" type="button" id="impClose">Close</button></div>' +
    '<div id="impStep"></div></div>';
  $('impClose').addEventListener('click', () => { box.innerHTML = ''; });
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const step = $('impStep');

  function stepPick() {
    step.innerHTML = '<p class="sub" style="margin-top:6px">Use the file your serialisation or packaging system exports: <b>Excel or CSV</b>, one row per pack. CheckAm finds the serial number, product number, batch and expiry columns itself' + (target ? '' : ', and creates any batch that does not exist yet') + '.</p>' +
      '<label class="drop" id="impDrop" for="impFile" style="margin-top:12px"><b>Drop the file here, or tap to choose</b><span class="note">Excel (.xlsx, .xls), CSV or text. Any size up to 20 MB.</span><input class="sr" type="file" id="impFile"></label>' +
      '<details style="margin-top:12px"><summary>Or paste serial numbers</summary><textarea class="input" id="impText" rows="6" style="margin-top:8px" placeholder="One per line, or copy columns straight from Excel"></textarea><button class="btn soft small" type="button" id="impPasteGo" style="margin-top:8px">Use pasted text</button></details>' +
      '<div class="row" style="margin-top:12px"><button class="btn soft small" type="button" id="impTpl">Download an example file</button>' + (demo ? '<button class="btn soft small" type="button" id="impSample">Try with an example file</button>' : '') + '</div>' +
      '<p class="err" id="impErr" role="alert"></p>';
    const take = async file => {
      $('impErr').textContent = '';
      if (file.size > 20 * 1024 * 1024) { $('impErr').textContent = 'That file is larger than 20 MB. Split it into parts.'; return; }
      try { $('impDrop').querySelector('b').textContent = 'Reading ' + file.name + '…'; rows = await readRows(file); }
      catch (e) { $('impErr').textContent = errText(e); $('impDrop').querySelector('b').textContent = 'Drop the file here, or tap to choose'; return; }
      if (!rows.length) { $('impErr').textContent = 'That file looks empty.'; return; }
      cfg = guessColumns(rows); stepReview();
    };
    $('impFile').addEventListener('change', ev => { const f = ev.target.files && ev.target.files[0]; if (f) take(f); });
    const drop = $('impDrop');
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, ev => { ev.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', ev => { const f = ev.dataTransfer.files && ev.dataTransfer.files[0]; if (f) take(f); });
    $('impPasteGo').addEventListener('click', () => { const t = $('impText').value; if (!t.trim()) return; rows = splitCSV(t); cfg = guessColumns(rows); stepReview(); });
    $('impTpl').addEventListener('click', () => downloadTemplate(prods));
    const smp = $('impSample'); if (smp) smp.addEventListener('click', () => {
      const p1 = prods[0], p2 = prods[1] || prods[0], e1 = '2029-01-31', e2 = '2028-07-31';
      rows = [['Product code', 'Batch No.', 'Exp. Date', 'Serial No.']]
        .concat(Array.from({ length: 30 }, (_, i) => [p1.gtin, 'DQ2601', e1, 'DEMO' + String(301 + i).padStart(4, '0')]))
        .concat(Array.from({ length: 20 }, (_, i) => [p2.gtin, 'NEW2611', e2, 'NX' + String(i + 1).padStart(5, '0')]));
      cfg = guessColumns(rows); stepReview();
    });
  }

  function stepReview() {
    built = buildRecords(rows, cfg, target);
    planned = planImport(built.recs, prods, batches);
    const prev = rows.slice(0, (cfg.hasHeader ? 1 : 0) + 4);
    const total = planned.plan.reduce((a, g) => a + g.serials.length, 0);
    const needExp = planned.plan.filter(g => !g.batch && !g.exp);
    step.innerHTML =
      '<h3 style="margin-top:12px;font-size:17px">1. Check the columns</h3><p class="note">We guessed what each column holds. Change any that are wrong.</p>' +
      '<div class="scroll" style="margin-top:8px"><table class="t"><thead><tr>' + Array.from({ length: cfg.width }, (_, i) => '<th><select class="input" style="min-height:38px;font-size:14px;padding:4px 8px" data-col="' + i + '">' + COLS.map(([k, l]) => '<option value="' + k + '"' + (cfg.map[i] === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></th>').join('') + '</tr></thead><tbody>' +
        prev.map((r, ri) => '<tr' + (ri === 0 && cfg.hasHeader ? ' class="note"' : '') + '>' + Array.from({ length: cfg.width }, (_, i) => '<td>' + esc(r[i] instanceof Date ? toISODate(r[i]) : r[i] ?? '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' +
      '<label class="row" style="gap:8px;margin-top:8px;font-size:15px"><input type="checkbox" id="impHdr"' + (cfg.hasHeader ? ' checked' : '') + ' style="width:20px;height:20px"> The first row is a header</label>' +
      '<h3 style="margin-top:18px;font-size:17px">2. What will be uploaded</h3>' +
      (planned.plan.length ? '<div class="scroll"><table class="t" style="margin-top:8px"><thead><tr><th>Product</th><th>Batch</th><th>Expiry</th><th>Serial numbers</th><th></th></tr></thead><tbody>' +
        planned.plan.map((g, i) => '<tr><td>' + esc(g.product.name) + '</td><td><b>' + esc(g.lot) + '</b></td><td>' + (g.batch ? esc(fmtDate(g.batch.exp_date)) : '<input class="input" type="date" data-exp="' + i + '" value="' + esc(g.exp) + '" style="min-height:38px;max-width:170px">') + '</td><td>' + g.serials.length.toLocaleString() + '</td><td>' + (g.batch ? '<span class="tag t-info">Existing batch</span>' : '<span class="tag t-ok">New batch, created for you</span>') + '</td></tr>').join('') +
        '</tbody></table></div>' : '<p class="err">No serial numbers could be matched to your products. Check the columns above' + (prods.length ? '' : ', and that your products have product numbers') + '.</p>') +
      (planned.skipped.length || built.bad || planned.dup ? '<ul class="note" style="margin:8px 0 0;padding-left:18px">' + planned.skipped.map(s => '<li>' + s.count.toLocaleString() + ' skipped: ' + esc(s.reason) + '</li>').join('') + (built.bad ? '<li>' + built.bad.toLocaleString() + ' rows skipped: no valid serial number (up to 20 characters, no spaces)</li>' : '') + (planned.dup ? '<li>' + planned.dup.toLocaleString() + ' duplicate rows skipped</li>' : '') + '</ul>' : '') +
      (needExp.length ? '<p class="note" style="margin-top:8px">Add the expiry date for the new batches above.</p>' : '') +
      '<div class="progress" id="impProg" hidden style="margin:14px 0 6px"><i style="width:0"></i></div><p class="err" id="impErr" role="alert"></p>' +
      '<div class="row" style="margin-top:12px"><button class="btn" id="impGo" type="button"' + (total ? '' : ' disabled') + '>' + (demo ? 'Upload ' + total.toLocaleString() + ' (demo, not saved)' : 'Upload ' + total.toLocaleString() + ' serial numbers') + '</button><button class="btn soft" id="impBack" type="button">Choose another file</button></div>';
    step.querySelectorAll('[data-col]').forEach(sel => sel.addEventListener('change', () => {
      const i = +sel.dataset.col, v = sel.value;
      if (v) cfg.map = cfg.map.map((x, j) => (x === v && j !== i ? '' : x));
      cfg.map[i] = v; stepReview();
    }));
    $('impHdr').addEventListener('change', () => { cfg.hasHeader = $('impHdr').checked; stepReview(); });
    step.querySelectorAll('[data-exp]').forEach(inp => inp.addEventListener('change', () => { planned.plan[+inp.dataset.exp].exp = inp.value; }));
    $('impBack').addEventListener('click', stepPick);
    $('impGo').addEventListener('click', runImport);
  }

  async function runImport() {
    const missing = planned.plan.find(g => !g.batch && !g.exp);
    if (missing) { $('impErr').textContent = 'Add the expiry date for batch ' + missing.lot + '.'; return; }
    const go = $('impGo'), bar = $('impProg'); go.disabled = true; $('impBack').disabled = true; bar.hidden = false; $('impErr').textContent = '';
    const total = planned.plan.reduce((a, g) => a + g.serials.length, 0); let done = 0, added = 0, created = 0;
    try {
      for (const g of planned.plan) {
        let batchId = g.batch && g.batch.id;
        if (!batchId) {
          if (demo) { batchId = 'demo-' + Math.random().toString(36).slice(2); batches.unshift({ id: batchId, product: g.product.name, strength: g.product.strength, gtin: g.product.gtin, product_id: g.product.id, lot: g.lot, exp_date: g.exp, serials: 0, scanned: 0, copies: 0 }); }
          else {
            const r = await sb.from('mfr_batches').insert({ manufacturer_id: mfr.id, product_id: g.product.id, lot: g.lot, exp_date: g.exp }).select('id').single();
            if (r.error) throw r.error; batchId = r.data.id;
          }
          created++;
        }
        for (let i = 0; i < g.serials.length; i += 2000) {
          const chunk = g.serials.slice(i, i + 2000);
          if (demo) { await new Promise(r => setTimeout(r, 250)); added += chunk.length; const b = batches.find(x => x.id === batchId); if (b) b.serials = (+b.serials || 0) + chunk.length; }
          else { const r = await sb.rpc('add_serials', { p_batch: batchId, p_serials: chunk }); if (r.error) throw r.error; added += r.data || 0; }
          done += chunk.length; bar.firstChild.style.width = (done / total * 100) + '%'; go.textContent = 'Uploading… ' + done.toLocaleString() + ' of ' + total.toLocaleString();
        }
      }
      const msg = added.toLocaleString() + ' serial numbers added' + (created ? ', ' + created + ' new batch' + (created > 1 ? 'es' : '') + ' created' : '') + (added < total && !demo ? '. ' + (total - added).toLocaleString() + ' were already on your list.' : '.');
      toast(demo ? msg + ' (demo, not saved)' : msg);
      box.innerHTML = '<div class="banner ok" style="margin-top:0"><h3 style="color:#fff">Import complete</h3><p>' + esc(msg) + (demo ? ' This was a demo, nothing was saved.' : ' Buyers who scan these packs now see Genuine.') + '</p></div>';
      if (demo) renderBatches(true, Object.assign(window.__demoData || demoData, { batches })); else renderBatches(false);
    } catch (e) {
      $('impErr').textContent = errText(e) + ' (' + done.toLocaleString() + ' uploaded before the problem; running the import again safely skips those)';
      go.disabled = false; $('impBack').disabled = false; go.textContent = 'Try again';
    }
  }
  stepPick();
}

})();
