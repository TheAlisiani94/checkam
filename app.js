/* CheckAm — medicine pack checker. Plain JavaScript, no build step. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- storage (safe if blocked) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('checkam.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('checkam.' + k, JSON.stringify(v)); } catch (e) {} }
};
let device = store.get('device', null);
if (!device) { device = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); store.set('device', device); }

/* ---------- backend (optional) ---------- */
const CFG = window.CHECKAM_CONFIG || {};
const Api = {
  on: !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY),
  async rpc(name, body, ms = 7000) {
    if (!this.on) throw new Error('offline');
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(CFG.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
        method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', apikey: CFG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + CFG.SUPABASE_ANON_KEY },
        body: JSON.stringify(body || {})
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const txt = await r.text(); return txt ? JSON.parse(txt) : null;
    } finally { clearTimeout(t); }
  }
};

/* ---------- GS1 helpers ---------- */
const PREFIX = [[0,139,'USA or Canada'],[300,379,'France'],[400,440,'Germany'],[450,459,'Japan'],[490,499,'Japan'],[500,509,'the UK'],[540,549,'Belgium or Luxembourg'],[600,601,'South Africa'],[603,603,'Ghana'],[615,615,'Nigeria'],[616,616,'Kenya'],[690,699,'China'],[760,769,'Switzerland'],[800,839,'Italy'],[840,849,'Spain'],[870,879,'the Netherlands'],[880,880,'South Korea'],[890,890,'India'],[893,893,'Vietnam'],[899,899,'Indonesia']];
function checkDigitOk(g) {
  if (!/^\d{8}$|^\d{12,14}$/.test(g)) return false;
  const d = g.split('').map(Number), last = d.pop(); let s = 0;
  d.reverse().forEach((n, i) => { s += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - s % 10) % 10 === last;
}
function gsCountry(g) { const p = parseInt(g.padStart(14, '0').slice(1, 4), 10); const h = PREFIX.find(([a, b]) => p >= a && p <= b); return h ? h[2] : null; }
function parseYMD(s) {
  if (!/^\d{6}$/.test(s || '')) return null;
  const y = 2000 + +s.slice(0, 2), m = +s.slice(2, 4); let d = +s.slice(4, 6);
  if (m < 1 || m > 12 || d > 31) return null;
  if (d === 0) d = new Date(y, m, 0).getDate();
  return new Date(y, m - 1, d);
}
function parseGS1(text) {
  let t = String(text).trim(); const out = {};
  if (/^\(\d{2,4}\)/.test(t)) { const re = /\((\d{2,4})\)([^(]*)/g; let m; while ((m = re.exec(t))) out[m[1]] = m[2].trim(); return out; }
  t = t.replace(/^\]d2|^\]C1|^\]Q3/, '').replace(/^\u001d/, '');
  if (/^\d{8}$|^\d{12,14}$/.test(t)) { out['01'] = t.padStart(14, '0'); out.plain = true; return out; }
  const fixed = { '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6 };
  const varAI = ['10', '21', '22', '240', '241', '710', '711', '712', '713', '714', '91', '92'];
  let i = 0, guard = 0;
  while (i < t.length && guard++ < 20) {
    const two = t.slice(i, i + 2);
    if (fixed[two]) { out[two] = t.slice(i + 2, i + 2 + fixed[two]); i += 2 + fixed[two]; continue; }
    const ai = varAI.find(a => t.startsWith(a, i)); if (!ai) break;
    let j = t.indexOf('\u001d', i + ai.length); if (j < 0) j = t.length;
    out[ai] = t.slice(i + ai.length, j); i = j + 1;
  }
  if (!out['01'] && !out['21']) out.unknown = t;
  return out;
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = d => d ? d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() : '—';
const fmtMonth = d => MONTHS[d.getMonth()] + ' ' + d.getFullYear();
function ago(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now'; if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago'; if (s < 86400 * 7) return Math.round(s / 86400) + ' days ago';
  const d = new Date(t); return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

/* ---------- icons ---------- */
const ICON = {
  ok: '<svg class="draw" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13" fill="#0b6b45"/><path d="M8 14.5l4 4 8-9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg class="draw" viewBox="0 0 28 28" aria-hidden="true"><path d="M14 2l13 23H1z" fill="#f4b400"/><path d="M14 10v7M14 21v.5" stroke="#3a2600" stroke-width="3" stroke-linecap="round"/></svg>',
  bad: '<svg class="draw" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13" fill="#d7263d"/><path d="M9 9l10 10M19 9L9 19" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  info: '<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="13" fill="none" stroke="currentColor" stroke-width="2" opacity=".5"/><path d="M14 12v8M14 8v.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".7"/></svg>'
};
const LEVEL = {
  ok:   { stamp: 'No red flags', small: 'Checked by CheckAm', title: 'No red flags found', line: 'Nothing we checked looks wrong. Still buy from a licensed pharmacy.' },
  warn: { stamp: 'Check well', small: 'Ask the pharmacist', title: 'Check this pack carefully', line: 'Something needs a closer look before you use it.' },
  bad:  { stamp: "Don't use", small: 'Likely problem', title: 'This pack looks wrong', line: "Don't take it. Show it to a pharmacist and report it." }
};

/* ---------- samples ---------- */
const SAMPLES = [
  { name: 'Normal pack', note: 'All checks pass', color: '#13915f', raw: '(01)06151234567891(17)271130(10)LT2405A(21)8KQ2M7XZ41', printed: 'yes', copy: { others: 0, cities: [] } },
  { name: 'Changed expiry', note: 'Box date relabelled', color: '#f4b400', raw: '(01)06151234567891(17)250331(10)LT2311C(21)P3M9RT22B8', printed: 'no', copy: { others: 0, cities: [] } },
  { name: 'Copied code', note: 'Serial seen elsewhere', color: '#d7263d', raw: '(01)06151234567891(17)280630(10)LT2501B(21)7HD2KQ90XA', printed: 'yes', copy: { others: 3, cities: ['kano', 'aba'] } },
  { name: 'Invented number', note: 'Fails the number test', color: '#d7263d', raw: '(01)06151234567895(17)280630(10)BX01(21)00000001', printed: null, copy: { others: 0, cities: [] } }
];

/* ---------- evaluation ---------- */
function evaluate(e) {
  const f = e.fields, items = []; let level = 'ok';
  const add = (l, t) => { items.push([l, t]); if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
  const g = (f['01'] || '').replace(/\D/g, ''), sn = f['21'] || '', exp = parseYMD(f['17']);
  if (f.unknown && !g) add('warn', "This code isn't a medicine pack code. Look for the small square dot code instead.");
  else if (!g) add('bad', 'No product number in this code. A medicine pack code should always have one.');
  else if (!checkDigitOk(g)) add('bad', 'The product number fails its built-in check. Real numbers always pass, so this one was probably made up or misprinted.');
  else { add('ok', 'The product number is a real-format GS1 number.'); const c = gsCountry(g); if (c) add('info', 'The number was issued through GS1 in ' + c + '. That shows where the brand registered it, not always where it was made.'); }
  if (f.plain) add('warn', 'This is an ordinary barcode, the same on every pack of this product, so it cannot show whether this one is genuine. Look for the small square dot code.');
  else if (g && !sn) add('warn', 'There is no serial number, so this pack cannot be told apart from copies.');
  if (f['17'] && !exp) add('bad', 'The expiry date inside the code is not a real date.');
  if (exp) {
    const days = (exp - Date.now()) / 864e5;
    if (days < 0) add('bad', 'Expired on ' + fmtDate(exp) + '. Do not use it.');
    else if (days < 90) add('warn', 'Expires soon, on ' + fmtDate(exp) + '.');
    else add('ok', 'Not expired. Good until ' + fmtDate(exp) + '.');
    if (e.printed === 'yes') add('ok', 'The date printed on the box matches the code.');
    else if (e.printed === 'no') add('bad', 'The date printed on the box does not match the code (' + fmtMonth(exp) + '). The date may have been changed to hide old stock.');
    else if (e.printed === 'none') add('warn', "You couldn't find a printed expiry date. Genuine packs always show one.");
  }
  if (g && sn) {
    const c = e.copy;
    if (c === 'off') add('info', 'Copy check needs an internet connection. Try again when you are online.');
    else if (c && c.others === 0) add('ok', 'Nobody else has scanned this serial number. That is what we expect from a genuine pack.');
    else if (c && c.others > 0) {
      const here = (e.opts.city || '').trim().toLowerCase();
      const far = (c.cities || []).filter(x => x && x !== here).map(x => x.replace(/\b\w/g, k => k.toUpperCase()));
      if (far.length || c.others >= 2) add('bad', 'This exact serial number was already scanned ' + c.others + (c.others > 1 ? ' times' : ' time') + (far.length ? ' in ' + far.join(', ') : '') + '. Every genuine pack has its own serial, so this code has probably been copied.');
      else add('warn', 'Someone else scanned this serial before, in the same town. It may be the same pack resold. Ask the seller.');
    }
  }
  const rank = { bad: 0, warn: 1, ok: 2, info: 3 };
  items.sort((x, y) => rank[x[0]] - rank[y[0]]);
  return { level, items, g, sn, lot: f['10'] || '', exp };
}

/* ---------- screens ---------- */
const ORDER = ['home', 'result', 'history', 'alerts', 'me'];
let currentScreen = 'home';
function go(name) {
  const from = ORDER.indexOf(currentScreen), to = ORDER.indexOf(name);
  document.querySelectorAll('.screen').forEach(s => {
    const n = s.id.slice(2);
    s.classList.toggle('on', n === name);
    s.classList.toggle('left', n !== name && ORDER.indexOf(n) < to);
    if (n === name) s.scrollTop = 0;
  });
  void from;
  currentScreen = name;
  const tab = name === 'result' ? 'home' : name;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  if (name === 'history') renderHistory();
  if (name === 'alerts') renderAlerts();
  if (name === 'me') renderMe();
}
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));

let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2800); }

/* ---------- sheets ---------- */
let sheetClose = null;
function openSheet(html, onMount) {
  $('sheetBody').innerHTML = html; $('sheet').classList.add('on'); $('sheetBg').classList.add('on');
  if (onMount) onMount();
  const first = $('sheet').querySelector('input,textarea,select,button'); if (first) setTimeout(() => first.focus(), 300);
}
function closeSheet() { $('sheet').classList.remove('on'); $('sheetBg').classList.remove('on'); if (sheetClose) { sheetClose(); sheetClose = null; } }
$('sheetBg').addEventListener('click', closeSheet);
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { if ($('scanner').classList.contains('on')) closeScanner(); else closeSheet(); } });

/* ---------- place ---------- */
const STATES = ['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT Abuja','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara'];
const stateOptions = sel => '<option value="">Choose your state</option>' + STATES.map(s => '<option' + (s === sel ? ' selected' : '') + '>' + s + '</option>').join('');
function place() { return store.get('place', { city: '', state: '' }); }
function renderPlace() { const p = place(); $('placeTxt').textContent = p.city || 'Set your town'; }
$('placeChip').addEventListener('click', () => {
  const p = place();
  openSheet('<h2 id="sheetH">Where do you buy medicine?</h2><p class="sub" style="margin-top:6px">This helps spot copied codes moving between towns. It stays on this phone and is shared only with your scans.</p>' +
    '<label class="f" for="pCity">Town or city</label><input class="input" id="pCity" autocomplete="address-level2" value="' + esc(p.city) + '" placeholder="e.g. Onitsha">' +
    '<label class="f" for="pState">State</label><select class="input" id="pState">' + stateOptions(p.state) + '</select>' +
    '<div class="actions"><button class="btn" id="pSave" type="button">Save</button></div>', () => {
    $('pSave').addEventListener('click', () => { store.set('place', { city: $('pCity').value.trim().slice(0, 60), state: $('pState').value }); renderPlace(); closeSheet(); toast('Town saved'); });
  });
});

/* ---------- running a check ---------- */
let current = null;
async function runCheck(fields, opts = {}) {
  const p = place();
  const e = { id: Date.now().toString(36), t: Date.now(), fields, printed: opts.printed ?? null, copy: opts.copy ?? null, opts: { city: p.city, state: p.state, sample: !!opts.sample, name: opts.name || '' } };
  $('s-result').innerHTML = '<div class="carton"><div class="flap">Checking…</div><dl><dt>Reading</dt><dd>Product, batch, expiry, serial</dd></dl></div>';
  go('result');
  const g = (fields['01'] || '').replace(/\D/g, ''), sn = fields['21'] || '';
  if (!e.opts.sample && g && sn && e.copy == null) {
    try {
      const r = await Api.rpc('check_serial', { p_key: g + '|' + sn, p_device: device });
      e.copy = { others: +(r && r.others) || 0, cities: (r && r.cities) || [] };
    } catch (err) { e.copy = 'off'; }
  }
  const res = evaluate(e);
  if (!e.opts.sample) {
    const h = store.get('history', []); h.unshift(e); store.set('history', h.slice(0, 60));
    if (Api.on && g) Api.rpc('log_scan', { p_key: g + '|' + sn, p_gtin: g, p_serial: sn, p_lot: res.lot, p_exp: res.exp ? res.exp.toISOString().slice(0, 10) : null, p_city: e.opts.city, p_state: e.opts.state, p_level: res.level, p_device: device }).catch(() => {});
  }
  renderResult(e, true);
  if (navigator.vibrate && !reduceMotion) navigator.vibrate(res.level === 'ok' ? 40 : [60, 60, 60]);
}
function updateHistory(e) { const h = store.get('history', []); const i = h.findIndex(x => x.id === e.id); if (i >= 0) { h[i] = e; store.set('history', h); } }

function renderResult(e, animate) {
  current = e;
  const r = evaluate(e), L = LEVEL[r.level];
  const nudge = !e.opts.sample && !store.get('profile', null) && Date.now() - store.get('nudgeAt', 0) > 3 * 864e5;
  const ask = r.exp && e.printed == null;
  $('s-result').innerHTML =
    '<div class="top" style="margin-bottom:10px"><button class="chip" id="backBtn" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Back</button>' + (e.opts.sample ? '<span class="tag t-warn">Sample, made-up data</span>' : '<span class="sub" style="font-size:14px">' + esc(ago(e.t)) + '</span>') + '</div>' +
    '<div class="carton ' + r.level + (animate ? ' enter thunk' : '') + '">' +
      '<div class="flap">' + esc(e.opts.sample ? e.opts.name : 'Medicine pack') + '</div>' +
      '<dl><dt>Product no.</dt><dd>' + esc(r.g || '—') + '</dd><dt>Batch</dt><dd>' + esc(r.lot || '—') + '</dd><dt>Expiry</dt><dd>' + esc(fmtDate(r.exp)) + '</dd><dt>Serial</dt><dd>' + esc(r.sn || '—') + '</dd></dl>' +
      '<div class="stamp ' + r.level + '" aria-hidden="true"><div>' + esc(L.stamp) + '<small>' + esc(L.small) + '</small></div></div>' +
    '</div>' +
    '<div class="' + (animate ? 'reveal' : '') + '">' +
      '<div class="verdict ' + r.level + '" style="--i:0"><h2>' + esc(L.title) + '</h2><p class="sub" style="margin-top:6px">' + esc(L.line) + '</p></div>' +
      (ask ? '<div class="ask" style="--i:1"><strong>Look at the expiry date printed on the box. Does it say ' + esc(fmtMonth(r.exp)) + '?</strong><div class="row"><button type="button" data-p="yes">Yes</button><button type="button" data-p="no">No</button><button type="button" data-p="none">No date</button></div></div>' : '') +
      '<ul class="checks" style="--i:2">' + r.items.map(([l, t], i) => '<li style="--i:' + (i + 2) + '">' + ICON[l] + '<span>' + esc(t) + '</span></li>').join('') + '</ul>' +
      (nudge ? '<div class="nudge" style="--i:3"><button class="x" id="nudgeX" type="button" aria-label="Dismiss">×</button><h3>Get alerts about fakes near you</h3><p>Free. We\'ll message you when a fake medicine is found in your state.</p><button class="btn" id="nudgeGo" type="button">Sign up for alerts</button></div>' : '') +
      '<div class="actions" style="--i:4">' +
        '<button class="btn" id="againBtn" type="button">Scan another pack</button>' +
        '<div class="row"><button class="btn soft" id="shareBtn" type="button">Share result</button>' + (e.opts.sample ? '' : '<button class="btn soft" id="reportBtn" type="button">Report it</button>') + '</div>' +
      '</div>' +
      '<p class="note" style="--i:5">CheckAm finds warning signs. A clean result is not proof that a pack is genuine.</p>' +
    '</div>';
  $('backBtn').addEventListener('click', () => go('home'));
  $('againBtn').addEventListener('click', openScanner);
  $('shareBtn').addEventListener('click', () => share(r));
  const rb = $('reportBtn'); if (rb) rb.addEventListener('click', () => openReport(e, r));
  $('s-result').querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { e.printed = b.dataset.p; if (!e.opts.sample) updateHistory(e); renderResult(e, false); toast(b.dataset.p === 'yes' ? 'Dates match' : 'Noted'); }));
  if (nudge) {
    $('nudgeX').addEventListener('click', ev => { store.set('nudgeAt', Date.now()); ev.target.closest('.nudge').remove(); });
    $('nudgeGo').addEventListener('click', () => go('me'));
  }
}
async function share(r) {
  const txt = 'I checked a medicine pack with CheckAm: ' + LEVEL[r.level].title + '. Check yours free: ' + location.origin + location.pathname;
  try { if (navigator.share) { await navigator.share({ title: 'CheckAm', text: txt }); return; } } catch (e) { return; }
  const a = document.createElement('a'); a.href = 'https://wa.me/?text=' + encodeURIComponent(txt); a.target = '_blank'; a.rel = 'noopener'; a.click();
}
function openReport(e, r) {
  openSheet('<h2 id="sheetH">Report this pack</h2><p class="sub" style="margin-top:6px">Your report helps warn others. Please also tell NAFDAC.</p>' +
    '<label class="f" for="rWhat">What looks wrong?</label><textarea class="input" id="rWhat" rows="3" placeholder="e.g. blurry print, price far too low, broken seal"></textarea>' +
    '<label class="f" for="rSeller">Where did you buy it? (shop or market)</label><input class="input" id="rSeller" placeholder="e.g. Bridge Head market">' +
    '<div class="actions"><button class="btn" id="rSend" type="button">Send report</button></div>', () => {
    $('rSend').addEventListener('click', async () => {
      const btn = $('rSend'); btn.disabled = true; btn.textContent = 'Sending…';
      const body = { p_gtin: r.g, p_serial: r.sn, p_lot: r.lot, p_note: $('rWhat').value.slice(0, 500), p_seller: $('rSeller').value.slice(0, 100), p_city: e.opts.city, p_state: e.opts.state, p_device: device };
      try { await Api.rpc('add_report', body); closeSheet(); toast('Report sent. Thank you.'); }
      catch (err) { const q = store.get('reportQueue', []); q.push(body); store.set('reportQueue', q.slice(-20)); closeSheet(); toast('Saved. It will send when you are online.'); }
    });
  });
}
async function flushReports() {
  if (!Api.on) return; const q = store.get('reportQueue', []); if (!q.length) return;
  const left = []; for (const b of q) { try { await Api.rpc('add_report', b); } catch (e) { left.push(b); } }
  store.set('reportQueue', left);
}

/* ---------- typed entry ---------- */
function openType() {
  openSheet('<h2 id="sheetH">Type the code</h2><p class="sub" style="margin-top:6px">Look next to the square code. Packs often print GTIN or PC, SN, LOT and EXP.</p>' +
    '<label class="f" for="tG">GTIN or PC (product number)</label><input class="input" id="tG" inputmode="numeric" autocomplete="off" placeholder="14 digits">' +
    '<label class="f" for="tS">SN (serial number)</label><input class="input" id="tS" autocomplete="off" autocapitalize="characters">' +
    '<div class="row"><div><label class="f" for="tL">LOT or batch</label><input class="input" id="tL" autocomplete="off" autocapitalize="characters"></div><div><label class="f" for="tE">EXP</label><input class="input" id="tE" type="month"></div></div>' +
    '<p class="sub" id="tErr" style="color:var(--hib-ink);min-height:24px;margin-top:8px" role="alert"></p>' +
    '<div class="actions"><button class="btn" id="tGo" type="button">Check pack</button></div>', () => {
    $('tGo').addEventListener('click', () => {
      const g = $('tG').value.replace(/\D/g, '');
      if (g.length < 8) { $('tErr').textContent = 'Enter the product number: 8 to 14 digits.'; return; }
      const f = { '01': g.padStart(14, '0'), '21': $('tS').value.trim(), '10': $('tL').value.trim() };
      const m = $('tE').value; if (m) { const [y, mo] = m.split('-'); f['17'] = y.slice(2) + mo + '00'; }
      closeSheet(); runCheck(f);
    });
  });
}

/* ---------- decoding ---------- */
let zxReader = null, zxHints = null;
function zx() {
  if (!window.ZXing) return null;
  if (!zxReader) {
    zxHints = new Map();
    zxHints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.DATA_MATRIX, ZXing.BarcodeFormat.QR_CODE, ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.CODE_128]);
    zxHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxReader = new ZXing.MultiFormatReader(); zxReader.setHints(zxHints);
  }
  return zxReader;
}
function decodeCanvas(c) {
  const r = zx(); if (!r) return null;
  try { const res = r.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(c))), zxHints); return res ? res.getText() : null; }
  catch (e) { return null; }
}
let detector = null;
try { if ('BarcodeDetector' in window) detector = new BarcodeDetector({ formats: ['data_matrix', 'qr_code', 'ean_13', 'code_128'] }); } catch (e) { detector = null; }

async function decodeFile(file) {
  const img = await createImageBitmap(file);
  if (detector) { try { const r = await detector.detect(img); if (r.length) return r[0].rawValue; } catch (e) {} }
  for (const max of [1600, 1000, 700, 2400]) {
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const t = decodeCanvas(c); if (t) return t;
  }
  return null;
}
function pickPhoto() { $('photoIn').value = ''; $('photoIn').click(); }
$('photoIn').addEventListener('change', async ev => {
  const f = ev.target.files && ev.target.files[0]; if (!f) return;
  closeScanner(); toast('Reading the code…');
  try { const t = await decodeFile(f); if (t) runCheck(parseGS1(t)); else toast("Couldn't find a code. Try closer and in good light."); }
  catch (e) { toast("Couldn't open that photo."); }
});

/* ---------- live scanner ---------- */
let stream = null, scanning = false, lastTry = 0;
const frame = document.createElement('canvas');
async function openScanner() {
  closeSheet();
  $('scanner').classList.add('on'); $('vf').classList.remove('got'); $('camErr').style.display = 'none'; $('torchBtn').hidden = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const v = $('video'); v.srcObject = stream; await v.play();
    const track = stream.getVideoTracks()[0];
    try { if (track.getCapabilities && track.getCapabilities().torch) $('torchBtn').hidden = false; } catch (e) {}
    scanning = true; requestAnimationFrame(loop);
  } catch (e) {
    const err = $('camErr'); err.style.display = 'block';
    err.innerHTML = '<p style="margin-bottom:10px">The camera is not available here. Allow camera access in your browser, or use a photo instead.</p><button class="btn" type="button" id="errPhoto">Use a photo</button>';
    $('errPhoto').addEventListener('click', pickPhoto);
  }
}
async function loop(ts) {
  if (!scanning) return;
  if (ts - lastTry > 220) {
    lastTry = ts;
    const v = $('video');
    if (v.readyState >= 2) {
      let text = null;
      if (detector) { try { const r = await detector.detect(v); if (r.length) text = r[0].rawValue; } catch (e) {} }
      if (!text && window.ZXing) {
        const s = Math.min(v.videoWidth, v.videoHeight) * 0.7, sx = (v.videoWidth - s) / 2, sy = (v.videoHeight - s) / 2;
        const out = Math.min(800, s); frame.width = out; frame.height = out;
        frame.getContext('2d').drawImage(v, sx, sy, s, s, 0, 0, out, out);
        text = decodeCanvas(frame);
      }
      if (text && scanning) {
        scanning = false; $('vf').classList.add('got');
        if (navigator.vibrate) navigator.vibrate(30);
        setTimeout(() => { closeScanner(); runCheck(parseGS1(text)); }, reduceMotion ? 0 : 380);
        return;
      }
    }
  }
  requestAnimationFrame(loop);
}
function closeScanner() {
  scanning = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('scanner').classList.remove('on'); $('torchBtn').setAttribute('aria-pressed', 'false');
}
$('torchBtn').addEventListener('click', async () => {
  if (!stream) return; const t = stream.getVideoTracks()[0]; const on = $('torchBtn').getAttribute('aria-pressed') !== 'true';
  try { await t.applyConstraints({ advanced: [{ torch: on }] }); $('torchBtn').setAttribute('aria-pressed', String(on)); } catch (e) { toast('Torch not available'); }
});
$('scanBtn').addEventListener('click', openScanner);
$('scanClose').addEventListener('click', closeScanner);
$('scanPhoto').addEventListener('click', pickPhoto);
$('scanType').addEventListener('click', () => { closeScanner(); openType(); });
$('photoBtn').addEventListener('click', pickPhoto);
$('typeBtn').addEventListener('click', openType);

/* ---------- samples ---------- */
$('samples').innerHTML = SAMPLES.map((s, i) => '<button class="sample" type="button" data-s="' + i + '"><i style="background:' + s.color + '"></i><strong>' + esc(s.name) + '</strong><small>' + esc(s.note) + '</small></button>').join('');
$('samples').querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { const s = SAMPLES[+b.dataset.s]; runCheck(parseGS1(s.raw), { sample: true, name: s.name, printed: s.printed, copy: s.copy }); }));

/* ---------- history ---------- */
function renderHistory() {
  const h = store.get('history', []);
  if (!h.length) { $('histList').innerHTML = '<div class="empty"><svg viewBox="0 0 96 96" aria-hidden="true"><rect x="20" y="16" width="56" height="68" rx="8" fill="none" stroke="currentColor" stroke-width="4"/><path d="M32 36h32M32 48h32M32 60h18" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg><p>No checks yet. Your scanned packs will be listed here.</p><button class="btn" type="button" id="hScan" style="max-width:240px">Scan a pack</button></div>'; $('hScan').addEventListener('click', openScanner); $('clearHist').hidden = true; return; }
  $('clearHist').hidden = false;
  $('histList').innerHTML = h.map((e, i) => { const r = evaluate(e); const tint = { ok: 't-ok', warn: 't-warn', bad: 't-bad' }[r.level];
    return '<button class="item" type="button" data-h="' + i + '"><span class="dot ' + tint + '">' + ICON[r.level].replace('class="draw" ', '') + '</span><span><strong>' + esc(r.g || 'Unknown code') + '</strong><small>Batch ' + esc(r.lot || '—') + ' · ' + esc(ago(e.t)) + '</small></span><span class="tag ' + tint + '">' + esc(LEVEL[r.level].stamp) + '</span></button>'; }).join('');
  $('histList').querySelectorAll('[data-h]').forEach(b => b.addEventListener('click', () => { const e = store.get('history', [])[+b.dataset.h]; if (e) { renderResult(e, false); go('result'); } }));
}
$('clearHist').addEventListener('click', () => {
  openSheet('<h2 id="sheetH">Clear all checks?</h2><p class="sub" style="margin:8px 0 18px">This removes your check history from this phone. Shared community data is not affected.</p><div class="row"><button class="btn soft" id="cNo" type="button">Keep</button><button class="btn" id="cYes" type="button" style="background:var(--hib)">Clear history</button></div>', () => {
    $('cNo').addEventListener('click', closeSheet);
    $('cYes').addEventListener('click', () => { store.set('history', []); closeSheet(); renderHistory(); toast('History cleared'); });
  });
});

/* ---------- alerts ---------- */
const TIPS = [
  ['Buy from a licensed pharmacy or patent medicine store, and keep the receipt.', 'M6 10h20v16H6zM10 10V6h12v4'],
  ['Compare with a pack you know is genuine: print, colours, spelling, seal.', 'M4 16h10M18 16h10M9 8v16M23 8v16'],
  ['Be wary when the price is far below what you normally pay.', 'M16 4v24M22 9h-8a4 4 0 0 0 0 8h4a4 4 0 0 1 0 8h-9'],
  ['Look for a sticker over the expiry date. Peel back gently and check underneath.', 'M6 6h20v20H6zM18 26l8-8'],
  ['Has a scratch panel? Text the PIN to the number shown to confirm with NAFDAC.', 'M8 4h16v24H8zM12 22h8']
];
$('tips').innerHTML = TIPS.map(([t, d]) => '<div class="tip"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="' + d + '" fill="none" stroke="#0b6b45" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + esc(t) + '</span></div>').join('');
async function renderAlerts() {
  const box = $('flagList');
  if (!Api.on) { box.innerHTML = '<div class="card"><h3>Community alerts</h3><p class="sub" style="margin-top:6px">When people find suspicious packs, they will be listed here so you know what to watch for.</p></div>'; return; }
  box.innerHTML = '<p class="sub">Loading alerts…</p>';
  try {
    const rows = await Api.rpc('recent_flags', {});
    store.set('alertsSeen', Date.now()); $('alertBadge').style.display = 'none';
    if (!rows || !rows.length) { box.innerHTML = '<div class="card"><h3>No alerts this week</h3><p class="sub" style="margin-top:6px">Nobody has flagged a pack recently. Keep checking before you buy.</p></div>'; return; }
    box.innerHTML = '<p class="sub" style="margin:-10px 0 14px">Packs flagged by CheckAm users. Unconfirmed until NAFDAC checks them.</p>' + rows.map(x => '<div class="item"><span class="dot t-bad">' + ICON.bad.replace('class="draw" ', '') + '</span><span><strong>' + esc(x.reason || 'Suspicious pack') + '</strong><small>Product ' + esc(x.gtin || '—') + ' · batch ' + esc(x.lot || '—') + '</small><small>' + esc([x.city, x.state].filter(Boolean).join(', ') || 'Nigeria') + ' · ' + esc(ago(Date.parse(x.created_at))) + '</small></span></div>').join('');
  } catch (e) { box.innerHTML = '<div class="card"><h3>Alerts need internet</h3><p class="sub" style="margin-top:6px">Connect and open this tab again.</p></div>'; }
}
async function checkBadge() {
  if (!Api.on) return;
  try { const rows = await Api.rpc('recent_flags', {}); const seen = store.get('alertsSeen', 0); if (rows && rows.some(x => Date.parse(x.created_at) > seen)) $('alertBadge').style.display = 'block'; } catch (e) {}
}

/* ---------- updates / sign-up ---------- */
function renderMe() {
  const p = store.get('profile', null), body = $('meBody');
  if (p) {
    body.innerHTML = '<div class="card done"><svg class="draw" viewBox="0 0 84 84" aria-hidden="true"><circle cx="42" cy="42" r="40" fill="#0b6b45"/><path d="M24 43l12 12 24-26" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg><h3>You\'re signed up' + (p.name ? ', ' + esc(p.name) : '') + '</h3><p class="sub">We\'ll send alerts for ' + esc(p.state || 'Nigeria') + ' to ' + esc(p.contact) + '.</p>' + (p.pending ? '<p class="note">Saved on this phone. It will be sent when CheckAm is online.</p>' : '') + '<button class="btn soft" id="unsub" type="button" style="margin-top:8px">Stop updates</button></div>';
    $('unsub').addEventListener('click', async () => {
      if (p.token) { try { await Api.rpc('unsubscribe', { p_token: p.token }); } catch (e) { toast('Could not reach the server. Try again online.'); return; } }
      store.set('profile', null); renderMe(); toast('Updates stopped');
    });
    return;
  }
  const pl = place();
  body.innerHTML = '<p class="sub" style="margin:-10px 0 4px">CheckAm is free to use without an account. Sign up only if you want alerts when fake medicines are found in your state.</p>' +
    '<form class="card" id="subForm" novalidate>' +
      '<label class="f" for="uName">Your name (optional)</label><input class="input" id="uName" autocomplete="given-name">' +
      '<label class="f" for="uContact">WhatsApp number or email</label><input class="input" id="uContact" autocomplete="tel" placeholder="e.g. 0803 123 4567">' +
      '<label class="f" for="uState">Your state</label><select class="input" id="uState">' + stateOptions(pl.state) + '</select>' +
      '<label class="check"><input type="checkbox" id="uOk"><span>Send me alerts about fake medicines. I can stop them any time.</span></label>' +
      '<p class="sub" id="uErr" style="color:var(--hib-ink);min-height:24px;margin-top:10px" role="alert"></p>' +
      '<button class="btn" id="uGo" type="submit">Sign up for alerts</button>' +
    '</form>';
  $('subForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = $('uName').value.trim().slice(0, 60), contact = $('uContact').value.trim(), state = $('uState').value;
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact), isPhone = /^\+?[\d\s-]{10,16}$/.test(contact);
    if (!isEmail && !isPhone) { $('uErr').textContent = 'Enter a phone number or an email address.'; return; }
    if (!state) { $('uErr').textContent = 'Choose your state so we send the right alerts.'; return; }
    if (!$('uOk').checked) { $('uErr').textContent = 'Tick the box to agree to receive alerts.'; return; }
    const btn = $('uGo'); btn.disabled = true; btn.textContent = 'Signing up…';
    const profile = { name, contact, state };
    try { const tok = await Api.rpc('subscribe', { p_name: name, p_contact: contact, p_state: state, p_device: device }); profile.token = tok; }
    catch (e) { profile.pending = true; }
    store.set('profile', profile); renderMe(); toast('Signed up for alerts');
  });
}
async function flushSignup() {
  const p = store.get('profile', null); if (!p || !p.pending || !Api.on) return;
  try { p.token = await Api.rpc('subscribe', { p_name: p.name, p_contact: p.contact, p_state: p.state, p_device: device }); delete p.pending; store.set('profile', p); } catch (e) {}
}

/* ---------- install ---------- */
let installEvt = null;
addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); installEvt = ev; $('installCard').hidden = false; });
$('installBtn').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('installCard').hidden = true; });

/* ---------- onboarding ---------- */
function setupOnboarding() {
  if (store.get('onboarded', false)) return;
  const ob = $('onboard'), sl = $('slides'), dots = [...$('dots').children]; ob.classList.add('on');
  const idx = () => Math.round(sl.scrollLeft / sl.clientWidth);
  const sync = () => { const i = idx(); dots.forEach((d, k) => d.classList.toggle('on', k === i)); $('obNext').textContent = i === dots.length - 1 ? 'Start checking' : 'Next'; };
  sl.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  const finish = () => { store.set('onboarded', true); ob.classList.remove('on'); $('scanBtn').focus(); };
  $('obNext').addEventListener('click', () => { const i = idx(); if (i >= dots.length - 1) finish(); else sl.scrollTo({ left: (i + 1) * sl.clientWidth, behavior: reduceMotion ? 'auto' : 'smooth' }); });
  $('obSkip').addEventListener('click', finish);
  addEventListener('keydown', ev => { if (!ob.classList.contains('on')) return; if (ev.key === 'ArrowRight') $('obNext').click(); if (ev.key === 'ArrowLeft') sl.scrollTo({ left: Math.max(0, idx() - 1) * sl.clientWidth }); });
}

/* ---------- start ---------- */
renderPlace();
setupOnboarding();
if (navigator.onLine) { flushReports(); flushSignup(); checkBadge(); }
addEventListener('online', () => { flushReports(); flushSignup(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('sw.js').catch(() => {}); }
window.__checkam = { parseGS1, checkDigitOk, parseYMD, evaluate };
})();
