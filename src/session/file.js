// Spara och läsa in fil (KR-31, OQ-53, OQ-57). Ren logik: skapar och tolkar texten,
// själva nedladdningen och filväljaren ligger i gränssnittet.
//
// Formatet är JSON (UTF-8, kompakt, versionsfält). Filen innehåller bara boardens
// namn, lapparna och efter avslut resultatet. Aldrig individuella val, namn,
// seed, sessionskod, ägarnyckel, ägarlänk, deltagarhemlighet eller token.
// En inläst fil är opålitlig indata och valideras strikt (NFR-9).

import { COLORS, LIMITS, MODE, SessionError, validateBoardName, validateNoteFields } from './session.js';

export const FILE_APP = 'bubble';
export const FILE_VERSION = 1;
export const MAX_FILE_BYTES = 256 * 1024; // Arkitektens förslag (C2), kontrolleras innan filen läses

const fail = (code) => { throw new SessionError(code); };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const nfc = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);

/**
 * @param {import('./session.js').Session} session
 * @returns {string} filens text. Resultat tas med bara när sessionen är avslutad.
 */
export function serializeFile(session) {
  const num = new Map(session.notes.map((n, i) => [n.id, i + 1]));
  const out = {
    app: FILE_APP,
    v: FILE_VERSION,
    typ: session.mode === MODE.FINISHED ? 'resultat' : 'board',
    namn: session.boardName,
    lappar: session.notes.map((n) => {
      const o = { id: num.get(n.id), t: n.title };
      if (n.description) o.b = n.description;
      if (n.category) o.k = n.category;
      if (n.color) o.f = n.color;
      return o;
    }),
  };
  if (out.typ === 'resultat') {
    out.resultat = {
      rang: session.autoRanking().map((r) => ({
        id: num.get(r.id), plats: r.place, delad: r.shared, p: r.points, v: r.wins, f: r.losses, l: r.equals,
      })),
      manuell: session.manualOrder ? session.manualOrder.map((id) => num.get(id)) : null,
      preliminar: session.preliminary() !== null,
    };
  }
  return JSON.stringify(out);
}

/** Filnamn utan tecken som inte får finnas i filnamn. */
export function fileName(boardName) {
  const base = boardName.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, 60).trim();
  return `${base || 'board'}.json`;
}

const finiteNum = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

/**
 * Tolkar och validerar filens text.
 * @param {string} text
 * @returns {{typ:'board'|'resultat', boardName:string, notes:{id:number,title:string,description:string,category:string,color:string|null}[],
 *   resultat:null|{rang:object[], manuell:number[]|null, preliminar:boolean}}}
 * @throws {SessionError} med kod FILE_TOO_LARGE, FILE_INVALID, FILE_VERSION eller en lappkod (TITLE_TOO_LONG m.fl.)
 */
export function parseFile(text) {
  if (typeof text !== 'string') fail('FILE_INVALID');
  // Storleken kontrolleras i byte innan texten tolkas.
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) fail('FILE_TOO_LARGE');
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    fail('FILE_INVALID');
  }
  if (!isPlainObject(data) || data.app !== FILE_APP) fail('FILE_INVALID');
  if (data.v !== FILE_VERSION) fail(Number.isInteger(data.v) ? 'FILE_VERSION' : 'FILE_INVALID');
  if (data.typ !== 'board' && data.typ !== 'resultat') fail('FILE_INVALID');

  const boardName = validateBoardName(nfc(data.namn));
  if (!Array.isArray(data.lappar)) fail('FILE_INVALID');
  if (data.lappar.length < LIMITS.MIN_NOTES) fail('MIN_NOTES');
  if (data.lappar.length > LIMITS.MAX_NOTES) fail('MAX_NOTES');

  const ids = new Set();
  const notes = data.lappar.map((raw) => {
    if (!isPlainObject(raw) || !Number.isInteger(raw.id) || raw.id < 1 || raw.id > 1_000_000 || ids.has(raw.id)) fail('FILE_INVALID');
    for (const key of ['t', 'b', 'k', 'f']) {
      if (hasOwn(raw, key) && raw[key] != null && typeof raw[key] !== 'string') fail('FILE_INVALID');
    }
    ids.add(raw.id);
    const color = raw.f == null ? null : raw.f;
    if (color !== null && !COLORS.includes(color)) fail('COLOR_INVALID');
    const fields = validateNoteFields({
      title: nfc(raw.t), description: nfc(raw.b), category: nfc(raw.k), color,
    });
    return { id: raw.id, ...fields };
  });

  let resultat = null;
  if (data.typ === 'resultat') {
    const r = data.resultat;
    if (!isPlainObject(r) || !Array.isArray(r.rang) || r.rang.length !== notes.length) fail('FILE_INVALID');
    const seen = new Set();
    const rang = r.rang.map((row) => {
      if (!isPlainObject(row) || !ids.has(row.id) || seen.has(row.id)) fail('FILE_INVALID');
      seen.add(row.id);
      if (!Number.isInteger(row.plats) || row.plats < 1 || row.plats > notes.length
        || typeof row.delad !== 'boolean'
        || !finiteNum(row.p, 10_000) || !finiteNum(row.v, 10_000)
        || !finiteNum(row.f, 10_000) || !finiteNum(row.l, 10_000)) fail('FILE_INVALID');
      return { id: row.id, plats: row.plats, delad: row.delad, p: row.p, v: row.v, f: row.f, l: row.l };
    });
    let manuell = null;
    if (r.manuell != null) {
      if (!Array.isArray(r.manuell) || r.manuell.length !== notes.length
        || new Set(r.manuell).size !== notes.length || !r.manuell.every((id) => ids.has(id))) fail('FILE_INVALID');
      manuell = [...r.manuell];
    }
    if (typeof r.preliminar !== 'boolean') fail('FILE_INVALID');
    resultat = { rang, manuell, preliminar: r.preliminar };
  }
  return { typ: data.typ, boardName, notes, resultat };
}
