// Svarsläge som kompakt vektor (ADR-003 avsnitt 7). Ren logik utan I/O, samma kod
// i webbläsaren och i en Worker.
//
// Lapparna har fasta index 0 till n-1. Paret (i, j) med i < j får index
// i*(2n - i - 1)/2 + (j - i - 1) och 2 bitar:
//   0 = ej besvarat, 1 = lägre index vann, 2 = högre index vann, 3 = lika viktiga.
// För 30 lappar: 435 par, 109 byte, 146 tecken i base64url utan utfyllnad (148 med).

import { pairCount } from './pairs.js';

export const UNANSWERED = 0;
export const LOW_WON = 1;
export const HIGH_WON = 2;
export const EQUAL = 3;

/** Index för paret (i, j) bland n lappar. Kräver 0 <= i < j < n. */
export function pairIndex(i, j, n) {
  return (i * (2 * n - i - 1)) / 2 + (j - i - 1);
}

/** Antal tecken i den kodade vektorn för n lappar. */
export function encodedLength(n) {
  return Math.ceil((Math.ceil((pairCount(n) * 2) / 8) * 8) / 6);
}

export function emptyVector(n) {
  return new Uint8Array(pairCount(n));
}

/** Kodar vektorn (värden 0–3) till base64url utan utfyllnad. */
export function encodeVector(values) {
  const bytes = new Uint8Array(Math.ceil((values.length * 2) / 8));
  values.forEach((v, k) => { bytes[k >> 2] |= (v & 3) << ((k & 3) * 2); });
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Avkodar och kontrollerar. Returnerar null vid fel längd, tecken som inte hör till
 * base64url eller värden utanför ett par (oanvända bitar måste vara noll).
 */
export function decodeVector(text, n) {
  if (typeof text !== 'string' || text.length !== encodedLength(n) || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  let bin;
  try {
    bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
  const count = pairCount(n);
  if (bin.length !== Math.ceil((count * 2) / 8)) return null;
  const values = new Uint8Array(count);
  for (let k = 0; k < count; k++) values[k] = (bin.charCodeAt(k >> 2) >> ((k & 3) * 2)) & 3;
  // Oanvända bitar i sista byten ska vara noll.
  for (let k = count; k < bin.length * 4; k++) {
    if (((bin.charCodeAt(k >> 2) >> ((k & 3) * 2)) & 3) !== 0) return null;
  }
  return values;
}

export function countAnswered(values) {
  let c = 0;
  for (const v of values) if (v !== UNANSWERED) c++;
  return c;
}

export function isComplete(values) {
  return countAnswered(values) === values.length;
}

/**
 * Gör om besvarade par till jämförelser för summeringen. "left" är den lägre lappen.
 * @param {string[]} noteIds lappar i index-ordning
 */
export function comparisonsFromVector(noteIds, values) {
  const n = noteIds.length;
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = values[pairIndex(i, j, n)];
      if (v === UNANSWERED) continue;
      out.push({ left: noteIds[i], right: noteIds[j], outcome: v === LOW_WON ? 'left' : v === HIGH_WON ? 'right' : 'equal' });
    }
  }
  return out;
}

/** Bygger en vektor från jämförelser { left, right, outcome } (t.ex. en sessions historik). */
export function vectorFromComparisons(noteIds, comparisons) {
  const n = noteIds.length;
  const index = new Map(noteIds.map((id, k) => [id, k]));
  const values = emptyVector(n);
  for (const c of comparisons) {
    const a = index.get(c.left);
    const b = index.get(c.right);
    if (a === undefined || b === undefined || a === b) continue;
    const swap = a > b;
    const [i, j] = swap ? [b, a] : [a, b];
    let v;
    if (c.outcome === 'equal') v = EQUAL;
    else if ((c.outcome === 'left') !== swap) v = LOW_WON;
    else v = HIGH_WON;
    values[pairIndex(i, j, n)] = v;
  }
  return values;
}
