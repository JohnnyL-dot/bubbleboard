// Ren logik för dra och släpp (KR-5). Ingen DOM, så att den kan testas utan layout.

/**
 * Nytt index för den dragna raden.
 * @param {number[]} mids  radernas mittpunkt (samma koordinatsystem som y), i nuvarande ordning
 * @param {number} from    den dragna radens index
 * @param {number} y       pekarens läge
 * @returns {number} index raden får efter släpp (0 till mids.length - 1)
 */
export function targetIndex(mids, from, y) {
  let count = 0;
  mids.forEach((m, i) => {
    if (i !== from && m < y) count++;
  });
  return count;
}

/**
 * Hur många pixlar sidan ska rullas när pekaren är nära kanten, så att en lång
 * lista (30 rader) går att dra i.
 * @returns {number} negativt uppåt, positivt nedåt, 0 när ingen rullning behövs
 */
export function scrollDelta(y, viewportHeight, edge = 60, maxSpeed = 18) {
  if (y < edge) return -Math.ceil(maxSpeed * Math.min(1, (edge - Math.max(y, 0)) / edge));
  if (y > viewportHeight - edge) {
    return Math.ceil(maxSpeed * Math.min(1, (Math.min(y, viewportHeight) - (viewportHeight - edge)) / edge));
  }
  return 0;
}
