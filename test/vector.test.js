import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pairIndex, emptyVector, encodeVector, decodeVector, encodedLength, countAnswered, isComplete,
  comparisonsFromVector, vectorFromComparisons,
} from '../src/engine/vector.js';
import { createRng, pairCount, generatePairs } from '../src/engine/pairs.js';
import { computeRanking } from '../src/engine/scoring.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `n${i + 1}`);

test('parindex är unikt och fyller 0 till n(n-1)/2-1 för n = 2 till 30', () => {
  for (let n = 2; n <= 30; n++) {
    const seen = new Set();
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) seen.add(pairIndex(i, j, n));
    assert.equal(seen.size, pairCount(n));
    assert.equal(Math.min(...seen), 0);
    assert.equal(Math.max(...seen), pairCount(n) - 1);
  }
});

test('30 lappar: 435 par, 109 byte, 146 tecken utan utfyllnad (ADR-003: högst 148)', () => {
  const v = emptyVector(30);
  assert.equal(v.length, 435);
  assert.equal(Math.ceil(435 * 2 / 8), 109);
  assert.equal(encodedLength(30), 146);
  assert.equal(encodeVector(v).length, 146);
});

test('kodning och avkodning är omvändbara för alla storlekar', () => {
  const rng = createRng(5);
  for (let n = 2; n <= 30; n++) {
    const v = emptyVector(n).map(() => Math.floor(rng() * 4));
    const text = encodeVector(v);
    assert.equal(text.length, encodedLength(n));
    assert.deepEqual([...decodeVector(text, n)], [...v]);
  }
});

test('avkodning avvisar fel längd, fel tecken och oanvända bitar', () => {
  const ok = encodeVector(emptyVector(5));
  assert.ok(decodeVector(ok, 5));
  assert.equal(decodeVector(ok + 'A', 5), null);
  assert.equal(decodeVector(ok.slice(1), 5), null);
  assert.equal(decodeVector('+'.repeat(ok.length), 5), null);
  assert.equal(decodeVector(ok.replace(/./, '*'), 5), null);
  assert.equal(decodeVector(null, 5), null);
  assert.equal(decodeVector(ok, 6), null);
  // n = 5: 10 par = 20 bitar, 3 byte = 24 bitar, de sista 4 bitarna ska vara noll.
  const bytes = [0, 0, 0xf0];
  const bad = btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
  assert.equal(decodeVector(bad, 5), null);
});

test('antal besvarade och komplett', () => {
  const v = emptyVector(3);
  assert.equal(countAnswered(v), 0);
  v[0] = 1; v[1] = 2;
  assert.equal(countAnswered(v), 2);
  assert.equal(isComplete(v), false);
  v[2] = 3;
  assert.equal(isComplete(v), true);
});

test('egenskap: jämförelser till vektor och tillbaka ger samma rangordning, oavsett vänster/höger', () => {
  const rng = createRng(11);
  for (let round = 0; round < 100; round++) {
    const n = 2 + Math.floor(rng() * 12);
    const noteIds = ids(n);
    const comps = generatePairs(noteIds).filter(() => rng() < 0.8).map((p) => {
      const flip = rng() < 0.5;
      const r = rng();
      const base = r < 0.4 ? 'left' : r < 0.8 ? 'right' : 'equal';
      return flip
        ? { left: p.b, right: p.a, outcome: base === 'left' ? 'right' : base === 'right' ? 'left' : 'equal' }
        : { left: p.a, right: p.b, outcome: base };
    });
    const back = comparisonsFromVector(noteIds, vectorFromComparisons(noteIds, comps));
    assert.equal(back.length, comps.length);
    assert.deepEqual(computeRanking(noteIds, back), computeRanking(noteIds, comps));
  }
});
