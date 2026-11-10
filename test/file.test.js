import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionError, MODE } from '../src/session/session.js';
import { serializeFile, parseFile, fileName, MAX_FILE_BYTES } from '../src/session/file.js';
import { createStore, STORAGE_KEY } from '../src/session/storage.js';

const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof SessionError, String(e)); return e.code; }
  return null;
};
function board(n = 3, seed = 424242) {
  const s = new Session({ boardName: 'Workshop åäö', ownerName: 'Hemligt Alias', seed });
  for (let i = 1; i <= n; i++) {
    s.addNote('p1', { title: `Lapp ${i}`, description: i === 1 ? 'Med "citat" & <b>' : '', category: i === 2 ? 'Teknik' : '', color: i === 1 ? 'blue' : '' });
  }
  return s;
}
const valid = () => JSON.parse(serializeFile(board(3)));
const text = (o) => JSON.stringify(o);

// ---- Spara (KR-31) ----

test('boardfil innehåller namn och lappar med versionsfält, men inget resultat', () => {
  const o = JSON.parse(serializeFile(board(3)));
  assert.equal(o.app, 'bubble');
  assert.equal(o.v, 1);
  assert.equal(o.typ, 'board');
  assert.equal(o.namn, 'Workshop åäö');
  assert.equal(o.lappar.length, 3);
  assert.deepEqual(o.lappar[0], { id: 1, t: 'Lapp 1', b: 'Med "citat" & <b>', f: 'blue' });
  assert.equal('resultat' in o, false);
});

test('resultatfil efter avslut har rangordning, manuell ordning och preliminärmarkering', () => {
  const s = board(3);
  s.start('p1');
  s.answer('left'); s.answer('left');
  s.finish('p1');
  s.startManualFromAuto('p1');
  s.moveNote('p1', s.manualOrder[0], 'down');
  const o = JSON.parse(serializeFile(s));
  assert.equal(o.typ, 'resultat');
  assert.equal(o.resultat.rang.length, 3);
  assert.equal(o.resultat.preliminar, true);
  assert.equal(o.resultat.manuell.length, 3);
  assert.ok(o.resultat.rang.every((r) => ['id', 'plats', 'delad', 'p', 'v', 'f', 'l'].every((k) => k in r)));
});

test('filen innehåller aldrig individuella val, alias, seed eller hemligheter (KR-31, AT-17)', () => {
  const s = board(3, 424242);
  s.start('p1');
  s.answer('left'); s.answer('right'); s.answer('equal');
  s.finish('p1');
  for (const out of [serializeFile(board(3, 424242)), serializeFile(s)]) {
    for (const forbidden of ['Hemligt Alias', '424242', 'seed', 'outcome', 'history', 'queue', 'p1', 'secret', 'token', 'owner', 'hemlighet', 'nyckel', 'sessionskod']) {
      assert.equal(out.toLowerCase().includes(forbidden.toLowerCase()), false, `fil innehåller "${forbidden}"`);
    }
  }
});

test('filnamn rensas från otillåtna tecken och görs aldrig tomt', () => {
  assert.equal(fileName('Plan: 2026/Q1?'), 'Plan 2026 Q1.json');
  assert.equal(fileName('***'), 'board.json');
  assert.ok(fileName('x'.repeat(500)).length <= 65);
});

// ---- Läs in och validera ----

test('rundtur: board sparas och läses in med samma innehåll', () => {
  const s = board(4);
  const f = parseFile(serializeFile(s));
  assert.equal(f.typ, 'board');
  assert.equal(f.boardName, s.boardName);
  assert.deepEqual(f.notes.map((n) => [n.title, n.description, n.category, n.color]),
    s.notes.map((n) => [n.title, n.description, n.category, n.color]));
  assert.equal(f.resultat, null);
});

test('rundtur: resultat läses in skrivskyddat med samma ordning och poäng', () => {
  const s = board(3);
  s.start('p1');
  while (s.currentPair()) s.answer('left');
  s.finish('p1');
  s.startManualFromAuto('p1');
  const f = parseFile(serializeFile(s));
  assert.equal(f.typ, 'resultat');
  assert.equal(f.resultat.preliminar, false);
  assert.deepEqual(f.resultat.rang.map((r) => r.p), s.autoRanking().map((r) => r.points));
  assert.equal(f.resultat.manuell.length, 3);
});

test('25 lappar går att spara och läsa in, 26 avvisas (OQ-71, OQ-72)', () => {
  assert.equal(parseFile(serializeFile(board(25))).notes.length, 25);
  const o = valid();
  o.lappar = Array.from({ length: 26 }, (_, i) => ({ id: i + 1, t: `L${i}` }));
  assert.equal(code(() => parseFile(text(o))), 'FILE_TOO_MANY_NOTES');
  o.lappar = o.lappar.slice(0, 1);
  assert.equal(code(() => parseFile(text(o))), 'MIN_NOTES');
});

test('trasig, fel typ och okänd version ger begripliga felkoder (NFR-9)', () => {
  assert.equal(code(() => parseFile('{ inte json')), 'FILE_INVALID');
  assert.equal(code(() => parseFile('')), 'FILE_INVALID');
  assert.equal(code(() => parseFile('[]')), 'FILE_INVALID');
  assert.equal(code(() => parseFile('null')), 'FILE_INVALID');
  assert.equal(code(() => parseFile(42)), 'FILE_INVALID');
  const wrongApp = valid(); wrongApp.app = 'annan';
  assert.equal(code(() => parseFile(text(wrongApp))), 'FILE_INVALID');
  const v2 = valid(); v2.v = 2;
  assert.equal(code(() => parseFile(text(v2))), 'FILE_VERSION');
  const noV = valid(); delete noV.v;
  assert.equal(code(() => parseFile(text(noV))), 'FILE_INVALID');
  const typ = valid(); typ.typ = 'sparad-session';
  assert.equal(code(() => parseFile(text(typ))), 'FILE_INVALID');
});

test('för stor fil avvisas innan den tolkas, mätt i byte', () => {
  assert.equal(code(() => parseFile(' '.repeat(MAX_FILE_BYTES + 1))), 'FILE_TOO_LARGE');
  assert.equal(code(() => parseFile('å'.repeat(MAX_FILE_BYTES / 2 + 1))), 'FILE_TOO_LARGE');
});

test('lappar valideras mot OQ-33: längder, tom titel, färg och typ', () => {
  const bad = (mutate) => { const o = valid(); mutate(o); return code(() => parseFile(text(o))); };
  assert.equal(bad((o) => { o.lappar[0].t = 'x'.repeat(101); }), 'TITLE_TOO_LONG');
  assert.equal(bad((o) => { o.lappar[0].t = '   '; }), 'TITLE_EMPTY');
  assert.equal(bad((o) => { delete o.lappar[0].t; }), 'TITLE_EMPTY');
  assert.equal(bad((o) => { o.lappar[0].b = 'x'.repeat(501); }), 'DESCRIPTION_TOO_LONG');
  assert.equal(bad((o) => { o.lappar[0].k = 'x'.repeat(31); }), 'CATEGORY_TOO_LONG');
  assert.equal(bad((o) => { o.lappar[0].f = '#ff0000'; }), 'COLOR_INVALID');
  assert.equal(bad((o) => { o.lappar[0].t = 5; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.lappar[1].id = o.lappar[0].id; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.lappar[0].id = '1'; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.lappar[0].id = -1; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.lappar = {}; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.lappar[0] = null; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.namn = ''; }), 'BOARD_NAME_EMPTY');
  assert.equal(bad((o) => { o.namn = 'x'.repeat(101); }), 'BOARD_NAME_TOO_LONG');
  assert.equal(bad((o) => { o.namn = 7; }), 'BOARD_NAME_EMPTY');
});

test('okända fält ignoreras och __proto__ ger ingen prototypförorening', () => {
  const polluted = '{"app":"bubble","v":1,"typ":"board","namn":"X","extra":{"a":1},"__proto__":{"polluted":true},"lappar":[{"id":1,"t":"A","__proto__":{"polluted":true},"okänd":1},{"id":2,"t":"B"}]}';
  const f = parseFile(polluted);
  assert.equal(f.notes.length, 2);
  assert.equal(({}).polluted, undefined);
  assert.equal(f.notes[0].polluted, undefined);
  assert.deepEqual(Object.keys(f.notes[0]).sort(), ['category', 'color', 'description', 'id', 'title']);
});

test('text normaliseras (NFC) och trimmas', () => {
  const o = valid();
  o.lappar[0].t = '  Ä'.normalize('NFD');
  const f = parseFile(text(o));
  assert.equal(f.notes[0].title, 'Ä'.normalize('NFC'));
});

test('innehåll som ser ut som kod behålls som ren text (visas aldrig som kod)', () => {
  const o = valid();
  o.lappar[0].t = '<script>alert(1)</script>';
  assert.equal(parseFile(text(o)).notes[0].title, '<script>alert(1)</script>');
});

test('resultatfil valideras: ids, tal, manuell permutation och preliminärt', () => {
  const s = board(3);
  s.start('p1');
  while (s.currentPair()) s.answer('left');
  s.finish('p1');
  s.startManualFromAuto('p1');
  const good = () => JSON.parse(serializeFile(s));
  const bad = (mutate) => { const o = good(); mutate(o); return code(() => parseFile(text(o))); };
  assert.ok(parseFile(text(good())));
  assert.equal(bad((o) => { delete o.resultat; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang.pop(); }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang[0].id = 99; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang[1].id = o.resultat.rang[0].id; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang[0].p = -1; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang[0].p = 'många'; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang[0].p = 1e9; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.rang[0].plats = 0; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.manuell = [1, 1, 2]; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.manuell = [1, 2]; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.manuell = [1, 2, 99]; }), 'FILE_INVALID');
  assert.equal(bad((o) => { o.resultat.preliminar = 'ja'; }), 'FILE_INVALID');
});

test('inläst board kan bli en session (ägaren läser in och startar)', () => {
  const f = parseFile(serializeFile(board(5)));
  const s = new Session({ boardName: f.boardName, ownerName: 'Ny', seed: 1 });
  for (const n of f.notes) s.addNote(s.ownerId, n);
  s.start('p1');
  assert.equal(s.mode, MODE.RUNNING);
  assert.equal(s.progress().total, 10);
});

// ---- Lagring (KR-21) ----

function fakeBackend({ failSet = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { if (failSet) throw new Error('QuotaExceededError'); data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('lagring: spara, läsa och rensa', () => {
  const b = fakeBackend();
  const store = createStore(() => b);
  assert.equal(store.available(), true);
  assert.equal(store.load(), null);
  assert.equal(store.save({ a: 1 }), true);
  assert.deepEqual(store.load(), { a: 1 });
  store.clear();
  assert.equal(store.load(), null);
  assert.equal(b.data.size, 0, 'ingen testpost lämnas kvar');
});

test('lagring som inte går att använda upptäcks (nekad, full, kastar vid åtkomst)', () => {
  assert.equal(createStore(() => fakeBackend({ failSet: true })).available(), false);
  assert.equal(createStore(() => { throw new Error('SecurityError'); }).available(), false);
  assert.equal(createStore(() => undefined).available(), false);
  const full = createStore(() => fakeBackend({ failSet: true }));
  assert.equal(full.save({ a: 1 }), false);
  assert.equal(createStore(() => null).save({ a: 1 }), false);
  assert.equal(createStore(() => { throw new Error('x'); }).load(), null);
});

test('trasig lagrad text kastar vid läsning så att anroparen kan varna', () => {
  const b = fakeBackend();
  b.data.set(STORAGE_KEY, '{trasig');
  assert.throws(() => createStore(() => b).load());
});
