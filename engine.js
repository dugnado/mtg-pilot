/* Pilot engine: deck models, mana payment, earliest-commander solver, keep rule.
   Ported from flubs-pilot-app-v6-src.html. Pure functions over module state; no DOM.
   A deck's profile (lands, ramp, cheapMana, short) makes it exact; without one,
   land and rock/dork models are derived from oracle text. */
(function (root) {
'use strict';
const BASIC_COLOR = {Plains:'W', Island:'U', Swamp:'B', Mountain:'R', Forest:'G'};
const E = {CARD:{}, LAND:{}, RAMP:{}, CHEAP:new Set(), COLORS:'', ANY:'', BASIC_LIST:[], CMD:'', CMD_SHORT:'', CMD_COST:null, P:{}, SHORT:{}, DECK:null};

/* ---------- deck loading ---------- */
function normalizeDeck(d){
  // Accepts pilot-deck/1 objects or a raw array of {q,n,mc,cmc,t,o,tag} rows.
  if (Array.isArray(d)) {
    const cmd = (d.find(c => /Legendary/.test(c.t||'') && /Creature|can be your commander/.test((c.t||'')+(c.o||''))) || d[0]);
    d = {format:'pilot-deck/1', slug:slugify(cmd.n), name:cmd.n, commander:cmd.n, list:'', cards:d};
  }
  if (!d || !Array.isArray(d.cards) || !d.cards.length) throw new Error('No cards in that file.');
  if (!d.commander) throw new Error('The deck file has no commander.');
  if (!d.cards.some(c => c.n === d.commander)) throw new Error('Commander '+d.commander+' is not in the card list.');
  d.slug = d.slug || slugify(d.commander);
  d.name = d.name || d.commander;
  return d;
}
function slugify(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''); }
function frontType(t){ return String(t||'').split(' // ')[0]; }

function loadDeck(d){
  d = normalizeDeck(d);
  const P = d.profile || {};
  E.DECK = d; E.P = P; E.CARD = {}; E.LAND = {}; E.RAMP = {}; E.SHORT = P.short || {};
  for (const c of d.cards) {
    const t = c.t || '';
    E.CARD[c.n] = {n:c.n, q:c.q||1, mc:c.mc||'', cmc:+c.cmc||0, land:c.land!=null ? !!c.land : /Land/.test(frontType(t)),
                   type:t, o:c.o||'', printed:c.printed||'', aka:c.aka||[], prod:c.prod, tag:c.tag||''};
  }
  E.CMD = d.commander;
  const cmdShown = (E.CARD[E.CMD] && E.CARD[E.CMD].printed) || E.CMD;   // proxy decks go by the printed commander (Bran, Bertha)
  E.CMD_SHORT = P.commanderShort || cmdShown.split(' // ')[0].split(',')[0].split(' the ')[0];
  E.BASIC_LIST = d.cards.filter(c => BASIC_COLOR[c.n]).map(c => c.n);
  // colour order: basics in deck order, then the rest of the identity in WUBRG order
  let cols = E.BASIC_LIST.map(n => BASIC_COLOR[n]).join('');
  let ci = d.ci;
  if (!ci) { const s = new Set(); for (const c of d.cards) for (const k of 'WUBRG') if ((c.mc||'').includes('{'+k)) s.add(k); ci = 'WUBRG'.split('').filter(k => s.has(k)).join(''); }
  for (const k of 'WUBRG') if (ci.includes(k) && !cols.includes(k)) cols += k;
  E.COLORS = cols; E.ANY = cols;
  if (!E.BASIC_LIST.length) E.BASIC_LIST = cols.split('').map(k => Object.keys(BASIC_COLOR).find(b => BASIC_COLOR[b] === k));
  // land models
  for (const n of Object.keys(E.CARD)) {
    const c = E.CARD[n]; if (!c.land) continue;
    E.LAND[n] = (P.lands && P.lands[n]) ? Object.assign({}, P.lands[n]) : deriveLand(c);
  }
  for (const b of E.BASIC_LIST) if (!E.LAND[b]) E.LAND[b] = {c:BASIC_COLOR[b]};
  // ramp models
  if (P.ramp) for (const n of Object.keys(P.ramp)) if (E.CARD[n]) E.RAMP[n] = Object.assign({}, P.ramp[n]);
  if (P.autoRamp !== false) for (const n of Object.keys(E.CARD)) if (!E.RAMP[n] && n !== E.CMD) { const r = deriveRamp(E.CARD[n]); if (r) E.RAMP[n] = r; }
  E.CHEAP = new Set(P.cheapMana || Object.keys(E.RAMP).filter(n => E.CARD[n] && E.CARD[n].cmc <= 2));
  E.CMD_COST = parseCost(E.CARD[E.CMD].mc);
  return d;
}

function colorsOf(prod, text){
  let s = '';
  if (/any color|any one color|mana of any type/i.test(text||'')) s = E.ANY;
  else for (const k of E.COLORS) if ((prod||'').includes(k)) s += k;
  if (!s && prod == null) { // no produced_mana field: read "Add {X}" from text
    const add = (text||'').match(/Add ([^.]+)\./); if (add) for (const k of E.COLORS) if (add[1].includes('{'+k+'}')) s += k;
    if (!s && add && /\{C\}/.test(add[1])) s = 'C';
  }
  if (!s && /C/.test(prod||'')) s = 'C';
  return s;
}
function deriveLand(c){
  const o = c.o || '', m = {};
  m.c = colorsOf(c.prod, o);
  const sub = (frontType(c.type).split('—')[1] || '');
  const types = Object.keys(BASIC_COLOR).filter(b => sub.includes(b));
  if (types.length) m.types = types;
  const f = o.match(/Sacrifice[^:]*: Search your library for (an? [^.]*?) card[^.]*\.([^.]*\.)?/i);
  if (f) {
    m.fetch = true;
    const named = Object.keys(BASIC_COLOR).filter(b => f[1].includes(b) && E.BASIC_LIST.includes(b));
    if (named.length) m.fetchTo = named;
    m.fetchTapped = /tapped/i.test(f[0]);
    if (!/\{T\}: Add/.test(o)) m.c = '';
  }
  if (/enters (the battlefield )?tapped/i.test(o)) {
    const u = o.match(/tapped unless you control an? ([A-Z]\w+)(?: or an? ([A-Z]\w+))?/);
    if (/you may pay \d+ life/i.test(o)) m.tap = false;                  // shockland: pay
    else if (u && BASIC_COLOR[u[1]]) m.tap = {unless:[u[1], u[2]].filter(Boolean)};   // checkland
    else m.tap = !/unless/i.test(o);                                       // other "unless": assume untapped
  }
  return m;
}
function deriveRamp(c){
  if (c.land) return null;
  const o = c.o || ''; const m = o.match(/(\{\d+\}, )?\{T\}(?:, [^:]*)?: Add ([^.]+)\./); if (!m || /Sacrifice/.test(m[0])) return null;
  let n = /\bor\b|one mana/i.test(m[2]) ? 1 : Math.max(1, (m[2].match(/\{[WUBRGC]\}/g) || []).length || (/two mana/i.test(m[2]) ? 2 : 1));
  if (m[1]) n = Math.max(1, n - +m[1].match(/\d+/)[0]);   // signets: {1}, {T}: Add {B}{R} nets one
  const col = colorsOf(c.prod, m[0]) || 'C';
  if (/Creature/.test(c.type)) return {cost:c.mc, kind:'dork', c:col, n:1};
  if (/Artifact/.test(c.type)) return {cost:c.mc, kind:'rock', c:col, n};
  return null;
}

/* ---------- costs and names ---------- */
function parseCost(s){
  const o = {W:0,U:0,B:0,R:0,G:0,gen:0};
  String(s||'').split(' // ')[0].replace(/\{([^}]+)\}/g, (m, x) => {
    if (o[x] != null && x !== 'gen') o[x]++;
    else if (/^\d+$/.test(x)) o.gen += +x;
    else if (/\//.test(x)) o.gen++;      // hybrid / phyrexian: count as generic
    else if (x === 'C') o.gen++;
  });
  return o;
}
function short(n){
  if (E.SHORT[n]) return E.SHORT[n];
  if (n === E.CMD) return E.CMD_SHORT;
  return String(n).split(' // ')[0];
}
function isBasic(n){ return !!BASIC_COLOR[n]; }

/* ---------- mana payment ---------- */
function canPay(cost, units){ // units: [{id,c}] ; returns ids used or null
  const pips = []; for (const k of E.COLORS + 'WUBRG') { if (pips.some(p => p === k) ) continue; for (let i = 0; i < (cost[k]||0); i++) pips.push(k); }
  const order = units.slice().sort((a, b) => a.c.length - b.c.length);
  const used = new Set();
  function bt(i){
    if (i === pips.length) {
      let need = cost.gen; const ids = [];
      for (const u of order) { if (need <= 0) break; if (!used.has(u.id)) { ids.push(u.id); need--; } }
      if (need > 0) return null; return [...used, ...ids];
    }
    const p = pips[i]; const tried = new Set();
    for (const u of order) { if (used.has(u.id) || !u.c.includes(p) || tried.has(u.c)) continue; tried.add(u.c);
      used.add(u.id); const r = bt(i + 1); if (r) return r; used.delete(u.id); }
    return null;
  }
  return bt(0);
}

/* ---------- solver: earliest commander with known cards only ---------- */
function tapRule(m, st){
  const t = m && m.tap;
  if (!t) return false; if (t === true) return true;
  if (t.basicsLt != null) return st.basics < t.basicsLt;
  if (t.unless) return !t.unless.some(x => st.types[x]);
  return false;
}
function bfStats(bf){
  const s = {basics:0, types:{}};
  for (const p of bf) { if (!p.land || p.gone) continue;
    if (isBasic(p.n)) { s.basics++; s.types[p.n] = 1; }
    const m = E.LAND[p.n]; if (m && m.types) for (const t of m.types) s.types[t] = 1; }
  return s;
}
function mkPerm(n, turn, extra){ return Object.assign({n, land:!!E.LAND[n], t:turn}, extra || {}); }
function unitsOf(st){
  const u = [];
  st.bf.forEach((p, i) => {
    if (p.gone) return;
    if (p.land) { if (st.used['p'+i] || p.tapUntil > st.turn) return; const c = p.color || (E.LAND[p.n] && E.LAND[p.n].c); if (!c) return; u.push({id:'p'+i, c}); return; }
    const r = E.RAMP[p.n]; if (!r) return;
    if (r.kind === 'rock') { for (let k = 0; k < (r.n||1); k++) if (!st.used['p'+i+'_'+k]) u.push({id:'p'+i+'_'+k, c:r.c}); }
    if (r.kind === 'dork' && p.t < st.turn && !st.used['p'+i]) u.push({id:'p'+i, c:r.c});
  });
  for (let i = 0; i < st.float; i++) u.push({id:'f'+i, c:E.ANY});
  for (let i = 0; i < st.treas; i++) u.push({id:'t'+i, c:E.ANY});
  return u;
}
function clone(st){ return {turn:st.turn, bf:st.bf.map(p => ({...p})), hand:st.hand.slice(), used:{...st.used}, float:st.float, treas:st.treas, drops:st.drops, prepared:st.prepared, log:st.log.slice()}; }
function spend(st, ids){
  const s = clone(st); let f = 0, t = 0;
  for (const id of ids) { if (id[0] === 'f') f++; else if (id[0] === 't') t++; else s.used[id] = true; }
  s.float -= f; s.treas -= t; return s;
}
function landfall(s){ for (const p of s.bf) { if (p.gone) continue; const r = E.RAMP[p.n]; if (!r) continue; if (r.kind === 'cobra') s.float++; if (r.kind === 'prov') s.treas++; } }
function enterLand(s, n, how, tapped, color){
  const st = bfStats(s.bf); const m = E.LAND[n] || {c:BASIC_COLOR[n]};
  const isTapped = tapped != null ? tapped : tapRule(m, st);
  s.bf.push(mkPerm(n, s.turn, {land:true, tapUntil:isTapped ? s.turn + 1 : 0, color}));
  landfall(s);
}
function stateKey(s){
  const bf = s.bf.map((p, i) => p.gone ? '' : p.n + (p.color||'') + (p.tapUntil > s.turn ? 'T' : '') + (s.used['p'+i] || s.used['p'+i+'_0'] ? 'u' : '') + (s.used['p'+i+'_1'] ? 'v' : '') + (p.t === s.turn ? 'n' : '')).filter(Boolean).sort().join('|');
  return s.turn + '#' + bf + '#' + s.hand.slice().sort().join('|') + '#' + s.float + s.treas + s.drops + (s.prepared ? 1 : 0);
}
const CAST_CMD = () => 'Cast ' + E.CMD_SHORT;
function landDrops(){ return E.P.landDrops || 1; }
function actions(s){
  const out = []; const units = unitsOf(s);
  const cmdPay = canPay(E.CMD_COST, units);
  if (cmdPay) { const n = spend(s, cmdPay); n.log.push({t:s.turn, a:CAST_CMD(), cmd:true}); n.flubs = true; out.push(n); }
  const landsInHand = [...new Set(s.hand.filter(n => E.CARD[n] && E.CARD[n].land))];
  if (s.drops < landDrops()) {
    for (const n of landsInHand) {
      const m = E.LAND[n]; const colors = m && m.thr ? E.COLORS.split('').filter(c => c !== m.c) : [null];
      for (const ch of colors) { const x = clone(s); x.hand.splice(x.hand.indexOf(n), 1); x.drops++; enterLand(x, n, 'play', null, ch ? m.c + ch : undefined);
        const last = x.bf[x.bf.length - 1]; x.log.push({t:s.turn, a:'Play ' + short(n) + (ch ? ' (choose ' + ch + ')' : '') + (last.tapUntil > s.turn ? ' — enters tapped' : '')}); out.push(x); }
    }
  }
  s.bf.forEach((p, i) => {
    if (p.gone || s.used['p'+i]) return;
    const fetchKinds = [];
    const lm = E.LAND[p.n];
    if (p.land && lm && lm.fetch && p.tapUntil <= s.turn) fetchKinds.push('land');
    const r = E.RAMP[p.n];
    if (r && r.kind === 'ste') fetchKinds.push('STE');
    for (const k of fetchKinds) {
      const tapped = !(k === 'land' && lm.fetchTapped === false);
      for (const b of ((k === 'land' && lm.fetchTo) || E.BASIC_LIST)) {
        const x = clone(s); x.bf[i].gone = true; x.used['p'+i] = true; enterLand(x, b, 'fetch', tapped);
        x.log.push({t:s.turn, a:'Sacrifice ' + short(p.n) + ' → ' + b + (tapped ? ' (tapped)' : '')}); out.push(x);
      }
    }
    if (r && r.kind === 'putter' && p.t < s.turn) for (const n of landsInHand) {
      const x = clone(s); x.used['p'+i] = true; x.hand.splice(x.hand.indexOf(n), 1); enterLand(x, n, 'put');
      x.log.push({t:s.turn, a:'Tap ' + short(p.n) + ': put ' + short(n) + ' onto the battlefield'}); out.push(x);
    }
  });
  if (s.prepared) {
    const stud = Object.keys(E.RAMP).find(n => E.RAMP[n].kind === 'studious');
    const pay = canPay(parseCost((stud && E.RAMP[stud].copyCost) || '{1}{G}'), units);
    if (pay) for (const b of E.BASIC_LIST) { const x = spend(s, pay); x.prepared = false; enterLand(x, b, 'fetch', true); x.log.push({t:s.turn, a:'Cast the Rampant Growth copy → ' + b + ' (tapped)'}); out.push(x); }
  }
  for (const n of [...new Set(s.hand)]) {
    const r = E.RAMP[n]; if (!r) continue;
    const pay = canPay(parseCost(r.cost != null ? r.cost : E.CARD[n].mc), units); if (!pay) continue;
    const base = () => { const x = spend(s, pay); x.hand.splice(x.hand.indexOf(n), 1); return x; };
    if (r.mox) { const lands = [...new Set(s.hand.filter(c => c !== n && E.CARD[c] && E.CARD[c].land))];
      for (const l of lands) { const x = base(); x.hand.splice(x.hand.indexOf(l), 1); x.bf.push(mkPerm(n, s.turn)); x.log.push({t:s.turn, a:'Cast ' + short(n) + ', discard ' + short(l)}); out.push(x); } continue; }
    if (r.kind === 'lore') { for (const f of (r.fetch || E.BASIC_LIST)) { const x = base(); enterLand(x, f, 'fetch', isBasic(f) ? false : null); const last = x.bf[x.bf.length - 1]; x.log.push({t:s.turn, a:'Cast ' + short(n) + ' → ' + f + (last.tapUntil > s.turn ? ' (tapped)' : ' (untapped)')}); out.push(x); } continue; }
    if (r.kind === 'spiral') { const x = base(); x.log.push({t:s.turn, a:'Cast ' + short(n) + ' (draw a card)'}); const ls = [...new Set(x.hand.filter(c => E.CARD[c] && E.CARD[c].land))];
      if (!ls.length) { out.push(x); continue; } for (const l of ls) { const y = clone(x); y.hand.splice(y.hand.indexOf(l), 1); enterLand(y, l, 'put'); y.log[y.log.length - 1] = {t:s.turn, a:'Cast ' + short(n) + ': put ' + short(l) + ' onto the battlefield, draw'}; out.push(y); } continue; }
    if (r.kind === 'studious') { const x = base(); x.bf.push(mkPerm(n, s.turn)); x.prepared = true; x.log.push({t:s.turn, a:'Cast ' + short(n) + ' (Rampant Growth copy ready)'}); out.push(x); continue; }
    const x = base(); x.bf.push(mkPerm(n, s.turn)); x.log.push({t:s.turn, a:'Cast ' + short(n)}); out.push(x);
  }
  return out;
}
function endTurn(s){ const x = clone(s); x.turn++; x.used = {}; x.float = 0; x.drops = 0; return x; }
function leftover(s){ return unitsOf(s).length; }
function score(s){
  let lands = 0, cols = new Set(), rocks = 0;
  for (const p of s.bf) { if (p.gone) continue;
    if (p.land) { lands++; for (const c of (p.color || (E.LAND[p.n] && E.LAND[p.n].c) || '')) cols.add(c); }
    else if (E.RAMP[p.n] && ['rock', 'dork'].includes(E.RAMP[p.n].kind)) { rocks++; E.ANY.split('').forEach(c => cols.add(c)); } }
  return lands * 3 + rocks * 3 + [...cols].filter(c => c !== 'C').length * 4 + (s.prepared ? 2 : 0) + s.treas * 2;
}
function solve(start, maxTurn){
  maxTurn = maxTurn || 6; let frontier = [start]; let best = null;
  for (let turn = start.turn; turn <= maxTurn; turn++) {
    const seen = new Map(); const q = frontier.slice(); const ends = []; let count = 0;
    while (q.length && count < 6000) {
      const s = q.pop(); count++;
      const k = stateKey(s); if (seen.has(k)) continue; seen.set(k, 1);
      ends.push(s);
      for (const n of actions(s)) {
        if (n.flubs) { const sc = leftover(n); if (!best || n.turn < best.turn || (n.turn === best.turn && sc > best.score)) best = {turn:n.turn, log:n.log, score:sc}; continue; }
        q.push(n);
      }
    }
    if (best) return best;
    const nxt = new Map();
    ends.sort((a, b) => score(b) - score(a));
    for (const e of ends.slice(0, 300)) { const n = endTurn(e); const k = stateKey(n); if (!nxt.has(k)) nxt.set(k, n); }
    frontier = [...nxt.values()];
  }
  return null;
}
function startState(turn, bfNames, hand){
  const s = {turn, bf:[], hand:hand.slice(), used:{}, float:0, treas:0, drops:0, prepared:false, log:[]};
  for (const b of bfNames) { const n = typeof b === 'string' ? b : b.n;
    s.bf.push(mkPerm(n, typeof b === 'string' ? 0 : (b.t || 0), {land:!!(E.LAND[n]), tapUntil:typeof b === 'object' && b.tapUntil || 0, color:typeof b === 'object' ? b.color : undefined}));
    if (typeof b === 'object' && b.prepared) s.prepared = true; }
  return s;
}

/* ---------- keep rule (pilot card, draw-7) ---------- */
// How far the opening-hand solver looks: turn 5 for a 3-drop commander (v6), one turn past the commander's cost otherwise.
function solveHorizon(){ const cmc = E.CARD[E.CMD] ? E.CARD[E.CMD].cmc : 3; return E.P.solveTurns || Math.max(5, Math.ceil(cmc) + 1); }
function evaluate(hand){
  const CARD = E.CARD, LAND = E.LAND, RAMP = E.RAMP;
  const lands = hand.filter(n => CARD[n].land); const L = lands.length;
  const mana = hand.filter(n => E.CHEAP.has(n)); const M = mana.length;
  const big = hand.filter(n => !CARD[n].land && CARD[n].cmc >= 5);
  const fetchCols = m => m.fetchTo ? m.fetchTo.map(b => BASIC_COLOR[b]).join('') : E.ANY;
  const landCols = new Set(); lands.forEach(n => { const m = LAND[n]; (m ? (m.c||'') + (m.thr ? E.ANY : '') + (m.fetch ? fetchCols(m) : '') : '').split('').forEach(c => { if (c !== 'C') landCols.add(c); }); });
  const action = hand.filter(n => !CARD[n].land && CARD[n].cmc <= 3).length;
  const why = []; let v;
  const horizon = solveHorizon();
  const sol = solve(startState(1, [], hand), horizon);
  const C = E.CMD_SHORT;
  if (L <= 1) { v = 'SHIP'; why.push(['bad', L + ' land' + (L === 1 ? '' : 's') + '. Ship it.']); }
  else if (L === 2 && M === 0) { v = 'SHIP'; why.push(['bad', '2 lands and no cheap mana piece.']); }
  else if (L >= 5 && action === 0) { v = 'SHIP'; why.push(['bad', L + ' lands and nothing to do.']); }
  else if (big.length >= 2 && M === 0) { v = 'SHIP'; why.push(['bad', 'Two 5+ drops (' + big.map(short).join(', ') + ') with no ramp.']); }
  else if (L >= 3 && L <= 4 && landCols.size >= 2) { v = 'KEEP'; why.push(['good', L + ' lands covering ' + [...landCols].join('/') + '.']); }
  else if (L === 2 && M >= 1) { v = 'KEEP'; why.push(['good', '2 lands plus ' + mana.map(short).join(', ') + '.']); }
  else { v = 'CLOSE'; why.push(['', L + ' lands, ' + M + ' cheap mana. Borderline by the rule.']); }
  if (M && v !== 'SHIP' && !(L === 2)) why.push(['good', 'Cheap mana: ' + mana.map(short).join(', ') + '.']);
  if (big.length && v !== 'SHIP') why.push(['', big.length + ' card' + (big.length > 1 ? 's' : '') + ' at 5+: ' + big.map(short).join(', ') + '.']);
  for (const n of hand) { const r = RAMP[n]; if (r && r.kind === 'lore') for (const f of (r.fetch || E.BASIC_LIST)) for (const c of ((LAND[f] && LAND[f].c) || '')) if (c !== 'C') landCols.add(c); }
  const miss = E.COLORS.split('').filter(c => !landCols.has(c) && !hand.some(n => RAMP[n] && RAMP[n].c === E.ANY) && !hand.some(n => RAMP[n] && ['ste', 'studious'].includes(RAMP[n].kind)));
  if (miss.length && L > 0) why.push(['bad', 'No ' + miss.join('/') + ' source yet.']);
  if (sol) { if (sol.turn <= 3) why.push(['good', C + ' on turn ' + sol.turn + ' with no help from draws.']); else why.push(['', C + ' on turn ' + sol.turn + ' without draws: you need a land draw to get there sooner.']); if (v === 'CLOSE' && sol.turn <= 3) v = 'KEEP'; }
  else why.push(['bad', 'No ' + C + ' by turn ' + horizon + ' from these cards alone.']);
  const notes = E.P.handNotes || {};
  for (const n of Object.keys(notes)) if (hand.includes(n)) why.push(['', notes[n]]);
  return {v, why, sol, L, M};
}

/* ---------- turn reminders from profile data ---------- */
function tips(hand, bfNames, cmdOut){
  const out = [];
  const any = (x, arr) => (Array.isArray(x) ? x : [x]).some(n => arr.includes(n));
  for (const tp of (E.P.tips || [])) {
    const c = tp.if || {};
    if (c.cmd != null && c.cmd !== cmdOut) continue;
    if (c.hand && !any(c.hand, hand)) continue;
    if (c.bf && !any(c.bf, bfNames)) continue;
    if (c.handType && !hand.some(n => E.CARD[n] && new RegExp(c.handType).test(E.CARD[n].type))) continue;
    out.push([tp.c || '', tp.t]);
  }
  return out;
}

Object.assign(E, {BASIC_COLOR, solveHorizon, normalizeDeck, loadDeck, parseCost, short, isBasic, canPay, bfStats, tapRule, actions, solve, startState, evaluate, tips, slugify});
root.Engine = E;
})(typeof window !== 'undefined' ? window : globalThis);
