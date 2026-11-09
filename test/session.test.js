import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, SessionError, LIMITS, MODE } from '../src/session/session.js';

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
const left = (s) => s.currentPair().left;

// ---- Board (KR-29) och lappar (KR-1, AT-1) ----

test('board kräver namn (KR-29)', () => {
  assert.equal(code(() => new Session({ boardName: '   ', ownerName: 'A' })), 'BOARD_NAME_EMPTY');
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
  assert.ok(add({ title: 'a', color: 'teal' }));
  assert.equal(code(() => add({ title: 'a', color: 'magenta' })), 'COLOR_INVALID');
});

test('titlar behöver inte vara unika, och åäö fungerar (OQ-33, NFR-11)', () => {
  const s = mk();
  s.addNote(s.ownerId, { title: 'Åtgärda ändring' });
  s.addNote(s.ownerId, { title: 'Åtgärda ändring' });
  assert.equal(s.notes.length, 2);
  assert.equal(s.notes[0].title, 'Åtgärda ändring');
});

test('max 20 lappar: den 21:a avvisas. Minst 2 krävs för start (OQ-34)', () => {
  const s = withNotes(20);
  assert.equal(code(() => s.addNote(s.ownerId, { title: 'en till' })), 'MAX_NOTES');
  assert.equal(s.notes.length, 20);
  const one = withNotes(1);
  assert.equal(code(() => one.start(one.ownerId)), 'MIN_NOTES');
  const zero = mk();
  assert.equal(code(() => zero.start(zero.ownerId)), 'MIN_NOTES');
});

test('inga lappar kan läggas till när röstningen startat (OQ-31)', () => {
  const s = withNotes(3);
  s.start(s.ownerId);
  assert.equal(code(() => s.addNote(s.ownerId, { title: 'sen' })), 'NOTES_LOCKED');
  assert.equal(code(() => s.duplicateNote(s.ownerId, 'n1')), 'NOTES_LOCKED');
});

test('duplicera lapp (KR-4) och redigera text (OQ-31)', () => {
  const s = withNotes(2);
  const copy = s.duplicateNote(s.ownerId, 'n1');
  assert.notEqual(copy.id, 'n1');
  assert.equal(copy.title, 'Lapp 1');
  s.start(s.ownerId);
  s.editNote(s.ownerId, 'n2', { title: 'Ny text' });
  assert.equal(s.notes.find((n) => n.id === 'n2').title, 'Ny text');
  assert.equal(s.queue.length, 3, 'textändring påverkar inte jämförelserna');
  assert.equal(code(() => s.editNote(s.ownerId, 'n2', { title: '' })), 'TITLE_EMPTY');
});

test('endast ägaren hanterar lappar och sessionen (NFR-6)', () => {
  const s = mk({ individual: false });
  const p = s.addParticipant('Eva');
  assert.equal(code(() => s.addNote(p, { title: 'x' })), 'NOT_OWNER');
  assert.equal(code(() => s.start(p)), 'NOT_OWNER');
});

// ---- Deltagare (OQ-27, OQ-23) ----

test('visningsnamn: unika (skiftlägesokänsligt), 1–15 tecken (OQ-27)', () => {
  const s = mk({ individual: false });
  assert.equal(code(() => s.addParticipant('johnny')), 'NAME_TAKEN');
  assert.equal(code(() => s.addParticipant('')), 'NAME_EMPTY');
  assert.equal(code(() => s.addParticipant('x'.repeat(16))), 'NAME_TOO_LONG');
  assert.ok(s.addParticipant('x'.repeat(15)));
});

test('individuell session kan inte få fler deltagare (OQ-23)', () => {
  const s = mk();
  assert.equal(code(() => s.addParticipant('Eva')), 'INDIVIDUAL_SESSION');
  assert.equal(s.participants.size, 1);
});

// ---- Start, jämförelser, framsteg (AT-3, KR-6, KR-7, KR-12) ----

test('start ger n(n-1)/2 par och läget Pågår, framsteg visas (KR-12)', () => {
  const s = withNotes(5);
  assert.equal(s.mode, MODE.PREPARED);
  s.start(s.ownerId);
  assert.equal(s.mode, MODE.RUNNING);
  assert.deepEqual(s.progress(), { decided: 0, remaining: 10, total: 10 });
  s.answer('left');
  assert.deepEqual(s.progress(), { decided: 1, remaining: 9, total: 10 });
});

test('samma seed ger samma ordning på parens presentation (OQ-21)', () => {
  const a = withNotes(5), b = withNotes(5);
  a.start(a.ownerId); b.start(b.ownerId);
  assert.deepEqual(a.queue, b.queue);
});

test('individuellt svar registreras och nästa par visas (AT-3)', () => {
  const s = withNotes(3);
  s.start(s.ownerId);
  const first = s.currentPair();
  s.answer('right');
  assert.notEqual(s.currentPair().id, first.id);
  assert.equal(s.history[0].outcome, 'right');
  assert.equal(s.history[0].counts.right, 1);
});

test('hela individuella flödet ger rangordning med rätt poäng (AT-9)', () => {
  const s = withNotes(3);
  s.start(s.ownerId);
  // Lapp med lägst nummer vinner alltid.
  while (s.currentPair()) {
    const p = s.currentPair();
    const num = (id) => Number(id.slice(1));
    s.answer(num(p.left) < num(p.right) ? 'left' : 'right');
  }
  assert.ok(s.allPairsDecided());
  assert.deepEqual(s.autoRanking().map((r) => [r.id, r.points, r.place]), [
    ['n1', 2, 1], ['n2', 1, 2], ['n3', 0, 3],
  ]);
  s.finish(s.ownerId);
  assert.equal(s.preliminary(), null);
});

test('"lika viktiga" ger 0,5 poäng till båda och räknas som avgjort (KR-10)', () => {
  const s = withNotes(2);
  s.start(s.ownerId);
  s.answer('equal');
  assert.deepEqual(s.autoRanking().map((r) => r.points), [0.5, 0.5]);
  assert.equal(s.history[0].outcome, 'equal');
});

test('ångra senaste går ett steg bakåt åt gången (OQ-22)', () => {
  const s = withNotes(3);
  s.start(s.ownerId);
  const p1 = s.currentPair();
  s.answer('left');
  const p2 = s.currentPair();
  s.answer('left');
  s.undo();
  assert.equal(s.currentPair().id, p2.id);
  s.undo();
  assert.equal(s.currentPair().id, p1.id);
  assert.equal(s.history.length, 0);
  assert.equal(code(() => s.undo()), 'NOTHING_TO_UNDO');
});

test('ångra finns inte i gruppsession (OQ-22)', () => {
  const s = withNotes(2, { individual: false });
  s.start(s.ownerId);
  assert.equal(code(() => s.undo()), 'NOT_INDIVIDUAL');
});

// ---- Röstning i grupp (AT-4, AT-5, AT-6, KR-15–KR-19) ----

function group(n = 3, extra = ['Eva', 'Olle']) {
  const s = withNotes(n, { individual: false });
  const ps = extra.map((name) => s.addParticipant(name));
  s.start(s.ownerId);
  return { s, o: s.ownerId, ps };
}

test('ändra röst: högst en aktiv röst, senaste gäller (AT-5, KR-16)', () => {
  const { s, o, ps } = group();
  s.vote(ps[0], 'left');
  s.vote(ps[0], 'right');
  s.vote(ps[0], 'right');
  assert.equal(s.votes.size, 1);
  assert.equal(s.votes.get(ps[0]), 'right');
  s.vote(o, 'right'); s.vote(ps[1], 'left');
  const info = s.closeVoting(o);
  assert.deepEqual(info.counts, { left: 1, right: 2, equal: 0 });
  assert.equal(info.outcome, 'right');
});

test('stängning är manuell även när alla röstat, och röster kan inte ändras efter (OQ-49)', () => {
  const { s, o, ps } = group();
  s.vote(o, 'left'); s.vote(ps[0], 'left'); s.vote(ps[1], 'left');
  assert.ok(s.allVoted());
  assert.equal(s.phase, 'open');
  s.closeVoting(o);
  assert.equal(code(() => s.vote(ps[0], 'right')), 'VOTING_CLOSED');
  assert.equal(code(() => s.closeVoting(o)), 'VOTING_CLOSED');
});

test('avgjord omröstning kräver att ägaren går vidare manuellt (OQ-15)', () => {
  const { s, o, ps } = group();
  const first = s.currentPair();
  s.vote(o, 'left'); s.vote(ps[0], 'left'); s.vote(ps[1], 'right');
  s.closeVoting(o);
  assert.equal(s.currentPair().id, first.id, 'aggregerat resultat visas för samma par');
  s.nextComparison(o);
  assert.notEqual(s.currentPair().id, first.id);
  assert.equal(s.votes.size, 0);
});

test('delad förstaplats ger ingen poäng, ny omröstning på samma par rensar röster (AT-6, KR-18)', () => {
  const { s, o, ps } = group(3, ['Eva', 'Olle', 'Lisa']);
  const first = s.currentPair();
  s.vote(o, 'left'); s.vote(ps[0], 'left'); s.vote(ps[1], 'right'); s.vote(ps[2], 'right');
  const info = s.closeVoting(o);
  assert.equal(info.decided, false);
  assert.equal(s.history.length, 0, 'ingen poäng delas ut');
  assert.equal(code(() => s.nextComparison(o)), 'NOT_DECIDED');
  s.newRound(o);
  assert.equal(s.currentPair().id, first.id);
  assert.equal(s.votes.size, 0);
  assert.equal(s.phase, 'open');
  // Ingen gräns: en omgång till är möjlig.
  s.vote(o, 'equal'); s.vote(ps[0], 'left'); s.vote(ps[1], 'right');
  assert.equal(s.closeVoting(o).decided, false);
  s.newRound(o);
  s.vote(o, 'equal'); s.vote(ps[0], 'equal');
  assert.equal(s.closeVoting(o).outcome, 'equal');
  assert.equal(s.history[0].outcome, 'equal');
});

test('noll röster är inte avgjort (OQ-49)', () => {
  const { s, o } = group();
  assert.equal(s.closeVoting(o).decided, false);
  assert.equal(s.history.length, 0);
});

test('avbryta kastar rösterna och lägger paret sist i kön (OQ-49)', () => {
  const { s, o, ps } = group();
  const first = s.currentPair();
  const total = s.queue.length;
  s.vote(ps[0], 'left');
  s.cancelVoting(o);
  assert.equal(s.votes.size, 0);
  assert.equal(s.queue.length, total);
  assert.equal(s.queue[s.queue.length - 1].id, first.id);
  assert.notEqual(s.currentPair().id, first.id);
  assert.equal(s.history.length, 0);
});

test('avbryta på sista paret lämnar kvar paret', () => {
  const { s, o } = group(2);
  const only = s.currentPair();
  s.cancelVoting(o);
  assert.equal(s.currentPair().id, only.id);
});

test('ägaren röstar också som deltagare och rösterna är dolda för andra via API (OQ-14)', () => {
  const { s, o } = group();
  s.vote(o, 'left');
  assert.ok(s.hasVoted(o));
  assert.equal(s.hasVoted('p2'), false, 'man ser vem som röstat, inte vad (OQ-16)');
});

test('okänd deltagare och ogiltigt val avvisas', () => {
  const { s } = group();
  assert.equal(code(() => s.vote('p99', 'left')), 'UNKNOWN_PARTICIPANT');
  assert.equal(code(() => s.vote('p1', 'skip')), 'CHOICE_INVALID');
});

// ---- Paus, avslut (AT-8, KR-20, OQ-17, OQ-18) ----

test('under paus är röstning låst och lämnade röster bevaras (OQ-17)', () => {
  const { s, o, ps } = group();
  s.vote(ps[0], 'left');
  s.pause(o);
  assert.equal(s.mode, MODE.PAUSED);
  assert.equal(code(() => s.vote(ps[1], 'left')), 'VOTING_PAUSED');
  assert.equal(code(() => s.closeVoting(o)), 'VOTING_PAUSED');
  s.resume(o);
  assert.equal(s.mode, MODE.RUNNING);
  assert.equal(s.votes.get(ps[0]), 'left');
  s.vote(ps[1], 'left');
  assert.equal(s.votes.size, 2);
});

test('felaktiga lägesövergångar avvisas', () => {
  const s = withNotes(2);
  assert.equal(code(() => s.pause(s.ownerId)), 'WRONG_MODE');
  s.start(s.ownerId);
  assert.equal(code(() => s.start(s.ownerId)), 'WRONG_MODE');
  assert.equal(code(() => s.resume(s.ownerId)), 'WRONG_MODE');
});

test('avslut i förtid ger preliminärt resultat "X av Y" och är slutgiltigt (OQ-18)', () => {
  const s = withNotes(4);
  s.start(s.ownerId);
  for (let i = 0; i < 3; i++) s.answer('left');
  s.finish(s.ownerId);
  assert.equal(s.mode, MODE.FINISHED);
  assert.deepEqual(s.preliminary(), { decided: 3, total: 6 });
  assert.equal(s.autoRanking().length, 4);
  assert.equal(code(() => s.resume(s.ownerId)), 'WRONG_MODE');
  assert.equal(code(() => s.vote(s.ownerId, 'left')), 'WRONG_MODE');
  assert.equal(code(() => s.start(s.ownerId)), 'WRONG_MODE');
});

test('pågående omröstning räknas inte vid avslut', () => {
  const { s, o, ps } = group(3);
  s.vote(ps[0], 'left');
  s.finish(o);
  assert.equal(s.history.length, 0);
  assert.equal(s.votes.size, 0);
});

// ---- Ta bort lapp efter start (AT-11, KR-4, OQ-31) ----

test('borttagning före start tar bara bort lappen', () => {
  const s = withNotes(3);
  s.removeNote(s.ownerId, 'n2');
  assert.deepEqual(s.notes.map((n) => n.id), ['n1', 'n3']);
  assert.equal(s.comparisonsAffectedByRemoving('n1'), 0);
});

test('borttagning efter start tar bort lappens jämförelser och räknar om (AT-11)', () => {
  const s = withNotes(4);
  s.start(s.ownerId);
  // Avgör tre par.
  for (let i = 0; i < 3; i++) s.answer('left');
  const affected = s.comparisonsAffectedByRemoving('n2');
  assert.equal(affected, 3, 'varje lapp ingår i 3 av de 6 paren');
  const before = s.progress().total;
  s.removeNote(s.ownerId, 'n2');
  assert.equal(s.notes.length, 3);
  assert.equal(s.progress().total, 3);
  assert.ok(before > s.progress().total);
  assert.ok([...s.queue, ...s.history].every((p) => (p.left !== 'n2' && p.right !== 'n2')));
  assert.equal(s.autoRanking().length, 3);
});

test('lapp i pågående par: omröstningen avbryts, rösterna kastas, nästa par visas (OQ-31)', () => {
  const { s, o, ps } = group(3);
  const pair = s.currentPair();
  s.vote(o, 'left'); s.vote(ps[0], 'left');
  s.removeNote(o, pair.left);
  assert.equal(s.votes.size, 0);
  assert.equal(s.phase, 'open');
  assert.ok(s.currentPair());
  assert.ok(![s.currentPair().left, s.currentPair().right].includes(pair.left));
});

test('efter start går det inte att ta bort så att färre än 2 lappar finns kvar', () => {
  const s = withNotes(2);
  s.start(s.ownerId);
  assert.equal(code(() => s.removeNote(s.ownerId, 'n1')), 'MIN_NOTES');
});

// ---- Cykler, resultat, manuell ordning (AT-9, KR-11, KR-26) ----

function finishedSession() {
  const s = withNotes(3);
  s.start(s.ownerId);
  while (s.currentPair()) {
    const p = s.currentPair();
    s.answer(Number(p.left.slice(1)) < Number(p.right.slice(1)) ? 'left' : 'right');
  }
  s.finish(s.ownerId);
  return s;
}

test('cykel i röstutfallet ger varning med de ingående lapparna (AT-9, KR-11)', () => {
  const s = withNotes(3);
  s.start(s.ownerId);
  // n1>n2, n2>n3, n3>n1
  const beats = { 'n1|n2': 'n1', 'n2|n3': 'n2', 'n1|n3': 'n3' };
  while (s.currentPair()) {
    const p = s.currentPair();
    const key = [p.left, p.right].sort().join('|');
    s.answer(beats[key] === p.left ? 'left' : 'right');
  }
  assert.deepEqual(s.cycles(), [['n1', 'n2', 'n3']]);
  assert.ok(s.autoRanking().every((r) => r.points === 1 && r.shared));
});

test('manuell efterjustering sparas separat från automatisk rangordning (KR-26, OQ-36)', () => {
  const s = finishedSession();
  const auto = s.autoRanking().map((r) => r.id);
  assert.deepEqual(auto, ['n1', 'n2', 'n3']);
  s.moveNote(s.ownerId, 'n3', 'up');
  assert.deepEqual(s.displayedOrder(), ['n1', 'n3', 'n2']);
  assert.deepEqual(s.autoRanking().map((r) => r.id), auto, 'automatisk ordning oförändrad');
  assert.deepEqual(s.stats().map((r) => r.points), [2, 1, 0], 'statistiken påverkas inte');
  s.moveNote(s.ownerId, 'n1', 'up'); // redan överst, ingen ändring
  assert.deepEqual(s.displayedOrder(), ['n1', 'n3', 'n2']);
  s.resetManualOrder(s.ownerId);
  assert.deepEqual(s.displayedOrder(), auto);
});

test('manuell justering endast efter avslut och endast av ägaren', () => {
  const s = withNotes(2);
  assert.equal(code(() => s.moveNote(s.ownerId, 'n1', 'down')), 'WRONG_MODE');
  const f = finishedSession();
  assert.equal(code(() => f.moveNote('p9', 'n1', 'down')), 'NOT_OWNER');
});

test('jämförelselistan visar röstsiffror per avgjord jämförelse (OQ-11)', () => {
  const { s, o, ps } = group(2);
  s.vote(o, 'left'); s.vote(ps[0], 'left'); s.vote(ps[1], 'right');
  s.closeVoting(o);
  const list = s.comparisonList();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].counts, { left: 2, right: 1, equal: 0 });
});

test('LIMITS följer besluten', () => {
  assert.equal(LIMITS.MAX_NOTES, 20);
  assert.equal(LIMITS.MIN_NOTES, 2);
  assert.equal(LIMITS.PARTICIPANT_NAME_MAX, 15);
});
