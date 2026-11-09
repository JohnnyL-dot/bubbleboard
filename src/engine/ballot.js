// Röstsammanställning per jämförelse (KR-10, KR-17, KR-18, OQ-10, OQ-49).

export const CHOICES = ['left', 'right', 'equal'];

/**
 * Flest röster av de tre valen avgör. Delad förstaplats eller noll röster är
 * "inte avgjort" och leder till ny omröstning (aldrig slumpmässig vinnare).
 * "Lika viktiga" med flest röster är ett avgjort utfall och skiljs från oavgjort.
 * @param {Iterable<'left'|'right'|'equal'>} votes  en aktiv röst per deltagare
 * @returns {{counts:{left:number,right:number,equal:number},total:number,decided:boolean,outcome:('left'|'right'|'equal'|null)}}
 */
export function tally(votes) {
  const counts = { left: 0, right: 0, equal: 0 };
  let total = 0;
  for (const v of votes) {
    if (!CHOICES.includes(v)) continue;
    counts[v]++;
    total++;
  }
  const max = Math.max(counts.left, counts.right, counts.equal);
  const leaders = CHOICES.filter((c) => counts[c] === max);
  const decided = total > 0 && leaders.length === 1;
  return { counts, total, decided, outcome: decided ? leaders[0] : null };
}
