import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionError, LIMITS, MODE, COLORS } from '../src/session/session.js';

const mk = (opts = {}) => new Session({ boardName: 'Workshop', ownerName: 'Johnny', seed: 1, ...opts });
const code = (fn) => {
  try { fn(); } catch (e) { assert.ok(e instanceof SessionError, String(e)); return e.code; }
  return null;
};
function withNotes(n, opts = {}) {
  const s = mk(opts);
  for (let i = 1; i <= n; i++) s.addNote(s.ownerId, { title: `Lapp ${i}` });
  return s;
}
/** Besvarar alla par så att vänster alltid vinner. */
const answerAll = (s, choice = 'left') => { while (s.currentPair()) s.answer(choice); };

// ---- Board (KR-29) och lappar (KR-1, AT-1) ----

test('board kräver namn och ägaren kräver namn (KR-29)', () => {
  assert.equal(code(() => new Session({ boardName: '   ', ownerName: 'A' })), 'BOARD_NAME_EMPTY');
  assert.equal(code(() => new Session({ boardName: 'B', ownerName: '  ' })), 'NAME_EMPTY');
  assert.equal(code(() => new Session({ boardName: 'B', ownerName: 'x'.repeat(16) })), 'NAME_TOO_LONG');
  assert.equal(mk().boardName, 'Workshop');
});

test('lapp med tom titel avvisas, enbart blanksteg räknas som tom (AT-1, OQ-33)', () => {
  const s = mk();
  assert.equal(code(() => s.addNote(s.ownerId, { title: '' })), 'TITLE_EMPTY');
  assert.equal(code(() => s.addNote(s.ownerId, { title: '    ' })), 'TITLE_EMPTY');
  assert.equal(s.notes.length, 0);
});

test('fältgränser: titel 100, beskrivning 500, kategori 30, palett om 8 färger (OQ-33)', () => {
  const s = mk();
  const add = (f) => s.addNote(s.ownerId, f);
  assert.ok(add({ title: 'x'.repeat(100) }));
  assert.equal(code(() => add({ title: 'x'.repeat(101) })), 'TITLE_TOO_LONG');
  assert.ok(add({ title: 'a', description: 'd'.repeat(500) }));
  assert.equal(code(() => add({ title: 'a', description: 'd'.repeat(501) })), 'DESCRIPTION_TOO_LONG');
  assert.ok(add({ title: 'a', category: 'k'.repeat(30) }));
  assert.equal(code(() => add({ title: 'a', category: 'k'.repeat(31) })), 'CATEGORY_TOO_LONG');
  assert.equal(COLORS.length, 8);
  for (const c of COLORS) assert.ok(add({ title: 'a', color: c }) || true);
  assert.equal(code(() => add({ title: 'a', color: 'brun' })), 'COLOR_INVALID');
});

test('emoji räknas som ett tecken (TF-1)', () => {
  const s = mk();
  assert.ok(s.addNote(s.ownerId, { title: '😀'.repeat(100) }));
  assert.equal(code(() => s.addNote(s.ownerId, { title: '😀'.repeat(101) })), 'TITLE_TOO_LONG');
});

test('lappgränser: 25 lappar går, den 26:e avvisas (KR-1, OQ-71)', () => {
  assert.equal(LIMITS.MAX_NOTES, 25);
  const s = withNotes(25);
  assert.equal(s.notes.length, 25);
  assert.equal(code(() => s.addNote(s.ownerId, { title: 'tjugosex' })), 'MAX_NOTES');
  assert.equal(code(() => s.duplicateNote(s.ownerId, s.notes[0].id)), 'MAX_NOTES');
  assert.equal(s.notes.length, 25);
});

test('start kräver minst 2 lappar (OQ-34)', () => {
  for (const n of [0, 1]) assert.equal(code(() => withNotes(n).start('p1')), 'MIN_NOTES');
  const s = withNotes(2);
  s.start('p1');
  assert.equal(s.mode, MODE.RUNNING);
});

test('lappar kan inte läggas till efter start, men kan redigeras (OQ-31)', () => {
  const s = withNotes(3);
  s.start('p1');
  assert.equal(code(() => s.addNote('p1', { title: 'Ny' })), 'NOTES_LOCKED');
  s.editNote('p1', 'n1', { title: 'Ändrad' });
  assert.equal(s.notes[0].title, 'Ändrad');
});

test('bara ägaren får ändra (KR-3)', () => {
  const s = withNotes(2);
  assert.equal(code(() => s.addNote('p2', { title: 'x' })), 'NOT_OWNER');
  assert.equal(code(() => s.moveNote('p2', 'n1', 'down')), 'NOT_OWNER');
  assert.equal(code(() => s.moveNoteTo('p2', 'n1', 1)), 'NOT_OWNER');
  assert.equal(code(() => s.resetManualOrder('p2')), 'NOT_OWNER');
});

// ---- Sortering (KR-6, KR-12, KR-30) ----

test('alla unika par besvaras: 25 lappar ger 300 jämförelser (KR-30, OQ-71)', () => {
  const s = withNotes(25);
  s.start('p1');
  assert.deepEqual(s.progress(), { decided: 0, remaining: 300, total: 300 });
  const seen = new Set();
  while (s.currentPair()) {
    const p = s.currentPair();
    assert.equal(seen.has(p.id), false);
    seen.add(p.id);
    s.answer('left');
  }
  assert.equal(seen.size, 300);
  assert.equal(s.allPairsDecided(), true);
  assert.deepEqual(s.progress(), { decided: 300, remaining: 0, total: 300 });
});

test('framsteg visas för användaren själv (KR-12)', () => {
  const s = withNotes(4);
  s.start('p1');
  s.answer('right');
  s.answer('equal');
  assert.deepEqual(s.progress(), { decided: 2, remaining: 4, total: 6 });
});

test('ångra senaste ett steg åt gången, och paret kommer tillbaka först (KR-6)', () => {
  const s = withNotes(4);
  s.start('p1');
  const first = s.currentPair();
  const second = (s.answer('left'), s.currentPair());
  s.answer('right');
  s.undo();
  assert.equal(s.currentPair().id, second.id);
  assert.equal(s.progress().decided, 1);
  s.undo();
  assert.equal(s.currentPair().id, first.id);
  assert.equal(s.progress().decided, 0);
  assert.equal(code(() => s.undo()), 'NOTHING_TO_UNDO');
});

test('ångra efter sista paret går tillbaka till det paret', () => {
  const s = withNotes(2);
  s.start('p1');
  s.answer('left');
  assert.equal(s.currentPair(), null);
  s.undo();
  assert.ok(s.currentPair());
});

test('ogiltigt val avvisas och svar utanför pågående läge avvisas', () => {
  const s = withNotes(2);
  assert.equal(code(() => s.answer('left')), 'WRONG_MODE');
  s.start('p1');
  assert.equal(code(() => s.answer('banan')), 'CHOICE_INVALID');
  s.answer('left');
  assert.equal(code(() => s.answer('left')), 'NOTHING_TO_ANSWER');
});

test('samma seed ger samma ordning, olika seed kan ge annan (OQ-21)', () => {
  const order = (seed) => { const s = withNotes(6, { seed }); s.start('p1'); return s.queue.map((p) => p.id).join(); };
  assert.equal(order(5), order(5));
  assert.notEqual(order(5), order(6));
});

test('ta bort lapp efter start tar bort dess jämförelser och räknar om (KR-4, OQ-31)', () => {
  const s = withNotes(4);
  s.start('p1');
  s.answer('left');
  s.answer('left');
  const affected = s.comparisonsAffectedByRemoving('n2');
  assert.equal(affected, 3);
  s.removeNote('p1', 'n2');
  assert.deepEqual(s.progress().total, 3);
  assert.ok(![...s.queue, ...s.history].some((p) => p.left === 'n2' || p.right === 'n2'));
});

test('kan inte ta bort så att färre än 2 lappar återstår efter start', () => {
  const s = withNotes(2);
  s.start('p1');
  assert.equal(code(() => s.removeNote('p1', 'n1')), 'MIN_NOTES');
});

// ---- Avslut och resultat (KR-23, KR-24, KR-11) ----

test('avsluta när alla par är besvarade ger fullständigt resultat', () => {
  const s = withNotes(3);
  s.start('p1');
  answerAll(s);
  s.finish('p1');
  assert.equal(s.mode, MODE.FINISHED);
  assert.equal(s.preliminary(), null);
  assert.equal(s.autoRanking().reduce((x, r) => x + r.points, 0), 3);
});

test('avslut i förtid är preliminärt och räknar med givna svar (OQ-18, OQ-60)', () => {
  const s = withNotes(4);
  s.start('p1');
  s.answer('left'); s.answer('left'); s.answer('left');
  s.finish('p1');
  assert.deepEqual(s.preliminary(), { decided: 3, total: 6 });
  assert.equal(s.autoRanking().reduce((x, r) => x + r.points, 0), 3);
});

test('avslutat är slutgiltigt: inga svar, ingen ångra, ingen ny lapp', () => {
  const s = withNotes(3);
  s.start('p1');
  s.finish('p1');
  assert.equal(code(() => s.answer('left')), 'WRONG_MODE');
  assert.equal(code(() => s.undo()), 'WRONG_MODE');
  assert.equal(code(() => s.addNote('p1', { title: 'x' })), 'NOTES_LOCKED');
  assert.equal(code(() => s.finish('p1')), 'WRONG_MODE');
});

test('cykel upptäcks i den egna värderingen (KR-11)', () => {
  const s = withNotes(3);
  s.start('p1');
  // A>B, B>C, C>A oavsett hur paren visas
  const wants = { 'n1|n2': 'n1', 'n2|n3': 'n2', 'n1|n3': 'n3' };
  while (s.currentPair()) {
    const p = s.currentPair();
    s.answer(wants[p.id] === p.left ? 'left' : 'right');
  }
  assert.deepEqual(s.cycles(), [['n1', 'n2', 'n3']]);
});

test('summary kommer från summeringsmotorn med en deltagare', () => {
  const s = withNotes(3);
  s.start('p1');
  answerAll(s);
  const sum = s.summary();
  assert.equal(sum.participantCount, 1);
  assert.equal(sum.comparisonCount, 3);
});

// ---- Manuell ordning (KR-3, KR-5, KR-26) ----

test('manuell ordning hålls skild från automatisk och ändrar inte poäng', () => {
  const s = withNotes(4);
  s.start('p1');
  answerAll(s);
  const before = JSON.stringify(s.autoRanking());
  s.moveNote('p1', 'n4', 'up');
  s.moveNoteTo('p1', 'n1', 3);
  assert.ok(s.manualOrder);
  assert.equal(JSON.stringify(s.autoRanking()), before);
});

test('moveNote flyttar ett steg, stannar vid kanterna och ger nytt index', () => {
  const s = withNotes(3);
  assert.equal(s.moveNote('p1', 'n1', 'up'), 0);
  assert.equal(s.moveNote('p1', 'n1', 'down'), 1);
  assert.deepEqual(s.overviewOrder(), ['n2', 'n1', 'n3']);
  assert.equal(s.moveNote('p1', 'n3', 'down'), 2);
  assert.equal(code(() => s.moveNote('p1', 'n1', 'sidan')), 'DIRECTION_INVALID');
});

test('moveNoteTo flyttar till index och begränsar till listan', () => {
  const s = withNotes(5);
  assert.equal(s.moveNoteTo('p1', 'n1', 3), 3);
  assert.deepEqual(s.overviewOrder(), ['n2', 'n3', 'n4', 'n1', 'n5']);
  assert.equal(s.moveNoteTo('p1', 'n5', -4), 0);
  assert.equal(s.moveNoteTo('p1', 'n5', 99), 4);
  assert.equal(code(() => s.moveNoteTo('p1', 'n5', 1.5)), 'INDEX_INVALID');
  assert.deepEqual([...s.overviewOrder()].sort(), ['n1', 'n2', 'n3', 'n4', 'n5']);
});

test('manuell ordning fungerar med 25 lappar och är alltid en permutation', () => {
  const s = withNotes(25);
  for (let i = 0; i < 100; i++) s.moveNoteTo('p1', `n${(i * 7) % 25 + 1}`, (i * 13) % 25);
  assert.equal(new Set(s.overviewOrder()).size, 25);
  assert.equal(s.overviewOrder().length, 25);
});

test('återställ ger skapandeordning i Översikten och automatisk ordning i resultatet', () => {
  const s = withNotes(3);
  s.moveNote('p1', 'n1', 'down');
  s.resetManualOrder('p1');
  assert.equal(s.manualOrder, null);
  assert.deepEqual(s.overviewOrder(), ['n1', 'n2', 'n3']);
});

test('start av manuell ordning i resultatet utgår från automatisk rangordning (KR-26)', () => {
  const s = withNotes(3);
  s.start('p1');
  const wants = { 'n1|n2': 'n2', 'n2|n3': 'n3', 'n1|n3': 'n3' };
  while (s.currentPair()) { const p = s.currentPair(); s.answer(wants[p.id] === p.left ? 'left' : 'right'); }
  s.finish('p1');
  s.startManualFromAuto('p1');
  assert.deepEqual(s.manualOrder, ['n3', 'n2', 'n1']);
  assert.equal(code(() => withNotes(2).startManualFromAuto('p1')), 'WRONG_MODE');
});

test('lappar som läggs till och tas bort hålls med i manuell ordning', () => {
  const s = withNotes(3);
  s.moveNote('p1', 'n1', 'down');
  s.addNote('p1', { title: 'Ny' });
  assert.deepEqual(s.overviewOrder(), ['n2', 'n1', 'n3', 'n4']);
  s.removeNote('p1', 'n1');
  assert.deepEqual(s.overviewOrder(), ['n2', 'n3', 'n4']);
});

// ---- Lokal lagring (KR-21) ----

test('snapshot och restore ger samma tillstånd mitt i sorteringen', () => {
  const s = withNotes(5);
  s.moveNote('p1', 'n3', 'up');
  s.start('p1');
  s.answer('left'); s.answer('equal'); s.answer('right');
  s.undo();
  const copy = Session.restore(JSON.parse(JSON.stringify(s.snapshot())));
  assert.deepEqual(copy.snapshot(), s.snapshot());
  assert.equal(copy.currentPair().id, s.currentPair().id);
  assert.deepEqual(copy.autoRanking(), s.autoRanking());
  copy.answer('left');
  assert.equal(copy.progress().decided, 3);
});

test('restore efter borttagen lapp och efter avslut', () => {
  const s = withNotes(4);
  s.start('p1');
  s.answer('left');
  s.removeNote('p1', 'n2');
  s.finish('p1');
  const copy = Session.restore(JSON.parse(JSON.stringify(s.snapshot())));
  assert.equal(copy.mode, MODE.FINISHED);
  assert.deepEqual(copy.preliminary(), s.preliminary());
  assert.deepEqual(copy.snapshot(), s.snapshot());
});

test('restore avvisar trasig lagrad data (opålitlig indata)', () => {
  const good = () => { const s = withNotes(3); s.start('p1'); s.answer('left'); return JSON.parse(JSON.stringify(s.snapshot())); };
  const bad = (mutate) => { const x = good(); mutate(x); return code(() => Session.restore(x)); };
  assert.equal(code(() => Session.restore(null)), 'SNAPSHOT_INVALID');
  assert.equal(code(() => Session.restore('text')), 'SNAPSHOT_INVALID');
  assert.equal(code(() => Session.restore([])), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.v = 2; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.mode = 'paused'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.seed = 'a'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.notes[0].title = ''; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.notes[1].id = 'n1'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.notes[0].id = '__proto__'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.queue.pop(); }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.queue[0][1] = 'n99'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.history[0][3] = 'banan'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.history.push(x.history[0]); }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.manualOrder = ['n1', 'n1', 'n2']; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.manualOrder = ['n1', 'n2']; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.nextNoteId = 1; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.queue = 'x'; }), 'SNAPSHOT_INVALID');
  assert.equal(bad((x) => { x.notes = new Array(26).fill(x.notes[0]); }), 'SNAPSHOT_INVALID');
});

test('snapshot innehåller inga hemligheter eller nycklar', () => {
  const s = withNotes(2);
  assert.deepEqual(Object.keys(s.snapshot()).sort(),
    ['boardName', 'history', 'manualOrder', 'mode', 'nextNoteId', 'notes', 'ownerName', 'queue', 'seed', 'v']);
});
