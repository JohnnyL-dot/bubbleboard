// Poängbaserad rangordning, statistik och cykler. Ren logik (KR-8, KR-11, KR-24).
//
// En avgjord jämförelse har formen { left, right, outcome } där outcome är
// 'left', 'right' eller 'equal'. Rådata (jämförelser) och beräknad rangordning
// hålls isär (KR-26, NFR-5).

/**
 * @param {string[]} noteIds  lappar i skapandeordning
 * @param {{left:string,right:string,outcome:'left'|'right'|'equal'}[]} comparisons avgjorda jämförelser
 * @returns {Map<string,{points:number,wins:number,losses:number,equals:number}>}
 */
export function computeStats(noteIds, comparisons) {
  const stats = new Map(noteIds.map((id) => [id, { points: 0, wins: 0, losses: 0, equals: 0 }]));
  for (const c of comparisons) {
    const l = stats.get(c.left);
    const r = stats.get(c.right);
    if (!l || !r) continue;
    if (c.outcome === 'left') {
      l.points += 1; l.wins += 1; r.losses += 1;
    } else if (c.outcome === 'right') {
      r.points += 1; r.wins += 1; l.losses += 1;
    } else if (c.outcome === 'equal') {
      l.points += 0.5; r.points += 0.5; l.equals += 1; r.equals += 1;
    }
  }
  return stats;
}

/**
 * Rangordning: poäng, sedan antal vinster, sedan skapandeordning (OQ-19).
 * Lika poäng och lika vinster ger delad placering ("2 (delad)"), och numreringen
 * hoppar över därefter (1, 2, 2, 4).
 * @returns {{id:string,place:number,shared:boolean,points:number,wins:number,losses:number,equals:number}[]}
 */
export function computeRanking(noteIds, comparisons) {
  const stats = computeStats(noteIds, comparisons);
  const order = new Map(noteIds.map((id, i) => [id, i]));
  const rows = noteIds.map((id) => ({ id, ...stats.get(id) }));
  rows.sort(
    (x, y) => y.points - x.points || y.wins - x.wins || order.get(x.id) - order.get(y.id)
  );
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    const tied = prev && prev.points === row.points && prev.wins === row.wins;
    row.place = tied ? prev.place : i + 1;
  });
  for (const row of rows) {
    row.shared = rows.filter((r) => r.place === row.place).length > 1;
  }
  return rows;
}

/**
 * Hittar cykler i det aggregerade utfallet (KR-11, OQ-20). Endast jämförelser med
 * tydlig vinnare räknas ("lika viktiga" ger ingen riktning).
 *
 * Tolkning: en lapp ingår i en cykel om den ligger i en stark sammanhängande
 * komponent med minst två lappar. Varje sådan komponent redovisas som en grupp
 * (att räkna upp varje enskild enkel cykel växer explosionsartat vid 20 lappar).
 * @returns {string[][]} grupper av lapp-id som ingår i cykler, i skapandeordning
 */
export function findCycles(noteIds, comparisons) {
  const adj = new Map(noteIds.map((id) => [id, []]));
  for (const c of comparisons) {
    if (c.outcome === 'left') adj.get(c.left)?.push(c.right);
    else if (c.outcome === 'right') adj.get(c.right)?.push(c.left);
  }
  // Tarjans algoritm (iterativ rekursion är onödig vid max 30 lappar).
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];
  const visit = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v)) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop(); onStack.delete(w); comp.push(w);
      } while (w !== v);
      if (comp.length > 1) groups.push(comp);
    }
  };
  for (const id of noteIds) if (!idx.has(id)) visit(id);
  const order = new Map(noteIds.map((id, i) => [id, i]));
  return groups
    .map((g) => g.sort((a, b) => order.get(a) - order.get(b)))
    .sort((a, b) => order.get(a[0]) - order.get(b[0]));
}
