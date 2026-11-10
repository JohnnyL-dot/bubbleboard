import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultTsv, tsvField, placeLabel } from '../src/ui/format.js';
import { Session } from '../src/session/session.js';
import { targetIndex, scrollDelta } from '../src/ui/reorder.js';
import { sv, t } from '../src/i18n/sv.js';

const tt = (k, p) => t(k, p, sv);
const model = (s) => ({
  notes: s.notes, rows: s.autoRanking(), manual: s.manualOrder, preliminary: s.preliminary(),
});
function finished(titles, answers) {
  const s = new Session({ boardName: 'B', ownerName: 'A', seed: 3 });
  for (const [title, extra] of titles) s.addNote('p1', { title, ...extra });
  s.start('p1');
  for (const a of answers) s.answer(a);
  return s;
}

test('TSV har rubrikrad med KR-23-kolumnerna i rätt ordning (AT-18)', () => {
  const s = finished([['A'], ['B']], ['left']);
  s.finish('p1');
  const lines = resultTsv(model(s), tt).split('\n');
  assert.equal(lines[0], 'Placering\tTitel\tBeskrivning\tKategori\tPoäng\tVinster\tFörluster\tLika viktiga');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l, i) => i === 0 || l.split('\t').length === 8));
});

test('TSV: rader följer rangordningen, åäö och emoji bevaras, ingen avslutande radbrytning', () => {
  const s = new Session({ boardName: 'B', ownerName: 'A', seed: 1 });
  s.addNote('p1', { title: 'Å', description: 'äö 😀', category: 'Kat' });
  s.addNote('p1', { title: 'B' });
  s.start('p1');
  const p = s.currentPair();
  s.answer(p.left === 'n2' ? 'left' : 'right'); // n2 vinner
  s.finish('p1');
  const out = resultTsv(model(s), tt);
  const rows = out.split('\n').slice(1).map((l) => l.split('\t'));
  assert.deepEqual(rows[0].slice(0, 2), ['1', 'B']);
  assert.deepEqual(rows[1], ['2', 'Å', 'äö 😀', 'Kat', '0', '0', '1', '0']);
  assert.equal(out.endsWith('\n'), false);
  assert.equal(out.includes('\r'), false);
});

test('TSV: tabb och radbrytning i fält ersätts med mellanslag så raderna är hela', () => {
  assert.equal(tsvField('a\tb\r\nc\nd'), 'a b c d');
  const s = finished([['A\tB', { description: 'rad1\nrad2' }], ['C']], ['equal']);
  s.finish('p1');
  const lines = resultTsv(model(s), tt).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.slice(1).every((l) => l.split('\t').length === 8));
});

test('TSV: delad placering, halva poäng och tomma fält', () => {
  const s = finished([['A'], ['B']], ['equal']);
  s.finish('p1');
  const rows = resultTsv(model(s), tt).split('\n').slice(1);
  assert.equal(rows[0], '1 (delad)\tA\t\t\t0.5\t0\t0\t1');
  assert.equal(placeLabel({ place: 1, shared: true }, tt), '1 (delad)');
});

test('TSV: preliminärt resultat märks, manuell ordning följs med egen numrering', () => {
  const s = finished([['A'], ['B'], ['C']], ['left']);
  s.finish('p1');
  s.startManualFromAuto('p1');
  s.moveNoteTo('p1', 'n3', 0);
  const lines = resultTsv(model(s), tt).split('\n');
  assert.equal(lines.at(-1), 'Preliminär, 1 av 3 jämförelser');
  assert.deepEqual(lines.slice(1, 4).map((l) => l.split('\t').slice(0, 2)), [['1', 'C'], ['2', s.notes.find((n) => n.id === s.manualOrder[1]).title], ['3', s.notes.find((n) => n.id === s.manualOrder[2]).title]]);
});

test('TSV innehåller inga hemligheter: ingen seed, alias eller internt id', () => {
  const s = finished([['A'], ['B']], ['left']);
  s.finish('p1');
  const out = resultTsv(model(s), tt);
  assert.equal(out.includes(String(s.seed)), false);
  assert.equal(out.includes('n1'), false);
  assert.equal(out.includes('p1'), false);
});

// ---- Dra och släpp: ren logik (KR-5) ----

test('targetIndex: raden hamnar efter alla rader vars mittpunkt den passerat', () => {
  const mids = [10, 30, 50, 70];
  assert.equal(targetIndex(mids, 0, 0), 0);
  assert.equal(targetIndex(mids, 0, 40), 1);
  assert.equal(targetIndex(mids, 0, 200), 3);
  assert.equal(targetIndex(mids, 3, -5), 0);
  assert.equal(targetIndex(mids, 3, 40), 2);
  assert.equal(targetIndex(mids, 1, 30), 1);
  assert.equal(targetIndex(mids, 1, 5), 0);
});

test('targetIndex med 30 rader ger alltid ett giltigt index', () => {
  const mids = Array.from({ length: 30 }, (_, i) => i * 40 + 20);
  for (let from = 0; from < 30; from++) {
    for (const y of [-100, 0, 345, 600, 1199, 5000]) {
      const i = targetIndex(mids, from, y);
      assert.ok(i >= 0 && i <= 29);
    }
  }
});

test('scrollDelta rullar nära kanterna och inte i mitten', () => {
  assert.equal(scrollDelta(300, 640), 0);
  assert.ok(scrollDelta(10, 640) < 0);
  assert.ok(scrollDelta(630, 640) > 0);
  assert.ok(Math.abs(scrollDelta(-50, 640)) <= 18);
  assert.ok(scrollDelta(900, 640) <= 18);
});
