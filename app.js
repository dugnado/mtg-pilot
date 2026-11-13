/* Pilot app UI. Ported from flubs-pilot-app-v6-src.html; deck-agnostic.
   Storage: localStorage = settings + current game per deck; IndexedDB = game log + loaded decks.
   Claude: direct browser calls to the Messages API with the key from Settings. */
'use strict';
const APP_VERSION = '1.0.8-2bccc20b';
const E = window.Engine;
const $ = id => document.getElementById(id);
// deploy.sh stamps APP_VERSION as <version>-<hash>; the header shows v<version> · <first 4 of hash>
$('verTag').textContent = 'v' + APP_VERSION.replace(/-(\w{4})\w*$/, ' · $1');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const short = n => E.short(n);
const CARD = () => E.CARD;

/* ---------- debug log: ring buffer for bug reports (never holds the API key) ---------- */
const DBG = {buf:[], max:150};
try { DBG.buf = JSON.parse(localStorage.getItem('pilot.debug') || '[]'); } catch (e) { DBG.buf = []; }
const scrub = s => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-***');
let dbgSaveT = null;
function dbg(type, data){
  try {
    let d = data === undefined ? null : data;
    const s = scrub(typeof d === 'string' ? JSON.stringify(d) : JSON.stringify(d));
    d = s.length > 8000 ? {truncated:s.slice(0, 8000)} : JSON.parse(s);
    DBG.buf.push({t:new Date().toISOString(), type, data:d});
    if (DBG.buf.length > DBG.max) DBG.buf.splice(0, DBG.buf.length - DBG.max);
    clearTimeout(dbgSaveT); dbgSaveT = setTimeout(() => { try { localStorage.setItem('pilot.debug', JSON.stringify(DBG.buf)); } catch (e) {} }, 300);
  } catch (e) {}
}
window.addEventListener('error', e => dbg('error', {msg:e.message, src:e.filename, line:e.lineno, col:e.colno, stack:e.error && e.error.stack}));
window.addEventListener('unhandledrejection', e => dbg('rejection', {msg:String(e.reason && e.reason.message || e.reason), stack:e.reason && e.reason.stack}));
['error', 'warn'].forEach(k => { const o = console[k].bind(console); console[k] = (...a) => { dbg('console.' + k, a.map(x => x instanceof Error ? x.stack || x.message : String(x)).join(' ')); o(...a); }; });
dbg('boot', {app:APP_VERSION, ua:navigator.userAgent, standalone:matchMedia('(display-mode: standalone)').matches});

/* ---------- small storage helpers ---------- */
const LS = {
  get(k, d){ try { const v = localStorage.getItem('pilot.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  // (debug log lives under pilot.debug; see DBG above)
  set(k, v){ try { localStorage.setItem('pilot.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k){ try { localStorage.removeItem('pilot.' + k); } catch (e) {} },
};
const IDB = {
  db: null,
  open(){
    return new Promise((res, rej) => {
      const r = indexedDB.open('pilot', 2);
      r.onupgradeneeded = () => {   // v1: games, decks. v2: kv (last photo), bugs (saved reports)
        const db = r.result; const has = n => db.objectStoreNames.contains(n);
        if (!has('games')) db.createObjectStore('games', {keyPath:'id', autoIncrement:true}).createIndex('deck', 'deck');
        if (!has('decks')) db.createObjectStore('decks', {keyPath:'slug'});
        if (!has('kv')) db.createObjectStore('kv', {keyPath:'k'});
        if (!has('bugs')) db.createObjectStore('bugs', {keyPath:'id', autoIncrement:true});
      };
      r.onsuccess = () => { IDB.db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn){
    return new Promise((res, rej) => {
      const t = IDB.db.transaction(store, mode); const s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get(store, k){ return IDB.tx(store, 'readonly', s => s.get(k)); },
  all(store, index, key){ return IDB.tx(store, 'readonly', s => index ? s.index(index).getAll(key) : s.getAll()); },
  put(store, v){ return IDB.tx(store, 'readwrite', s => s.put(v)); },
  add(store, v){ return IDB.tx(store, 'readwrite', s => s.add(v)); },
  del(store, k){ return IDB.tx(store, 'readwrite', s => s.delete(k)); },
};

/* ---------- decks ---------- */
let bundled = [];   // [{slug,name,file,list}]
let userDecks = []; // [{slug,name,list,data}]
let deck = null;    // current normalized deck

async function loadBundledIndex(){
  try { const r = await fetch('decks/index.json', {cache:'no-cache'}); bundled = await r.json(); }
  catch (e) { bundled = []; }
}
async function deckData(slug){
  const u = userDecks.find(d => d.slug === slug); if (u) return u.data;
  const b = bundled.find(d => d.slug === slug); if (!b) return null;
  const r = await fetch('decks/' + b.file, {cache:'no-cache'}); if (!r.ok) throw new Error('Could not load ' + b.file);
  return r.json();
}
async function switchDeck(slug){
  if (deck) saveState();
  const data = await deckData(slug);
  if (!data) throw new Error('Deck ' + slug + ' not found.');
  deck = E.loadDeck(data);
  LS.set('deck', deck.slug);
  S = loadState() || fresh();
  games = await loadGames();
  applyDeckChrome();
}
function applyDeckChrome(){
  const C = E.CMD_SHORT;
  document.title = C + ' Pilot';
  $('appTitle').textContent = C + ' Pilot';
  renderDeckSel();
  $('metaLine').textContent = deck.list ? deck.list.slice(5) + ' list' : '';
  $('basicBtns').innerHTML = E.BASIC_LIST.map(b => '<button class="btn" data-basic="' + esc(b) + '">+ ' + esc(b) + '</button>').join('');
  $('addBfBtns').innerHTML = E.BASIC_LIST.map(b => '<button class="btn" data-addbf="' + esc(b) + '">+ ' + esc(b) + '</button>').join('');
  $('fTurnLbl').textContent = C + ' landed turn';
  $('logFieldRow').querySelectorAll('[data-lf]').forEach(n => n.remove());
  for (const f of logFields()) {
    const l = document.createElement('label'); l.className = 'small'; l.style.cssText = 'flex:1;min-width:120px'; l.dataset.lf = f.id;
    l.innerHTML = esc(f.label) + '<input type="number" id="lf-' + esc(f.id) + '" min="0" max="' + (f.max || 99) + '" inputmode="numeric">';
    $('logFieldRow').appendChild(l);
  }
}

// All decks this install can open: bundled first, then loaded files (a loaded file with a bundled slug replaces it).
function allDecks(){
  return [...bundled.map(b => ({slug:b.slug, name:b.name, cmd:b.cmd, list:b.list})),
          ...userDecks.filter(u => !bundled.some(b => b.slug === u.slug)).map(u => ({slug:u.slug, name:u.name, cmd:'', list:u.list}))];
}
function deckLabel(d){ const n = String(d.name), c = String(d.cmd || ''); return c && !n.toLowerCase().startsWith(c.toLowerCase()) ? c + ' — ' + n : n; }
function renderDeckSel(){
  const sel = $('deckSel'); if (!sel) return;
  sel.innerHTML = allDecks().map(d => '<option value="' + esc(d.slug) + '"' + (deck && d.slug === deck.slug ? ' selected' : '') + '>' + esc(deckLabel(d)) + '</option>').join('');
}
$('deckSel').onchange = async e => {
  const slug = e.target.value; if (!deck || slug === deck.slug) return;
  try { await switchDeck(slug); dbg('deck.switch', {slug, from:'title'}); setView(S.view && VIEWS.includes(S.view) ? S.view : 'hand'); toast('Switched to ' + E.CMD_SHORT + '.'); }
  catch (err) { toast('Could not open that deck: ' + err.message); renderDeckSel(); }
};

// Extra numbers on the Log tab. A field tied to a card ("card") shows only while that card is in the list.
function logFields(){ return (E.P.logFields || []).filter(f => !f.card || E.CARD[f.card]); }

/* ---------- game state (per deck) ---------- */
let S = null;
function fresh(){ return {view:'hand', mode:'gold', d14:false, onPlay:true, mull:0, hand:[], library:[], turn:0, bf:[], cmdTurn:null, turns:[], opening:null, verdict:null, predicted:null, drawn:null, result:null}; }
function saveState(){ if (deck && S) LS.set('state.' + deck.slug, S); }
function loadState(){
  const s = LS.get('state.' + deck.slug, null); if (!s) return null;
  const ok = n => !!E.CARD[n];   // drop cards that left the list since the state was saved
  s.hand = (s.hand || []).filter(ok); s.bf = (s.bf || []).filter(p => ok(p.n)); s.library = (s.library || []).filter(ok);
  return s;
}
function libraryFresh(){
  const lib = []; deck.cards.forEach(c => { if (c.n === E.CMD) return; for (let i = 0; i < (c.q || 1); i++) lib.push(c.n); });
  for (let i = lib.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [lib[i], lib[j]] = [lib[j], lib[i]]; }
  return lib;
}
function pipsHtml(n){
  const c = CARD()[n]; if (!c) return ''; let cols = [];
  if (c.land) { const m = E.LAND[n] || {c:''}; cols = (m.c || '').split('').filter(Boolean); }
  else { const o = E.parseCost(c.mc); for (const k of E.COLORS + 'WUBRG') { if (cols.includes(k)) continue; for (let i = 0; i < (o[k] || 0); i++) cols.push(k); } if (!cols.length) cols = ['C']; }
  return '<span class="pips">' + cols.slice(0, 4).map(k => '<i class="pip ' + k + '"></i>').join('') + '</span>';
}
function chip(n, attrs){ return '<button class="chip" ' + (attrs || '') + '>' + pipsHtml(n) + '<span class="nm">' + esc(short(n)) + '</span></button>'; }

/* ---------- views ---------- */
const VIEWS = ['hand', 'turn', 'log', 'set'];
function setView(v){
  S.view = v;
  VIEWS.forEach(k => { $('v-' + k).hidden = k !== v; const t = $('tab-' + k); if (t) t.setAttribute('aria-selected', k === v); });
  $('gearBtn').setAttribute('aria-pressed', v === 'set');
  saveState(); render(); window.scrollTo(0, 0);
}
document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => setView(b.dataset.v));
$('gearBtn').onclick = () => setView(S.view === 'set' ? 'hand' : 'set');

function remaining(){
  const counts = {}; deck.cards.forEach(c => counts[c.n] = c.q || 1); counts[E.CMD] = 0;
  for (const n of [...S.hand, ...S.bf.map(p => p.n)]) if (counts[n] != null) counts[n]--;
  return counts;
}
function cardColors(n){
  const c = CARD()[n];
  if (c.land) { const m = E.LAND[n] || {c:''}; return (m.c || '').replace('C', ''); }
  const o = E.parseCost(c.mc); return E.COLORS.split('').filter(k => o[k]).join('');
}
function typeOf(n){
  const t = CARD()[n].type; if (CARD()[n].land) return 'Lands';
  for (const k of ['Creature', 'Planeswalker', 'Instant', 'Sorcery', 'Enchantment', 'Artifact']) if (t.includes(k)) return k === 'Sorcery' ? 'Sorceries' : k + 's';
  return 'Other';
}
const COLOR_NAME = {W:'White', U:'Blue', B:'Black', R:'Red', G:'Green'};
function nameHit(c, q){ return !q || c.n.toLowerCase().includes(q) || (c.printed && c.printed.toLowerCase().includes(q)); }
function rowLabel(n){ const c = CARD()[n]; return esc(short(n)) + (c.printed ? ' <span class="small">' + esc(c.printed) + '</span>' : ''); }
function renderPicker(){
  const q = $('pickQ').value.trim().toLowerCase(); const rem = remaining(); const mode = (S.pickSort || 'color'); $('pickSort').value = mode;
  const list = deck.cards.filter(c => c.n !== E.CMD && rem[c.n] > 0 && nameHit(CARD()[c.n], q));
  const L = n => CARD()[n].land;
  const groups = new Map(); const add = (g, c) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c); };
  if (mode === 'color') {
    [...E.COLORS.split('').map(k => COLOR_NAME[k]), 'Multicolor', 'Colorless', 'Lands'].forEach(g => groups.set(g, []));
    for (const c of list) { if (L(c.n)) { add('Lands', c); continue; } const col = cardColors(c.n); add(col.length > 1 ? 'Multicolor' : col.length ? COLOR_NAME[col] : 'Colorless', c); }
    for (const [g, a] of groups) a.sort((x, y) => g === 'Lands' ? (cardColors(x.n).length - cardColors(y.n).length || cardColors(x.n).localeCompare(cardColors(y.n)) || x.n.localeCompare(y.n)) : (x.cmc - y.cmc || x.n.localeCompare(y.n)));
  } else if (mode === 'type') {
    ['Lands', 'Creatures', 'Instants', 'Sorceries', 'Artifacts', 'Enchantments', 'Planeswalkers', 'Other'].forEach(g => groups.set(g, []));
    for (const c of list) add(typeOf(c.n), c);
    for (const [, a] of groups) a.sort((x, y) => x.cmc - y.cmc || x.n.localeCompare(y.n));
  } else {
    for (const c of list.slice().sort((x, y) => L(x.n) - L(y.n) || x.cmc - y.cmc || x.n.localeCompare(y.n))) add(L(c.n) ? 'Lands' : 'Mana value ' + c.cmc, c);
  }
  const row = c => '<button data-add="' + esc(c.n) + '"><span>' + pipsHtml(c.n) + ' ' + rowLabel(c.n) + ((c.q || 1) > 1 ? ' <span class="small">×' + rem[c.n] + '</span>' : '') + '</span><span class="cost">' + esc(L(c.n) ? 'land' : (CARD()[c.n].mc || '—')) + '</span></button>';
  let html = ''; for (const [g, a] of groups) if (a.length) html += '<div class="grp">' + esc(g) + ' · ' + a.length + '</div>' + a.map(row).join('');
  $('picker').innerHTML = html || '<div class="grp">No match</div>';
}
function renderHand(){
  $('m-gold').setAttribute('aria-pressed', S.mode === 'gold'); $('m-real').setAttribute('aria-pressed', S.mode === 'real');
  $('d7').setAttribute('aria-pressed', !S.d14); $('d14').setAttribute('aria-pressed', S.d14);
  $('play').setAttribute('aria-pressed', S.onPlay); $('draw').setAttribute('aria-pressed', !S.onPlay);
  $('mullLine').textContent = 'Mulligans: ' + S.mull;
  $('dealBtn').hidden = S.mode !== 'gold';
  $('handCount').textContent = '(' + S.hand.length + ')';
  $('handChips').innerHTML = S.hand.length ? S.hand.map((n, i) => chip(n, 'data-hi="' + i + '"')).join('') : '<span class="empty">' + (S.mode === 'gold' ? 'Tap Deal 7 for a random hand, add cards below, or take a photo.' : 'Take a photo of the 7 cards you drew, or add them below.') + '</span>';
  renderPicker();
  if (!S.hand.length) { $('stamp').textContent = '—'; $('stamp').className = 'stamp'; $('cmdLine').textContent = 'Add your 7 cards'; $('why').innerHTML = ''; $('handPlan').innerHTML = ''; return; }
  const e = E.evaluate(S.hand); S.verdict = e.v; S.predicted = e.sol ? e.sol.turn : null;
  $('stamp').textContent = e.v; $('stamp').className = 'stamp ' + e.v;
  $('cmdLine').innerHTML = e.sol ? esc(E.CMD_SHORT) + ' on <span class="tn">turn ' + e.sol.turn + '</span>' : 'No ' + esc(E.CMD_SHORT) + ' by turn ' + E.solveHorizon() + ' yet';
  $('why').innerHTML = e.why.map(([c, t]) => '<li class="' + c + '">' + esc(t) + '</li>').join('');
  $('handPlan').innerHTML = planHtml(e.sol ? e.sol.log : [], 1);
}
function planHtml(log, now){
  if (!log.length) return '<li class="empty">No line found with these cards. Draw lands.</li>';
  const by = {}; log.forEach(x => (by[x.t] = by[x.t] || []).push(x.a));
  return Object.keys(by).map(t => '<li><span class="t' + (+t === now ? ' now' : '') + '">T' + t + '</span><div class="a">' + by[t].map(a => '<span>' + esc(a) + '</span>').join('') + '</div></li>').join('');
}
function cmdOut(){ return S.cmdTurn != null; }
// The solver's view of right now. Land drops used, mana already tapped and floating mana this turn
// come from S.ts (set by Apply and by playing a land by hand); treasure carries across turns.
function thisTurn(){ if (!S.ts || S.ts.turn !== S.turn) S.ts = {turn:S.turn, drops:0, float:0}; return S.ts; }
function turnState(){
  const s = E.startState(S.turn, S.bf.map(p => ({n:p.n, t:p.t, tapUntil:p.tapUntil, color:p.color, prepared:p.prepared})), S.hand);
  const ts = thisTurn(); s.drops = ts.drops || 0; s.float = ts.float || 0; s.treas = S.treas || 0;
  S.bf.forEach((p, i) => { if (p.spentTurn === S.turn) (p.spent || []).forEach(k => { s.used[k === '' ? 'p' + i : 'p' + i + '_' + k] = true; }); });
  return s;
}
function histHtml(){
  return S.turns.map(t => '<li><span class="t' + (t.turn === S.turn ? ' now' : '') + '">T' + t.turn + '</span><div class="a">' +
    (t.drew ? '<span class="small">drew ' + esc(short(t.drew)) + '</span>' : '') +
    (t.did.length ? t.did.map(a => '<span>' + esc(a) + '</span>').join('') : '<span class="small">' + (t.turn === S.turn ? 'nothing yet' : 'nothing') + '</span>') + '</div></li>').join('');
}
let currentPlan = null;
function renderTurn(){
  const C = E.CMD_SHORT, fail = E.P.failTurn || 4;
  $('tNum').textContent = S.turn || '—';
  const landsN = S.bf.filter(p => CARD()[p.n] && CARD()[p.n].land).length;
  $('tStatus').textContent = landsN + ' land' + (landsN === 1 ? '' : 's') + (cmdOut() ? ' · ' + C + ' out since T' + S.cmdTurn : ' · ' + C + ' in command zone');
  $('cmdToggle').textContent = C + (cmdOut() ? ': on battlefield' : ': in command zone');
  $('failBanner').textContent = 'Turn ' + fail + ' and no ' + C + ". That's a failed start. Log it from the Log tab.";
  $('failBanner').hidden = !(S.turn >= fail && !cmdOut());
  $('drawRow').hidden = !S.drawn; $('drawShow').innerHTML = S.drawn ? chip(S.drawn, 'data-shc="' + esc(S.drawn) + '"') : '';
  $('tHand').innerHTML = S.hand.length ? S.hand.map((n, i) => chip(n, 'data-th="' + i + '"')).join('') : '<span class="empty">Hand is empty.</span>';
  $('tBf').innerHTML = S.bf.length ? S.bf.map((p, i) => chip(p.n, 'data-tb="' + i + '"')).join('') : '<span class="empty">Nothing yet.</span>';
  if (!S.turn) { $('turnCmd').textContent = 'Keep a hand first.'; $('turnPlan').innerHTML = ''; $('tips').innerHTML = ''; $('tHist').innerHTML = ''; currentPlan = null; $('applyBtn').disabled = true; return; }
  if (cmdOut()) {
    currentPlan = null; $('turnCmd').textContent = E.P.engineTitle || (C + ' is out.');
    const steps = E.P.engine || ['Play your lands, then cast what advances the plan.'];
    $('turnPlan').innerHTML = '<li><span class="t now">T' + S.turn + '</span><div class="a">' + steps.map(s => '<span>' + esc(s) + '</span>').join('') + '</div></li>';
    $('applyBtn').disabled = true; $('applyBtn').textContent = C + ' is out: play by hand';
  } else {
    const sol = E.solve(turnState(), Math.max(6, S.turn + 4)); currentPlan = sol;
    const left = !!sol && sol.log.some(x => x.t === S.turn), acted = S.turns.length && S.turns[S.turns.length - 1].did.length;
    $('applyBtn').disabled = !left; $('applyBtn').textContent = left ? 'Did it: apply this turn' : (acted ? 'Turn ' + S.turn + ' done: End turn' : 'Nothing to do this turn');
    $('turnCmd').innerHTML = sol ? esc(C) + ' on <span class="tn">turn ' + sol.turn + '</span>' + (sol.turn === S.turn ? ', this turn' : '') + ' with what you have' : 'No ' + esc(C) + ' line yet: you need lands or a missing color';
    $('turnPlan').innerHTML = planHtml(sol ? sol.log : [], S.turn);
  }
  $('tHist').innerHTML = histHtml();
  $('tips').innerHTML = E.tips(S.hand, S.bf.map(p => p.n), cmdOut()).map(([c, t]) => '<li class="' + c + '">' + esc(t) + '</li>').join('') || '<li class="g">Nothing tricky this turn.</li>';
}
function render(){
  if (!deck) return;
  if (S.view === 'hand') renderHand();
  if (S.view === 'turn') renderTurn();
  if (S.view === 'log') renderLog();
  if (S.view === 'set') renderSettings();
  saveState();
}

/* ---------- hand interactions ---------- */
$('m-gold').onclick = () => { S.mode = 'gold'; render(); }; $('m-real').onclick = () => { S.mode = 'real'; render(); };
$('d7').onclick = () => { S.d14 = false; render(); }; $('d14').onclick = () => { S.d14 = true; render(); };
$('play').onclick = () => { S.onPlay = true; render(); }; $('draw').onclick = () => { S.onPlay = false; render(); };
$('dealBtn').onclick = () => { S.library = libraryFresh(); S.hand = S.library.splice(0, 7); S.bf = []; S.turn = 0; S.cmdTurn = null; render(); };
$('clearBtn').onclick = () => { S.hand = []; render(); };
$('pickQ').oninput = renderPicker;
$('pickSort').onchange = e => { S.pickSort = e.target.value; saveState(); renderPicker(); };
$('picker').onclick = e => { const b = e.target.closest('[data-add]'); if (!b) return; addToHand(b.dataset.add); };
$('basicBtns').onclick = e => { const b = e.target.closest('[data-basic]'); if (b) addToHand(b.dataset.basic); };
function addToHand(n){ S.hand.push(n); if (S.mode === 'gold' && S.library.length) { const i = S.library.indexOf(n); if (i >= 0) S.library.splice(i, 1); } render(); }
$('handChips').onclick = e => { const b = e.target.closest('[data-hi]'); if (!b) return; const n = S.hand[+b.dataset.hi]; openSheet(n, [['Remove from hand', () => { S.hand.splice(+b.dataset.hi, 1); if (S.mode === 'gold') S.library.push(n); render(); }]]); };
$('mullBtn').onclick = () => { S.mull++; if (S.mode === 'gold') { S.library = libraryFresh(); S.hand = S.library.splice(0, 7); } else S.hand = []; render(); };
$('keepBtn').onclick = () => {
  if (!S.hand.length) return; const e = E.evaluate(S.hand);
  S.opening = S.hand.slice(); S.verdict = e.v; S.predicted = e.sol ? e.sol.turn : null; S.turns = []; S.bf = []; S.cmdTurn = null; S.result = null; S.ts = null; S.treas = 0;
  if (S.mode === 'gold' && !S.library.length) { S.library = libraryFresh(); S.opening.forEach(n => { const i = S.library.indexOf(n); if (i >= 0) S.library.splice(i, 1); }); }
  startTurn(1); setView('turn');
};
function startTurn(t){
  S.turn = t; S.drawn = null;
  const draws = !(t === 1 && S.onPlay);
  if (draws && S.mode === 'gold' && S.library.length) { S.drawn = S.library.shift(); S.hand.push(S.drawn); }
  S.turns.push({turn:t, drew:S.drawn, did:[]});
  if (draws && S.mode === 'real') openDrawPicker();
}
function openDrawPicker(){
  const rem = remaining();
  const opts = deck.cards.filter(c => c.n !== E.CMD && rem[c.n] > 0);
  $('shName').textContent = 'What did you draw?'; $('shCost').textContent = 'Turn ' + S.turn;
  $('shOracle').innerHTML = '<input type="search" id="drawQ" placeholder="Card name" autocomplete="off"><div class="picker" id="drawList" style="margin-top:8px;max-height:200px"></div>';
  $('shActs').innerHTML = '<button class="btn ghost" id="noDraw">Skip</button>';
  $('sheet').hidden = false;
  const paint = () => { const q = $('drawQ').value.toLowerCase(); $('drawList').innerHTML = opts.filter(c => nameHit(CARD()[c.n], q)).slice(0, 40).map(c => '<button data-dr="' + esc(c.n) + '"><span>' + pipsHtml(c.n) + ' ' + rowLabel(c.n) + '</span><span class="cost">' + esc(CARD()[c.n].land ? 'land' : CARD()[c.n].mc) + '</span></button>').join(''); };
  paint(); $('drawQ').oninput = paint;
  $('drawList').onclick = e => { const b = e.target.closest('[data-dr]'); if (!b) return; S.drawn = b.dataset.dr; S.hand.push(S.drawn); S.turns[S.turns.length - 1].drew = S.drawn; closeSheet(); render(); };
  $('noDraw').onclick = () => { closeSheet(); render(); };
}

/* ---------- turn interactions ---------- */
$('applyBtn').onclick = () => {
  if (!currentPlan) return; let s = turnState();
  const target = currentPlan.log.filter(x => x.t === S.turn);
  for (const step of target) { const nxt = E.actions(s).find(n => n.log[n.log.length - 1].a === step.a); if (!nxt) break; s = nxt; if (step.cmd) S.cmdTurn = S.turn; }
  S.hand = s.hand.slice();
  const studious = Object.keys(E.RAMP).find(n => E.RAMP[n].kind === 'studious');
  const kept = [];
  s.bf.forEach((p, oi) => {   // carry "tapped for mana this turn" across the re-index that drops gone permanents
    if (p.gone) return; const spent = [];
    if (s.used['p' + oi]) spent.push(''); for (let k = 0; k < 4; k++) if (s.used['p' + oi + '_' + k]) spent.push(String(k));
    kept.push({n:p.n, t:p.t, tapUntil:p.tapUntil, color:p.color, prepared:p.n === studious && s.prepared, spent, spentTurn:S.turn});
  });
  // Cards that reached the battlefield from the library (fetchlands, Elder, Lore, Rampant copy) leave the Goldfish library.
  const count = a => a.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
  const was = count([...S.bf.map(p => p.n), ...S.hand]), now = count([...kept.map(p => p.n), ...s.hand]);
  const fetched = [];
  for (const n in now) for (let k = 0; k < now[n] - (was[n] || 0); k++) { fetched.push(n); const li = S.library.indexOf(n); if (li >= 0) S.library.splice(li, 1); }
  if (fetched.length) dbg('turn.fetch', {turn:S.turn, fetched, lib:S.library.length});
  S.bf = kept; S.ts = {turn:S.turn, drops:s.drops, float:s.float}; S.treas = s.treas;
  S.turns[S.turns.length - 1].did.push(...target.map(x => x.a));
  dbg('turn.apply', {turn:S.turn, did:target.map(x => x.a)});
  render();
};
$('endBtn').onclick = () => { if (!S.turn) return; dbg('turn.end', {turn:S.turn, did:S.turns.length ? S.turns[S.turns.length - 1].did : []}); startTurn(S.turn + 1); render(); };
$('cmdToggle').onclick = () => { S.cmdTurn = cmdOut() ? null : S.turn; render(); };
$('addBfBtns').onclick = e => { const b = e.target.closest('[data-addbf]'); if (!b) return; S.bf.push({n:b.dataset.addbf, t:S.turn, tapUntil:S.turn + 1}); render(); };
$('tHand').onclick = e => {
  const b = e.target.closest('[data-th]'); if (!b) return; const i = +b.dataset.th, n = S.hand[i];
  const isLand = CARD()[n].land;
  openSheet(n, [[isLand ? 'Play it' : 'Cast it', () => {
      S.hand.splice(i, 1); const m = E.LAND[n];
      const st = E.bfStats(S.bf.map(p => ({...p, land:!!E.LAND[p.n]})));
      const tapped = isLand && m ? E.tapRule(m, st) : false;
      if (isLand) thisTurn().drops++;
      if (isLand || E.RAMP[n] || /Creature|Artifact|Enchantment|Planeswalker|Battle/.test(CARD()[n].type)) S.bf.push({n, t:S.turn, tapUntil:tapped ? S.turn + 1 : 0, prepared:E.RAMP[n] && E.RAMP[n].kind === 'studious'});
      S.turns[S.turns.length - 1].did.push((isLand ? 'Play ' : 'Cast ') + short(n)); render(); }],
    ['Discard', () => { S.hand.splice(i, 1); S.turns[S.turns.length - 1].did.push('Discard ' + short(n)); render(); }]]);
};
$('tBf').onclick = e => {
  const b = e.target.closest('[data-tb]'); if (!b) return; const i = +b.dataset.tb, n = S.bf[i].n;
  openSheet(n, [['Remove (sacrificed or destroyed)', () => { S.bf.splice(i, 1); render(); }], ['Return to hand', () => { S.bf.splice(i, 1); S.hand.push(n); render(); }]]);
};
$('drawShow').onclick = e => { const b = e.target.closest('[data-shc]'); if (b) openSheet(b.dataset.shc, []); };

function openSheet(n, acts){
  const c = CARD()[n]; $('shName').textContent = short(n) + (c.printed ? ' · ' + c.printed : ''); $('shCost').textContent = c.land ? 'Land' : (c.mc || '');
  $('shOracle').textContent = c.o || '';
  sheetActs(acts);
}
function sheetActs(acts){
  $('shActs').innerHTML = acts.map((a, i) => '<button class="btn' + (i === 0 ? (a[2] || ' primary') : '') + '" data-act="' + i + '">' + esc(a[0]) + '</button>').join('') + '<button class="btn ghost" data-act="x">Close</button>';
  $('sheet').hidden = false; $('shActs').onclick = e => { const b = e.target.closest('[data-act]'); if (!b) return; closeSheet(); if (b.dataset.act !== 'x') acts[+b.dataset.act][1](); };
}
function closeSheet(){ $('sheet').hidden = true; }
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeCam(); } });

/* ---------- log ---------- */
const RESULTS = [['won', 'Won'], ['lost', 'Lost'], ['noclose', "Couldn't close"], ['failed', 'Failed start'], ['practice', 'Goldfish only']];
let games = [];
async function loadGames(){
  try { const g = await IDB.all('games', 'deck', deck.slug); return g.sort((a, b) => (b.when || '').localeCompare(a.when || '')); }
  catch (e) { return []; }
}
function renderLog(){
  const C = E.CMD_SHORT, fail = E.P.failTurn || 4;
  $('resChips').innerHTML = RESULTS.map(([k, l]) => '<button class="chip' + (S.result === k ? ' sel' : '') + '" data-res="' + k + '"><span class="nm">' + l + '</span></button>').join('');
  if (!$('fTurn').value && S.cmdTurn) $('fTurn').value = S.cmdTurn;
  const done = games.length;
  const ft = games.map(g => g.cmdTurn).filter(x => x);
  const avg = ft.length ? (ft.reduce((a, b) => a + b, 0) / ft.length).toFixed(1) : '—';
  const failed = games.filter(g => g.result === 'failed' || (!g.cmdTurn || g.cmdTurn > fail)).length;
  $('stats').innerHTML = '<div class="stat"><b>' + done + '</b><span>Hands logged</span></div><div class="stat"><b>' + avg + '</b><span>Avg ' + esc(C) + ' turn</span></div><div class="stat"><b>' + (done ? Math.round(failed / done * 100) + '%' : '—') + '</b><span>Failed starts</span></div>';
  $('games').innerHTML = games.length ? games.map(g => {
    const lbl = (RESULTS.find(r => r[0] === g.result) || [, g.result || '—'])[1];
    return '<li data-gid="' + g.id + '"><span class="res ' + esc(g.result || '') + '">' + esc(lbl) + ' · ' + (g.mode === 'real' ? 'Real' : 'Goldfish') + ' · ' + (g.draw14 ? 'Draw 14' : 'Draw 7') + '</span><span>' + esc(C) + ' T' + (g.cmdTurn || '—') + ' (predicted T' + (g.predicted || '—') + ') · ' + esc(g.verdict || '') + ' · ' + (g.mulligans || 0) + ' mull</span>' + (g.notes ? '<span class="small">' + esc(g.notes) + '</span>' : '') + '<span class="small">' + esc((g.when || '').slice(0, 16).replace('T', ' ')) + '</span></li>';
  }).join('') : '<li class="empty">Saved games show up here. Play a hand, then save it above.</li>';
  $('shareBtn').hidden = !(navigator.canShare && navigator.canShare({files:[new File(['{}'], 'x.json', {type:'application/json'})]}));
}
$('resChips').onclick = e => { const b = e.target.closest('[data-res]'); if (!b) return; S.result = b.dataset.res; render(); };
$('saveBtn').onclick = async () => {
  if (!S.opening) { $('saveMsg').textContent = 'Keep a hand first.'; return; }
  const cmdTurn = +$('fTurn').value || S.cmdTurn || null;
  const g = {deck:deck.slug, list:deck.list || '', when:new Date().toISOString(), mode:S.mode, draw14:S.d14, onPlay:S.onPlay, mulligans:S.mull,
    opening:S.opening, verdict:S.verdict, predicted:S.predicted, cmdTurn, result:S.result || (cmdTurn ? null : 'failed'),
    notes:$('notes').value.trim(), turns:S.turns, app:APP_VERSION};
  for (const f of logFields()) g[f.id] = +$('lf-' + f.id).value || null;
  $('saveBtn').disabled = true;
  try { await IDB.add('games', g); persist(); $('saveMsg').textContent = 'Saved.'; games = await loadGames(); resetGame(); }
  catch (err) { $('saveMsg').textContent = 'Could not save: ' + (err && err.message || 'storage error'); }
  $('saveBtn').disabled = false;
};
$('games').onclick = e => {
  const li = e.target.closest('[data-gid]'); if (!li) return; const g = games.find(x => String(x.id) === li.dataset.gid); if (!g) return;
  $('shName').textContent = (g.when || '').slice(0, 16).replace('T', ' '); $('shCost').textContent = g.result || '';
  $('shOracle').textContent = 'Opening: ' + (g.opening || []).map(short).join(', ') + '\n' + (g.turns || []).map(t => 'T' + t.turn + (t.drew ? ' drew ' + short(t.drew) : '') + (t.did && t.did.length ? ': ' + t.did.join('; ') : '')).join('\n');
  sheetActs([['Delete this game', async () => { await IDB.del('games', g.id); games = await loadGames(); renderLog(); }, ' danger']]);
};
function resetGame(){
  const keep = {mode:S.mode, d14:S.d14, onPlay:S.onPlay, pickSort:S.pickSort};
  S = Object.assign(fresh(), keep, {view:'log'});
  $('fTurn').value = ''; $('notes').value = ''; logFields().forEach(f => { $('lf-' + f.id).value = ''; });
  render();
}
function exportBlob(){
  const out = {format:'pilot-log/1', app:APP_VERSION, deck:deck.slug, deckName:deck.name, commander:E.CMD, list:deck.list || '', exported:new Date().toISOString(),
               games:games.slice().reverse().map(g => { const c = {...g}; delete c.id; return c; })};
  const name = deck.slug + '-games-' + new Date().toISOString().slice(0, 10) + '.json';
  return {name, blob:new Blob([JSON.stringify(out, null, 1)], {type:'application/json'})};
}
$('exportBtn').onclick = () => {
  const {name, blob} = exportBlob(); const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Exported ' + games.length + ' game' + (games.length === 1 ? '' : 's') + ' to ' + name);
};
$('shareBtn').onclick = async () => {
  const {name, blob} = exportBlob();
  try { await navigator.share({files:[new File([blob], name, {type:'application/json'})], title:name}); } catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message); }
};
$('importIn').onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); const list = Array.isArray(j) ? j : (j.games || []);
    const slug = (!Array.isArray(j) && j.deck) || deck.slug;
    const all = await IDB.all('games'); const have = new Set(all.map(g => g.deck + '|' + g.when));
    let n = 0; for (const g of list) { const r = {...g, deck:g.deck || slug}; delete r.id; if (r.flubsTurn != null && r.cmdTurn == null) r.cmdTurn = r.flubsTurn; if (have.has(r.deck + '|' + r.when)) continue; await IDB.add('games', r); n++; }
    games = await loadGames(); renderLog(); toast('Imported ' + n + ' game' + (n === 1 ? '' : 's') + (list.length - n ? ', skipped ' + (list.length - n) + ' already here' : '') + '.');
  } catch (err) { toast('Import failed: ' + err.message); }
};
function persist(){ try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {} }

/* ---------- Claude API ---------- */
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API = 'https://api.anthropic.com/v1/messages';
function apiKey(){ return LS.get('apiKey', ''); }
function model(){ return LS.get('model', '') || DEFAULT_MODEL; }
class ApiError extends Error { constructor(code, msg){ super(msg); this.code = code; } }
async function claudeFetch(body, signal){
  const key = apiKey(); if (!key) throw new ApiError('no_key', 'Add your Claude API key in Settings (Set, top right).');
  if (!navigator.onLine) throw new ApiError('offline', 'No connection. Claude needs the internet; everything else works offline.');
  let r;
  try {
    r = await fetch(API, {method:'POST', signal, headers:{'content-type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true'},
                         body:JSON.stringify(Object.assign({model:model()}, body))});
  } catch (e) { if (e.name === 'AbortError') throw new ApiError('cancelled', 'Stopped.'); throw new ApiError('network', 'Could not reach the Claude API. Check the connection.'); }
  if (!r.ok) {
    let msg = ''; try { const j = await r.json(); msg = j.error && j.error.message || ''; } catch (e) {}
    const by = {401:'The API key was rejected. Check it in Settings.', 403:'This key is not allowed to do that.', 404:'Model "' + model() + '" was not found. Check the model in Settings.',
                413:'The photo is too large.', 429:'Rate limited or out of credit. Try again in a minute.', 529:'Claude is overloaded right now. Try again shortly.'};
    throw new ApiError('http_' + r.status, (by[r.status] || 'Claude API error ' + r.status + '.') + (msg && !by[r.status] ? ' ' + msg : ''));
  }
  return r;
}
function bodySummary(b){ // what was sent, minus image bytes
  return {model:model(), max_tokens:b.max_tokens, stream:!!b.stream, system:b.system ? String(b.system).slice(0, 300) : undefined,
    content:(b.messages || []).map(m => typeof m.content === 'string' ? m.content.slice(0, 1500) : m.content.map(c => c.type === 'image' ? '[image ' + Math.round(c.source.data.length * 0.75 / 1024) + ' KB]' : String(c.text).slice(0, 1500)))};
}
async function claudeMsg(body, signal){
  const t0 = Date.now(); let r;
  try { r = await claudeFetch(body, signal); }
  catch (e) { dbg('api.error', {req:bodySummary(body), code:e.code, msg:e.message, ms:Date.now() - t0}); throw e; }
  const j = await r.json();
  const out = {text:(j.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), stop:j.stop_reason || '', types:(j.content || []).map(b => b.type).join(','), usage:j.usage || null, model:j.model || ''};
  dbg('api', {req:bodySummary(body), ms:Date.now() - t0, model:out.model, stop:out.stop, usage:out.usage, text:out.text.slice(0, 4000)});
  return out;
}
async function claudeText(body, signal){ return (await claudeMsg(body, signal)).text; }
// Streams a reply. onText(text) on every text chunk; onStatus(kind) on other activity ('thinking', 'bytes').
// Aborts if no bytes arrive for idleMs. Returns {text, stop, events} and never leaves the caller waiting forever.
async function claudeStream(body, onText, signal, onStatus, idleMs){
  idleMs = idleMs || 45000;
  const ctl = new AbortController(); const fwd = () => ctl.abort(); if (signal) signal.addEventListener('abort', fwd);
  let idle = setTimeout(() => ctl.abort('idle'), idleMs); const kick = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort('idle'), idleMs); };
  const t0 = Date.now(); const events = {}; let stop = '', text = '';
  dbg('api.stream.start', {req:bodySummary(body)});
  try {
    let r; try { r = await claudeFetch(Object.assign({}, body, {stream:true}), ctl.signal); }
    catch (e) { if (ctl.signal.reason === 'idle') throw new ApiError('timeout', 'No reply from Claude after ' + Math.round(idleMs / 1000) + ' s. Check signal, then Ask again.'); throw e; }
    const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const {done, value} = await rd.read(); if (done) break;
      kick(); onStatus && onStatus('bytes');
      buf += dec.decode(value, {stream:true});
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of ev.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let d; try { d = JSON.parse(line.slice(5)); } catch (e) { continue; }
          const k = d.type + (d.delta && d.delta.type ? ':' + d.delta.type : ''); events[k] = (events[k] || 0) + 1;
          if (d.type === 'content_block_delta' && d.delta && d.delta.type === 'text_delta') { text += d.delta.text; onText(text); }
          else if (d.type === 'content_block_delta' && d.delta && /thinking/.test(d.delta.type)) onStatus && onStatus('thinking');
          else if (d.type === 'message_delta' && d.delta && d.delta.stop_reason) stop = d.delta.stop_reason;
          else if (d.type === 'error') throw new ApiError('stream', (d.error && d.error.message) || 'Stream error.');
        }
      }
    }
  } catch (e) {
    dbg('api.stream.error', {msg:e.message, code:e.code, reason:String(ctl.signal.reason || ''), ms:Date.now() - t0, events, partial:text.slice(0, 500)});
    if (e instanceof ApiError) throw e;
    if (ctl.signal.reason === 'idle') throw new ApiError('timeout', 'Claude stopped sending after ' + Math.round(idleMs / 1000) + ' s. Check signal, then Ask again.');
    if (e.name === 'AbortError' || ctl.signal.aborted) throw new ApiError('cancelled', 'Stopped.');
    throw new ApiError('network', 'The connection dropped mid-answer. Ask again.');
  } finally { clearTimeout(idle); if (signal) signal.removeEventListener('abort', fwd); }
  dbg('api.stream', {req:bodySummary(body), ms:Date.now() - t0, stop, events, text:text.slice(0, 4000)});
  return {text, stop, events};
}

/* ---------- photo: identify the hand ----------
   Claude reports what it READS per card (title, credit line, best guess). The app does the matching:
   real name, short name, printed (proxy) name, profile aliases, names you taught it, then fuzzy. */
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
function learned(){ return deck ? LS.get('alias.' + deck.slug, {}) : {}; }
function learn(text, card){ const k = norm(text); if (!k || !deck) return; const m = learned(); m[k] = card; LS.set('alias.' + deck.slug, m); dbg('alias.learn', {text, card}); }
function bigrams(s){ const o = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); o.set(g, (o.get(g) || 0) + 1); } return o; }
function dice(a, b){ if (a.length < 2 || b.length < 2) return a === b ? 1 : 0; const A = bigrams(a), B = bigrams(b); let n = 0; for (const [g, c] of A) n += Math.min(c, B.get(g) || 0); return 2 * n / (a.length - 1 + b.length - 1); }
function nameKeys(n){ const c = CARD()[n]; return [n, n.split(' // ')[0], short(n), c.printed, ...(c.aka || [])].filter(Boolean).map(norm); }
function matchName(raw, fuzzy){
  const t = norm(raw); if (!t || t.length < 2) return null;
  const names = Object.keys(CARD()).filter(n => n !== E.CMD);
  const L = learned(); if (L[t] && CARD()[L[t]]) return L[t];
  let hit = names.find(n => nameKeys(n).includes(t)); if (hit) return hit;
  if (t.length >= 5) { hit = names.find(n => nameKeys(n).some(k => k.startsWith(t) || (t.startsWith(k) && k.length >= 5))); if (hit) return hit; }
  if (fuzzy === false) return null;
  let best = null, bs = 0; for (const n of names) for (const k of nameKeys(n)) { const d = dice(t, k); if (d > bs) { bs = d; best = n; } }
  return bs >= 0.78 ? best : null;
}
function resolveEntry(e){
  for (const pass of [false, true]) for (const f of ['title', 'credit', 'guess']) { const n = matchName(e[f], pass); if (n) return n; }
  return null;
}
async function loadBitmap(blob){ return createImageBitmap(blob); }
function cropJpeg(bmp, sx, sy, sw, sh, max){
  const k = Math.min(1, max / Math.max(sw, sh));
  const c = document.createElement('canvas'); c.width = Math.round(sw * k); c.height = Math.round(sh * k);
  c.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85); return {data:url.slice(url.indexOf(',') + 1), w:c.width, h:c.height};
}
// Image 1 = whole photo at 1568 px. Photos larger than that also get two overlapping halves along the long side.
async function makeTiles(blob){
  const bmp = await loadBitmap(blob); const W = bmp.width, H = bmp.height; const tiles = [cropJpeg(bmp, 0, 0, W, H, 1568)];
  if (Math.max(W, H) > 1900) {
    const ov = 0.12;
    if (W >= H) { const w = Math.round(W * (0.5 + ov / 2)); tiles.push(cropJpeg(bmp, 0, 0, w, H, 1568), cropJpeg(bmp, W - w, 0, w, H, 1568)); }
    else { const h = Math.round(H * (0.5 + ov / 2)); tiles.push(cropJpeg(bmp, 0, 0, W, h, 1568), cropJpeg(bmp, 0, H - h, W, h, 1568)); }
  }
  if (bmp.close) bmp.close();
  return {tiles, src:{w:W, h:H, type:blob.type, kb:Math.round(blob.size / 1024)}, split:W >= H ? 'left/right' : 'top/bottom'};
}
function photoPrompt(nTiles, split){
  const lines = deck.cards.filter(c => c.n !== E.CMD).map(c => (c.printed ? c.printed + ' = ' + c.n : c.n) + ((c.aka || []).length ? '  (also written: ' + c.aka.join(', ') + ')' : ''));
  const imgs = nTiles > 1 ? 'Image 1 is a photo of my Magic: The Gathering hand. Images 2 and 3 are zoomed crops of the ' + split + ' halves of the SAME photo, for reading small text only. Never count a card twice.\n\n'
                          : 'This is a photo of my Magic: The Gathering hand.\n\n';
  return imgs +
    'Some cards are custom proxies: the big title is a custom name, and the real card name may be printed small in the credit line at the bottom. Cards may overlap; read whatever part of the title shows.\n\n' +
    'First count the physical cards in the hand. Then, for each card in order (left to right, or top to bottom), report what you can actually read:\n' +
    '- "title": the title text as printed, exact spelling, even if it is a custom name ("" if hidden)\n' +
    '- "credit": the small credit-line text if legible, else ""\n' +
    '- "guess": the card from the list below you think it is, or "" if unsure\n' +
    'Duplicates such as basic lands get one entry each.\n\n' +
    'Cards in this deck (custom name = real name where they differ):\n' + lines.join('\n') +
    '\n\nReply with only this JSON and nothing else:\n{"count": 7, "cards": [{"title": "", "credit": "", "guess": ""}]}';
}
// Accepts {"count","cards":[...]}, a bare array of objects, or a bare array of names.
function parseRead(text){
  const t = String(text || '').replace(/[“”„″]/g, '"').replace(/[‘’]/g, "'").replace(/```(?:json)?/g, '');
  const tryJ = s => { try { return JSON.parse(s); } catch (e) { return undefined; } };
  let j = tryJ(t.trim());
  if (j === undefined) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) j = tryJ(t.slice(a, b + 1)); }
  if (j === undefined) { const a = t.indexOf('['), b = t.lastIndexOf(']'); if (a >= 0 && b > a) j = tryJ(t.slice(a, b + 1)); }
  let arr = j && !Array.isArray(j) ? (j.cards || j.hand || null) : j;
  const count = j && !Array.isArray(j) && Number.isFinite(+j.count) ? +j.count : null;
  if (Array.isArray(arr)) return {count, cards:arr.map(x => typeof x === 'string' ? {title:x, credit:'', guess:''} : {title:x.title || x.name || '', credit:x.credit || '', guess:x.guess || x.card || ''})};
  // last resort: quoted strings or lines that name a deck card
  const q = [...t.matchAll(/"([^"\n]{2,80})"/g)].map(m => m[1]).filter(s => matchName(s, false));
  const lines = q.length ? q : t.split(/\n|,/).map(s => s.replace(/^[\s\-*•\d.)]+/, '').replace(/[*_`]/g, '').trim()).filter(s => s && matchName(s, false));
  return lines.length ? {count:null, cards:lines.map(s => ({title:s, credit:'', guess:''}))} : null;
}
let photoEntries = [], lastReply = '';
async function readPhoto(f){
  if (!f) return;
  $('photoBox').hidden = false; $('photoChips').innerHTML = ''; $('photoActs').innerHTML = ''; $('photoRead').hidden = true; $('photoMsg').textContent = 'Reading the cards…';
  let shot = null;
  try {
    shot = await makeTiles(f);
    const prompt = photoPrompt(shot.tiles.length, shot.split);
    const content = [...shot.tiles.map(x => ({type:'image', source:{type:'base64', media_type:'image/jpeg', data:x.data}})), {type:'text', text:prompt}];
    const r = await claudeMsg({max_tokens:2000, messages:[{role:'user', content}]});
    lastReply = r.text;
    const read = parseRead(r.text);
    const rec = {k:'lastPhoto', when:new Date().toISOString(), deck:deck.slug, src:shot.src, tiles:shot.tiles.map(x => ({w:x.w, h:x.h, data:x.data})), prompt, reply:r.text, stop:r.stop, usage:r.usage, model:r.model};
    if (!read) { await IDB.put('kv', rec).catch(() => {}); throw new ApiError('parse', 'The reply could not be read as a card list (stop: ' + (r.stop || '?') + '). Reply starts: "' + (r.text.trim().slice(0, 160) || '(empty)') + '"'); }
    photoEntries = read.cards.map(e => Object.assign(e, {card:resolveEntry(e)}));
    rec.count = read.count; rec.entries = photoEntries; await IDB.put('kv', rec).catch(() => {});
    dbg('photo', {src:shot.src, tiles:shot.tiles.map(x => x.w + 'x' + x.h), count:read.count, entries:photoEntries, stop:r.stop, usage:r.usage});
    paintPhoto(read.count);
    $('photoActs').innerHTML = '<button class="btn primary" id="pfUse">Use as my hand</button><button class="btn" id="pfAdd">Add to hand</button><button class="btn ghost" id="pfShow">What Claude read</button><button class="btn ghost" id="pfX">Discard</button>';
    $('pfUse').onclick = () => { S.hand = photoCards(); if (S.mode === 'gold') { S.library = libraryFresh(); S.hand.forEach(n => { const i = S.library.indexOf(n); if (i >= 0) S.library.splice(i, 1); }); } $('photoBox').hidden = true; render(); };
    $('pfAdd').onclick = () => { photoCards().forEach(n => addToHand(n)); $('photoBox').hidden = true; render(); };
    $('pfShow').onclick = () => { $('photoRead').hidden = !$('photoRead').hidden; };
    $('pfX').onclick = () => { $('photoBox').hidden = true; };
  } catch (err) {
    dbg('photo.fail', {code:err.code, msg:err.message, src:shot && shot.src});
    $('photoMsg').textContent = err.message || 'Something went wrong. Try again.';
    $('photoActs').innerHTML = '<button class="btn ghost" id="pfX">Close</button>' + (err.code === 'no_key' ? '<button class="btn" id="pfSet">Open Settings</button>' : '<button class="btn" id="pfBug">Report bug</button>');
    $('pfX').onclick = () => { $('photoBox').hidden = true; };
    if ($('pfSet')) $('pfSet').onclick = () => setView('set');
    if ($('pfBug')) $('pfBug').onclick = () => openBug('Photo read failed: ' + (err.message || ''));
  }
}
const photoCards = () => photoEntries.filter(e => e.card).map(e => e.card);
function paintPhoto(count){
  const m = photoEntries.filter(e => e.card).length, u = photoEntries.length - m;
  $('photoMsg').textContent = (count != null ? 'Claude counted ' + count + ' card' + (count === 1 ? '' : 's') + '. ' : '') + 'Matched ' + m + (u ? '; ' + u + ' need a tap (dashed)' : '') + '. Tap any card to fix it.';
  $('photoChips').innerHTML = photoEntries.map((e, i) => e.card ? chip(e.card, 'data-pf="' + i + '"')
    : '<button class="chip unk" data-pf="' + i + '"><span class="nm">? ' + esc(e.title || e.credit || e.guess || 'unreadable') + '</span></button>').join('');
  $('photoRead').innerHTML = '<table><tr><th>#</th><th>Title read</th><th>Credit</th><th>Guess</th><th>Matched</th></tr>' + photoEntries.map((e, i) =>
    '<tr><td>' + (i + 1) + '</td><td>' + esc(e.title) + '</td><td>' + esc(e.credit) + '</td><td>' + esc(e.guess) + '</td><td>' + (e.card ? esc(short(e.card)) : '—') + '</td></tr>').join('') + '</table>';
}
$('photoChips').onclick = e => {
  const b = e.target.closest('[data-pf]'); if (!b) return; const i = +b.dataset.pf, en = photoEntries[i];
  const seen = en.title || en.credit || en.guess || '';
  const assign = () => openCardPicker('Which card is "' + (seen || 'this') + '"?', n => { en.card = n; if (seen) learn(en.title || en.credit, n); paintPhoto(null); });
  if (en.card) { openSheet(en.card, [['Wrong card: change it', assign], ['Remove', () => { photoEntries.splice(i, 1); paintPhoto(null); }, ' ghost']]); $('shCost').textContent = seen ? 'read as "' + seen + '"' : ''; }
  else assign();
};
function openCardPicker(title, cb){
  const opts = deck.cards.filter(c => c.n !== E.CMD);
  $('shName').textContent = title; $('shCost').textContent = '';
  $('shOracle').innerHTML = '<input type="search" id="cpQ" placeholder="Card or proxy name" autocomplete="off"><div class="picker" id="cpList" style="margin-top:8px;max-height:240px"></div>';
  $('shActs').innerHTML = '<button class="btn ghost" id="cpX">Cancel</button>'; $('sheet').hidden = false;
  const paint = () => { const q = $('cpQ').value.toLowerCase(); $('cpList').innerHTML = opts.filter(c => nameHit(CARD()[c.n], q)).slice(0, 60).map(c => '<button data-cp="' + esc(c.n) + '"><span>' + pipsHtml(c.n) + ' ' + rowLabel(c.n) + '</span><span class="cost">' + esc(CARD()[c.n].land ? 'land' : CARD()[c.n].mc) + '</span></button>').join(''); };
  paint(); $('cpQ').oninput = paint;
  $('cpList').onclick = e => { const b = e.target.closest('[data-cp]'); if (!b) return; closeSheet(); cb(b.dataset.cp); };
  $('cpX').onclick = closeSheet;
}
['snapIn', 'fileIn'].forEach(id => $(id).onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) readPhoto(f); });
['snapLbl', 'fileLbl'].forEach(id => $(id).onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(id === 'snapLbl' ? 'snapIn' : 'fileIn').click(); } });
document.addEventListener('paste', e => {
  if (!deck || S.view !== 'hand') return;
  const it = [...(e.clipboardData && e.clipboardData.items || [])].find(i => i.type.startsWith('image/')); if (!it) return;
  e.preventDefault(); readPhoto(it.getAsFile());
});

/* ---------- bug report ----------
   Bundles: your note, app/deck/version info, the current game, the last 150 log lines (API calls,
   errors, photo reads) and, if ticked, the last photo exactly as sent. Never the API key. */
async function buildBug(note, withPhoto){
  const last = await IDB.get('kv', 'lastPhoto').catch(() => null);
  let est = null; try { est = await navigator.storage.estimate(); } catch (e) {}
  return JSON.parse(scrub(JSON.stringify({
    format:'pilot-bug/1', created:new Date().toISOString(), note, app:APP_VERSION,
    ua:navigator.userAgent, standalone:matchMedia('(display-mode: standalone)').matches, online:navigator.onLine,
    sw:!!(navigator.serviceWorker && navigator.serviceWorker.controller), screen:{w:innerWidth, h:innerHeight, dpr:devicePixelRatio},
    storage:est && {usageKB:Math.round(est.usage / 1024), quotaMB:Math.round(est.quota / 1048576)},
    settings:{model:model(), keySet:!!apiKey()},
    deck:deck ? {slug:deck.slug, name:deck.name, list:deck.list, built:deck.built, cards:deck.cards.length, printed:deck.cards.filter(c => c.printed).length} : null,
    learnedAliases:learned(), view:S && S.view, state:S, lastPhoto:last ? (withPhoto ? last : Object.assign({}, last, {tiles:last.tiles.map(x => ({w:x.w, h:x.h}))})) : null,
    log:DBG.buf,
  })));
}
function bugName(b){ return 'pilot-bug-' + b.created.slice(0, 16).replace(/[-:]/g, '').replace('T', '-') + '.json'; }
async function shareOrDownload(name, text){
  const file = new File([text], name, {type:'application/json'});
  if (navigator.canShare && navigator.canShare({files:[file]})) {
    try { await navigator.share({files:[file], title:name}); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000); return 'downloaded';
}
function openBug(prefill){
  dbg('bug.open', {view:S && S.view});
  $('shName').textContent = 'Report a bug'; $('shCost').textContent = 'v' + APP_VERSION;
  $('shOracle').innerHTML = '<textarea id="bugNote" placeholder="What did you do, what happened, what did you expect?"></textarea>' +
    '<label class="small" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="bugPhoto" checked> Include the last photo sent to Claude</label>' +
    '<p class="small" style="margin:8px 0 0">Saved on this phone, then the share sheet opens. Send the file to Claude. Never contains your API key.</p>';
  $('bugNote').value = prefill || '';
  $('shActs').innerHTML = '<button class="btn primary" id="bugGo">Save and share</button><button class="btn ghost" id="bugX">Cancel</button>'; $('sheet').hidden = false;
  $('bugX').onclick = closeSheet;
  $('bugGo').onclick = async () => {
    $('bugGo').disabled = true;
    try {
      const b = await buildBug($('bugNote').value.trim(), $('bugPhoto').checked);
      const text = JSON.stringify(b, null, 1);
      try { await IDB.add('bugs', {created:b.created, note:b.note, app:b.app, name:bugName(b), kb:Math.round(text.length / 1024), text});
        const all = await IDB.all('bugs'); for (const old of all.slice(0, Math.max(0, all.length - 10))) await IDB.del('bugs', old.id); } catch (e) { dbg('bug.save.fail', e.message); }
      closeSheet(); const how = await shareOrDownload(bugName(b), text);
      toast('Bug report saved' + (how === 'downloaded' ? ' and downloaded.' : how === 'shared' ? ' and shared.' : '. Share it later from Set.'));
      if (S && S.view === 'set') renderSettings();
    } catch (err) { toast('Could not build the report: ' + err.message); $('bugGo').disabled = false; }
  };
}
$('bugBtn').onclick = () => openBug('');
$('bugBtn2').onclick = () => openBug('');
async function renderBugs(){
  const all = (await IDB.all('bugs').catch(() => [])).reverse();
  $('bugList').innerHTML = all.length ? all.map(b => '<div class="row" style="justify-content:space-between"><span class="small">' + esc(b.created.slice(0, 16).replace('T', ' ')) + ' · ' + b.kb + ' KB' + (b.note ? ' · ' + esc(b.note.slice(0, 40)) : '') + '</span><span class="row"><button class="btn" data-bshare="' + b.id + '">Share</button><button class="btn ghost" data-bdel="' + b.id + '">Delete</button></span></div>').join('') : '<p class="small">None saved. Tap Bug at the top to make one.</p>';
}
$('bugList').onclick = async e => {
  const s = e.target.closest('[data-bshare]'), d = e.target.closest('[data-bdel]');
  if (s) { const b = await IDB.get('bugs', +s.dataset.bshare); if (b) await shareOrDownload(b.name, b.text); }
  if (d) { await IDB.del('bugs', +d.dataset.bdel); renderBugs(); }
};

/* live camera preview */
let camStream = null;
$('camBtn').onclick = async () => {
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { $('snapIn').click(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({audio:false, video:{facingMode:{ideal:'environment'}, width:{ideal:2560}, height:{ideal:1440}}});
  } catch (e) { toast(e.name === 'NotAllowedError' ? 'Camera blocked. Allow it in Chrome site settings, or use Photo.' : 'Camera not available: ' + e.message); return; }
  const v = $('camVideo'); v.srcObject = camStream; $('cam').hidden = false;
  try { await v.play(); } catch (e) {}
};
function closeCam(){ if (camStream) camStream.getTracks().forEach(t => t.stop()); camStream = null; $('camVideo').srcObject = null; $('cam').hidden = true; }
$('camClose').onclick = closeCam;
$('camSnap').onclick = () => {
  const v = $('camVideo'); if (!v.videoWidth) return;
  const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
  closeCam(); c.toBlob(b => readPhoto(b), 'image/jpeg', 0.92);
};

/* ---------- Ask ---------- */
let askCtl = null;
$('askStop').onclick = () => askCtl && askCtl.abort();
function cardBlock(names){
  return [...new Set(names)].map(n => { const c = CARD()[n]; if (!c || E.isBasic(n)) return null; return '- ' + n + (c.printed ? ' (printed as ' + c.printed + ')' : '') + ' ' + (c.mc || '') + ' — ' + c.type + ': ' + (c.o || '').replace(/\n+/g, ' '); }).filter(Boolean).join('\n');
}
function systemPrompt(){
  const cmd = CARD()[E.CMD];
  const head = 'Commander deck "' + deck.name + '". Real commander: ' + E.CMD + (cmd.printed ? ' (printed as ' + cmd.printed + ')' : '') + ', colors ' + (E.COLORS || 'colorless') + '.\nCommander text: ' + (cmd.o || '').replace(/\n+/g, ' ');
  const list = deck.cards.filter(c => c.n !== E.CMD).map(c => (c.q > 1 ? c.q + ' ' : '') + c.n + (c.printed ? ' [' + c.printed + ']' : '')).join('; ');
  return head +
    (E.P.strategy ? '\n\nStrategy:\n' + E.P.strategy : '') +
    (deck.brief ? '\n\nPilot brief (from ' + (deck.briefSource || 'the deck folder') + '):\n' + deck.brief : '') +
    '\n\nFull decklist (real name [printed proxy name]): ' + list +
    '\n\nYou help me pilot this deck at the table, in a casual Commander pod. Be direct and brief: the play first, then one or two reasons. ' +
    'Card rules must be exact: use the card text in my message; for cards not given, say if you are unsure. ' +
    'Use only what I tell you about opponents; ask for the one missing fact that would change the play instead of assuming it.';
}
$('askBtn').onclick = async () => {
  const q = $('askQ').value.trim(); if (!q) return;
  askCtl = new AbortController(); $('askBtn').disabled = true; $('askStop').hidden = false;
  const C = E.CMD_SHORT;
  const plan = currentPlan ? currentPlan.log.map(x => 'T' + x.t + ': ' + x.a).join('; ') : (cmdOut() ? C + ' is on the battlefield.' : 'none found');
  const state = 'Turn ' + S.turn + '. ' + C + ' ' + (cmdOut() ? 'on the battlefield since turn ' + S.cmdTurn : 'in the command zone') + '.\n' +
    'Hand: ' + (S.hand.map(short).join(', ') || 'empty') + '\nMy battlefield: ' + (S.bf.map(p => short(p.n)).join(', ') || 'nothing') + '\nSuggested line from the app: ' + plan;
  const cards = cardBlock([E.CMD, ...S.hand, ...S.bf.map(p => p.n)]);
  const msg = 'Current state:\n' + state + '\n\nCard text for everything above:\n' + cards + '\n\nMy question: ' + q;
  // live status until text arrives: elapsed seconds, and whether Claude is reasoning or we are still waiting
  const t0 = Date.now(); let got = false, mode = 'Sending…';
  const tick = () => { if (!got) $('askOut').textContent = mode + ' ' + Math.round((Date.now() - t0) / 1000) + ' s'; };
  tick(); const timer = setInterval(tick, 1000);
  const cap = setTimeout(() => askCtl.abort(), 150000);   // hard stop after 150 s whatever happens
  try {
    const r = await claudeStream({max_tokens:4000, system:systemPrompt(), messages:[{role:'user', content:msg}]},
      t => { got = true; $('askOut').textContent = t; },
      askCtl.signal, k => { if (k === 'thinking') mode = 'Claude is reasoning…'; else if (mode === 'Sending…') mode = 'Waiting for the answer…'; });
    if (!r.text.trim()) { got = true; $('askOut').textContent = 'Claude finished without an answer (stop: ' + (r.stop || 'unknown') + '). Ask again, or tap Bug so I can see why.'; }
    else if (r.stop === 'max_tokens') $('askOut').textContent += '\n\n(cut off: answer hit the length limit)';
  } catch (err) {
    got = true; const had = $('askOut').textContent;
    const partial = /^(Sending|Waiting|Claude is reasoning)/.test(had) ? '' : had + '\n\n';
    $('askOut').textContent = err.code === 'cancelled' ? (partial ? had + '\n\n(stopped)' : 'Stopped.') : partial + err.message;
  }
  clearInterval(timer); clearTimeout(cap);
  $('askBtn').disabled = false; $('askStop').hidden = true;
};

/* ---------- settings ---------- */
function renderSettings(){
  renderDeckSel();
  const all = [...bundled.map(b => ({slug:b.slug, name:b.name, list:b.list, src:'bundled'})), ...userDecks.filter(u => !bundled.some(b => b.slug === u.slug)).map(u => ({slug:u.slug, name:u.name, list:u.list, src:'loaded'}))];
  // a loaded deck with a bundled slug overrides the bundled one
  $('deckList').innerHTML = all.map(d => { const over = d.src === 'bundled' && userDecks.some(u => u.slug === d.slug);
    return '<label><input type="radio" name="deck" value="' + esc(d.slug) + '"' + (deck && deck.slug === d.slug ? ' checked' : '') + '><span class="grow"><b>' + esc(d.name) + '</b><br><span class="small">' + esc((d.list ? d.list + ' list · ' : '') + (over || d.src === 'loaded' ? 'loaded file' : 'bundled')) + '</span></span>' +
      (over || d.src === 'loaded' ? '<button class="btn ghost" data-rmdeck="' + esc(d.slug) + '">Remove</button>' : '') + '</label>'; }).join('');
  $('keyIn').value = apiKey(); $('modelIn').value = model(); renderBugs();
  $('aboutLine').textContent = 'App ' + APP_VERSION + ' · ' + (navigator.serviceWorker && navigator.serviceWorker.controller ? 'works offline' : 'offline cache not active yet') + ' · ' + (matchMedia('(display-mode: standalone)').matches ? 'installed' : 'in browser') + (deck ? ' · deck built ' + (deck.built || '?') : '');
}
$('deckList').onchange = async e => {
  if (e.target.name !== 'deck') return;
  try { await switchDeck(e.target.value); $('deckMsg').textContent = 'Switched to ' + deck.name + '.'; render(); }
  catch (err) { $('deckMsg').textContent = err.message; }
};
$('deckList').onclick = async e => {
  const b = e.target.closest('[data-rmdeck]'); if (!b) return; e.preventDefault();
  await IDB.del('decks', b.dataset.rmdeck); userDecks = await IDB.all('decks');
  if (deck.slug === b.dataset.rmdeck) { const first = (bundled[0] || userDecks[0] || {}).slug; if (first) await switchDeck(first); }
  render();
};
$('deckIn').onchange = async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = E.normalizeDeck(JSON.parse(await f.text()));
    await IDB.put('decks', {slug:d.slug, name:d.name, list:d.list || '', data:d}); userDecks = await IDB.all('decks');
    await switchDeck(d.slug); $('deckMsg').textContent = 'Loaded ' + d.name + ' (' + d.cards.reduce((a, c) => a + (c.q || 1), 0) + ' cards).'; render();
  } catch (err) { $('deckMsg').textContent = 'Could not load that file: ' + err.message; }
};
$('keyShow').onclick = () => { const i = $('keyIn'); i.type = i.type === 'password' ? 'text' : 'password'; $('keyShow').textContent = i.type === 'password' ? 'Show' : 'Hide'; };
$('keySave').onclick = () => { LS.set('apiKey', $('keyIn').value.trim()); LS.set('model', $('modelIn').value.trim()); $('keyMsg').textContent = 'Saved on this phone.'; };
$('keyClear').onclick = () => { LS.del('apiKey'); $('keyIn').value = ''; $('keyMsg').textContent = 'Key removed.'; };
$('keyTest').onclick = async () => {
  LS.set('apiKey', $('keyIn').value.trim()); LS.set('model', $('modelIn').value.trim());
  $('keyMsg').textContent = 'Testing…';
  try { const t = await claudeText({max_tokens:8, messages:[{role:'user', content:'Reply with the single word OK.'}]}); $('keyMsg').textContent = 'Works. ' + model() + ' replied: ' + t.trim().slice(0, 20); }
  catch (err) { $('keyMsg').textContent = err.message; }
};

/* ---------- reset ---------- */
let resetTimer = null;
$('resetBtn').onclick = () => {
  const b = $('resetBtn');
  if (!b.classList.contains('arm')) { b.classList.add('arm'); b.textContent = 'Tap again'; resetTimer = setTimeout(() => { b.classList.remove('arm'); b.textContent = 'Reset'; }, 3000); return; }
  clearTimeout(resetTimer); b.classList.remove('arm'); b.textContent = 'Reset';
  const keep = {mode:S.mode, d14:S.d14, onPlay:S.onPlay, pickSort:S.pickSort};
  S = Object.assign(fresh(), keep, {view:'hand'});
  ['fTurn', 'notes', 'askQ', 'pickQ'].forEach(id => { $(id).value = ''; }); logFields().forEach(f => { $('lf-' + f.id).value = ''; });
  $('askOut').textContent = ''; $('photoBox').hidden = true; $('saveMsg').textContent = ''; closeSheet();
  setView('hand');
};

/* ---------- toast + service worker ---------- */
let toastTimer = null;
function toast(msg, btn, fn){
  $('toastMsg').textContent = msg; $('toast').hidden = false;
  $('toastBtn').hidden = !btn; if (btn) { $('toastBtn').textContent = btn; $('toastBtn').onclick = fn; }
  clearTimeout(toastTimer); if (!btn) toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = w => toast('Update ready.', 'Reload', () => w.postMessage('skipWaiting'));
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => { const w = reg.installing; w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); }); });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloaded) return; reloaded = true; saveState(); location.reload(); });
}

/* ---------- boot ---------- */
(async () => {
  try {
    await IDB.open();
    await loadBundledIndex();
    userDecks = await IDB.all('decks');
    const want = LS.get('deck', null);
    const slugs = [...userDecks.map(d => d.slug), ...bundled.map(d => d.slug)];
    if (!slugs.length) throw new Error('No decks found. Load a deck JSON in Settings.');
    await switchDeck(slugs.includes(want) ? want : (bundled[0] || userDecks[0]).slug);
    $('bootMsg').hidden = true;
    setView(S.view && VIEWS.includes(S.view) ? S.view : 'hand');
  } catch (err) {
    $('bootText').textContent = 'Could not start: ' + err.message;
    S = S || fresh();
  }
  registerSW();
})();
