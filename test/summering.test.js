import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/engine/summering.js';
import { computeRanking } from '../src/engine/scoring.js';
import { createRng, generatePairs } from '../src/engine/pairs.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `n${i + 1}`);
const pointsOf = (rows) => Object.fromEntries(rows.map((r) => [r.id, r.points]));

/** Slumpad deltagare: en delmängd av alla par, med slumpade utfall. */
function randomParticipant(noteIds, rng, fraction) {
  return generatePairs(noteIds)
    .filter(() => rng() < fraction)
    .map((p) => {
      const r = rng();
      return { left: p.a, right: p.b, outcome: r < 0.4 ? 'left' : r < 0.8 ? 'right' : 'equal' };
    });
}

test('0 deltagare: alla lappar har 0 poäng och delad etta (AT-20)', () => {
  const out = summarize(ids(3), []);
  assert.equal(out.participantCount, 0);
  assert.equal(out.comparisonCount, 0);
  assert.ok(out.rows.every((r) => r.points === 0 && r.place === 1 && r.shared));
});

test('1 deltagare: summeringen är deltagarens egen rangordning (AT-20)', () => {
  const comps = [
    { left: 'n1', right: 'n2', outcome: 'left' },
    { left: 'n2', right: 'n3', outcome: 'equal' },
    { left: 'n1', right: 'n3', outcome: 'right' },
  ];
  assert.deepEqual(summarize(ids(3), [comps]).rows, computeRanking(ids(3), comps));
});

test('2 deltagare: poängen summeras per lapp, med halva poäng (AT-20)', () => {
  const a = [{ left: 'n1', right: 'n2', outcome: 'left' }];
  const b = [{ left: 'n1', right: 'n2', outcome: 'equal' }];
  const out = summarize(ids(2), [a, b]);
  assert.deepEqual(pointsOf(out.rows), { n1: 1.5, n2: 0.5 });
  assert.equal(out.rows[0].id, 'n1');
  assert.equal(out.rows[0].wins, 1);
  assert.equal(out.rows[0].equals, 1);
  assert.equal(out.comparisonCount, 2);
});

test('ojämnt antal jämförelser: ofullständig deltagare räknas med det hen gjort (OQ-60)', () => {
  const full = generatePairs(ids(4)).map((p) => ({ left: p.a, right: p.b, outcome: 'left' }));
  const partial = [{ left: 'n4', right: 'n1', outcome: 'left' }];
  const out = summarize(ids(4), [full, partial]);
  assert.equal(out.comparisonCount, 7);
  // n4 har 1 poäng från den ofullständiga deltagaren, 0 från den fullständiga.
  assert.equal(pointsOf(out.rows).n4, 1);
  assert.equal(pointsOf(out.rows).n1, 3);
});

test('delad placering enligt OQ-19 i summeringen (1, 2, 2, 4)', () => {
  const a = [
    { left: 'n1', right: 'n2', outcome: 'left' }, { left: 'n1', right: 'n3', outcome: 'left' },
    { left: 'n1', right: 'n4', outcome: 'left' }, { left: 'n2', right: 'n4', outcome: 'left' },
    { left: 'n3', right: 'n4', outcome: 'left' },
  ];
  const b = [{ left: 'n2', right: 'n3', outcome: 'left' }, { left: 'n3', right: 'n2', outcome: 'left' }];
  const out = summarize(ids(4), [a, b]);
  assert.deepEqual(out.rows.map((r) => [r.id, r.place, r.shared]),
    [['n1', 1, false], ['n2', 2, true], ['n3', 2, true], ['n4', 4, false]]);
});

test('egenskap: varje jämförelse delar ut exakt 1 poäng, för 0–5 deltagare med ojämna antal', () => {
  const rng = createRng(2026);
  for (let round = 0; round < 200; round++) {
    const n = 2 + Math.floor(rng() * 9);
    const noteIds = ids(n);
    const k = Math.floor(rng() * 6);
    const parts = Array.from({ length: k }, () => randomParticipant(noteIds, rng, rng()));
    const out = summarize(noteIds, parts);
    const total = out.rows.reduce((sum, r) => sum + r.points, 0);
    assert.equal(total, parts.flat().length, `runda ${round}`);
    assert.equal(out.comparisonCount, parts.flat().length);
    assert.equal(out.rows.reduce((x, r) => x + r.wins, 0), out.rows.reduce((x, r) => x + r.losses, 0));
    for (const r of out.rows) assert.equal(Number.isInteger(r.points * 2), true, 'poäng är heltal eller halva');
  }
});

test('egenskap: summan av deltagarnas egna poäng är lika med summeringens poäng', () => {
  const rng = createRng(7);
  for (let round = 0; round < 100; round++) {
    const noteIds = ids(2 + Math.floor(rng() * 8));
    const parts = Array.from({ length: Math.floor(rng() * 5) }, () => randomParticipant(noteIds, rng, rng()));
    const summed = {};
    for (const p of parts) {
      for (const r of computeRanking(noteIds, p)) summed[r.id] = (summed[r.id] ?? 0) + r.points;
    }
    const out = pointsOf(summarize(noteIds, parts).rows);
    for (const id of noteIds) assert.equal(out[id], summed[id] ?? 0);
  }
});

test('egenskap: deltagarnas ordning påverkar inte resultatet, och inte heller vänster/höger', () => {
  const rng = createRng(99);
  for (let round = 0; round < 100; round++) {
    const noteIds = ids(3 + Math.floor(rng() * 6));
    const parts = Array.from({ length: 1 + Math.floor(rng() * 4) }, () => randomParticipant(noteIds, rng, 0.8));
    const a = summarize(noteIds, parts).rows;
    const reversed = summarize(noteIds, [...parts].reverse()).rows;
    assert.deepEqual(reversed, a);
    const mirrored = parts.map((p) => p.map((c) => ({
      left: c.right, right: c.left, outcome: c.outcome === 'left' ? 'right' : c.outcome === 'right' ? 'left' : 'equal',
    })));
    assert.deepEqual(summarize(noteIds, mirrored).rows, a);
  }
});

test('okända lappar, jämförelse med sig själv och ogiltigt utfall räknas inte', () => {
  const out = summarize(ids(2), [[
    { left: 'n1', right: 'x', outcome: 'left' },
    { left: 'n1', right: 'n1', outcome: 'left' },
    { left: 'n1', right: 'n2', outcome: 'banan' },
    { left: 'n1', right: 'n2', outcome: 'left' },
  ]]);
  assert.equal(out.comparisonCount, 1);
  assert.deepEqual(pointsOf(out.rows), { n1: 1, n2: 0 });
});

test('motorn är ren: indata ändras inte', () => {
  const parts = [[{ left: 'n1', right: 'n2', outcome: 'left' }]];
  const copy = JSON.parse(JSON.stringify(parts));
  summarize(ids(2), parts);
  assert.deepEqual(parts, copy);
});
