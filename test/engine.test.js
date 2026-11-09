import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePairs, arrangePairs, pairCount, createRng } from '../src/engine/pairs.js';
import { computeRanking, computeStats, findCycles } from '../src/engine/scoring.js';
import { tally } from '../src/engine/ballot.js';

test('pairCount följer n(n-1)/2 (5, 10, 15, 20 lappar)', () => {
  assert.deepEqual([5, 10, 15, 20].map(pairCount), [10, 45, 105, 190]);
  assert.equal(pairCount(0), 0);
  assert.equal(pairCount(1), 0);
});

test('generatePairs ger varje unikt par exakt en gång', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const pairs = generatePairs(ids);
  assert.equal(pairs.length, 6);
  assert.equal(new Set(pairs.map((p) => p.id)).size, 6);
  assert.equal(generatePairs(Array.from({ length: 20 }, (_, i) => `n${i}`)).length, 190);
});

test('arrangePairs är deterministisk för samma seed och bevarar alla par (OQ-21)', () => {
  const pairs = generatePairs(['a', 'b', 'c', 'd', 'e']);
  const x = arrangePairs(pairs, 42);
  const y = arrangePairs(pairs, 42);
  assert.deepEqual(x, y);
  assert.equal(x.length, 10);
  const asSet = (arr) => new Set(arr.map((p) => [p.left, p.right].sort().join('|')));
  assert.deepEqual(asSet(x), asSet(pairs.map((p) => ({ left: p.a, right: p.b }))));
  assert.notDeepEqual(arrangePairs(pairs, 1).map((p) => p.id), arrangePairs(pairs, 2).map((p) => p.id));
});

test('arrangePairs slumpar vänster/höger (båda sidor förekommer)', () => {
  const x = arrangePairs(generatePairs(Array.from({ length: 10 }, (_, i) => `n${i}`)), 7);
  const firstIsLeft = x.filter((p) => p.id.startsWith(`${p.left}|`)).length;
  assert.ok(firstIsLeft > 0 && firstIsLeft < x.length);
});

test('createRng ger tal i [0,1) och är reproducerbar', () => {
  const r1 = createRng(5), r2 = createRng(5);
  for (let i = 0; i < 50; i++) {
    const v = r1();
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, r2());
  }
});

test('poäng: vinst +1, förlust 0, lika viktiga +0,5 till båda', () => {
  const stats = computeStats(['a', 'b', 'c'], [
    { left: 'a', right: 'b', outcome: 'left' },
    { left: 'c', right: 'a', outcome: 'equal' },
    { left: 'b', right: 'c', outcome: 'right' },
  ]);
  assert.deepEqual(stats.get('a'), { points: 1.5, wins: 1, losses: 0, equals: 1 });
  assert.deepEqual(stats.get('b'), { points: 0, wins: 0, losses: 2, equals: 0 });
  assert.deepEqual(stats.get('c'), { points: 1.5, wins: 1, losses: 0, equals: 1 });
});

test('rangordning: antal vinster är tie-breaker vid lika poäng', () => {
  // a: 1 vinst (1 p). b: två lika viktiga (1 p, 0 vinster).
  const r = computeRanking(['a', 'b', 'c', 'd'], [
    { left: 'a', right: 'c', outcome: 'left' },
    { left: 'b', right: 'c', outcome: 'equal' },
    { left: 'b', right: 'd', outcome: 'equal' },
  ]);
  assert.equal(r[0].id, 'a');
  assert.equal(r[1].id, 'b');
  assert.equal(r[0].points, 1);
  assert.equal(r[1].points, 1);
});

test('delad placering vid lika poäng och vinster, sorterad efter skapandeordning (OQ-19)', () => {
  const r = computeRanking(['a', 'b', 'c', 'd'], [
    { left: 'a', right: 'b', outcome: 'equal' },
    { left: 'c', right: 'd', outcome: 'equal' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.map((x) => x.place), [1, 1, 1, 1]);
  assert.ok(r.every((x) => x.shared));
});

test('placering hoppar över efter delad placering (1, 2, 2, 4)', () => {
  const r = computeRanking(['a', 'b', 'c', 'd'], [
    { left: 'a', right: 'b', outcome: 'left' },
    { left: 'a', right: 'c', outcome: 'left' },
    { left: 'a', right: 'd', outcome: 'left' },
    { left: 'b', right: 'c', outcome: 'equal' },
    { left: 'b', right: 'd', outcome: 'left' },
    { left: 'c', right: 'd', outcome: 'left' },
  ]);
  assert.deepEqual(r.map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(r.map((x) => x.place), [1, 2, 2, 4]);
  assert.deepEqual(r.map((x) => x.shared), [false, true, true, false]);
});

test('utan jämförelser är alla lappar delad etta', () => {
  const r = computeRanking(['a', 'b'], []);
  assert.deepEqual(r.map((x) => x.place), [1, 1]);
});

test('cykel A>B>C>A upptäcks och poängbaserad rangordning används ändå (KR-11)', () => {
  const comps = [
    { left: 'a', right: 'b', outcome: 'left' },
    { left: 'b', right: 'c', outcome: 'left' },
    { left: 'c', right: 'a', outcome: 'left' },
  ];
  assert.deepEqual(findCycles(['a', 'b', 'c'], comps), [['a', 'b', 'c']]);
  const r = computeRanking(['a', 'b', 'c'], comps);
  assert.ok(r.every((x) => x.points === 1 && x.place === 1));
});

test('längre cykler (4 lappar) upptäcks, lappar utanför cykeln ingår inte', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const comps = [
    { left: 'a', right: 'b', outcome: 'left' },
    { left: 'b', right: 'c', outcome: 'left' },
    { left: 'c', right: 'd', outcome: 'left' },
    { left: 'd', right: 'a', outcome: 'left' },
    { left: 'e', right: 'a', outcome: 'left' },
  ];
  assert.deepEqual(findCycles(ids, comps), [['a', 'b', 'c', 'd']]);
});

test('lika viktiga skapar ingen cykel, och utan cykel returneras tom lista', () => {
  const comps = [
    { left: 'a', right: 'b', outcome: 'left' },
    { left: 'b', right: 'c', outcome: 'left' },
    { left: 'c', right: 'a', outcome: 'equal' },
  ];
  assert.deepEqual(findCycles(['a', 'b', 'c'], comps), []);
});

test('flera separata cykler redovisas var för sig', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const cyc = (x, y, z) => [
    { left: x, right: y, outcome: 'left' },
    { left: y, right: z, outcome: 'left' },
    { left: z, right: x, outcome: 'left' },
  ];
  const g = findCycles(ids, [...cyc('a', 'b', 'c'), ...cyc('d', 'e', 'f')]);
  assert.deepEqual(g, [['a', 'b', 'c'], ['d', 'e', 'f']]);
});

// ---- Röstsammanställning ----

test('flest röster vinner (3–2)', () => {
  const t = tally(['left', 'left', 'left', 'right', 'right']);
  assert.equal(t.decided, true);
  assert.equal(t.outcome, 'left');
  assert.deepEqual(t.counts, { left: 3, right: 2, equal: 0 });
});

test('"lika viktiga" med flest röster är avgjort och skilt från oavgjort (OQ-49)', () => {
  const t = tally(['equal', 'equal', 'left']);
  assert.equal(t.decided, true);
  assert.equal(t.outcome, 'equal');
});

test('delad förstaplats är inte avgjort (2–2–1, 1–1–1, 1–1)', () => {
  assert.equal(tally(['left', 'left', 'right', 'right', 'equal']).decided, false);
  assert.equal(tally(['left', 'right', 'equal']).decided, false);
  const t = tally(['left', 'right']);
  assert.equal(t.decided, false);
  assert.equal(t.outcome, null);
});

test('noll röster är inte avgjort, och ogiltiga röster ignoreras', () => {
  assert.equal(tally([]).decided, false);
  assert.equal(tally([]).total, 0);
  assert.equal(tally(['skip', undefined]).total, 0);
});

test('en ensam röst avgör (individuellt läge)', () => {
  assert.deepEqual(tally(['equal']).outcome, 'equal');
  assert.deepEqual(tally(['right']).outcome, 'right');
});
