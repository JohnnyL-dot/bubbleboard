// Parbildning. Ren logik, inget beroende av gränssnitt eller session (KR-8, NFR-10).

/** Deterministisk slumpgenerator (mulberry32) så att tester kan fixera seed (OQ-21). */
export function createRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Antal unika par vid fullständig jämförelse: n × (n − 1) / 2. */
export function pairCount(n) {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

/** Alla unika par i skapandeordning (deterministiskt). */
export function generatePairs(noteIds) {
  const pairs = [];
  for (let i = 0; i < noteIds.length; i++) {
    for (let j = i + 1; j < noteIds.length; j++) {
      pairs.push({ id: `${noteIds[i]}|${noteIds[j]}`, a: noteIds[i], b: noteIds[j] });
    }
  }
  return pairs;
}

/**
 * Blandar presentationsordningen och slumpar vänster/höger per jämförelse (OQ-21).
 * Samma seed ger alltid samma resultat. Returnerar `{ id, left, right }`.
 */
export function arrangePairs(pairs, seed) {
  const rng = createRng(seed);
  const arr = pairs.map((p) => ({ ...p }));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.map((p) => {
    const swap = rng() < 0.5;
    return { id: p.id, left: swap ? p.b : p.a, right: swap ? p.a : p.b };
  });
}
