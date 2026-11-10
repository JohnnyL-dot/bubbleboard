// Individuell värdering: lappar, sortering, resultat och manuell ordning.
// Ren logik utan gränssnitt och utan nätverk (NFR-10). Sorteringsmotorn används via src/engine.
//
// Individuellt läge följer samma flöde som en gruppdeltagares sortering (OQ-59, OQ-60):
// alla par besvaras ett i taget, "Ångra senaste" tar bort senaste svaret, och
// summeringen av en enda deltagare är deltagarens egen rangordning.
// Gruppsession mot server är inte byggd (KR-13, OQ-51).
//
// Fel kastas som SessionError med en kod som gränssnittet översätter (NFR-11).

import { arrangePairs, generatePairs, pairCount } from '../engine/pairs.js';
import { findCycles } from '../engine/scoring.js';
import { summarize } from '../engine/summering.js';

export const LIMITS = Object.freeze({
  MIN_NOTES: 2,          // OQ-34
  MAX_NOTES: 30,         // OQ-34, ändrat av OQ-58
  TITLE_MAX: 100,        // OQ-33
  DESCRIPTION_MAX: 500,  // OQ-33
  CATEGORY_MAX: 30,      // OQ-33
  BOARD_NAME_MAX: 100,   // Ej beslutat, se fråga till projektledaren
  PARTICIPANT_NAME_MAX: 15, // OQ-27
});

/** Fast palett om 8 färger (OQ-33). Färg är enbart visuell markering. */
export const COLORS = Object.freeze([
  'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink',
]);

/** Svarsval för en jämförelse (KR-6, KR-10). */
export const CHOICES = Object.freeze(['left', 'right', 'equal']);

/** Sessionslägen (OQ-18, OQ-60: ingen paus). */
export const MODE = Object.freeze({
  PREPARED: 'prepared', // Förberedd
  RUNNING: 'running',   // Pågår
  FINISHED: 'finished', // Avslutad
});

export const SNAPSHOT_VERSION = 1;

export class SessionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SessionError';
    this.code = code;
  }
}

const fail = (code) => { throw new SessionError(code); };

function cleanText(value) {
  return typeof value === 'string' ? value : '';
}

/** Längd i tecken (Unicode-kodpunkter), så att en emoji räknas som ett tecken (TF-1). */
export function charLength(text) {
  return [...text].length;
}

/**
 * Kontrollerar och rensar lappfält enligt OQ-33. Används både vid inmatning och när
 * en fil eller lokal lagring läses in (opålitlig indata).
 * @returns {{title:string,description:string,category:string,color:string|null}}
 */
export function validateNoteFields({ title, description, category, color }) {
  const t = cleanText(title).trim();
  if (!t) fail('TITLE_EMPTY');
  if (charLength(t) > LIMITS.TITLE_MAX) fail('TITLE_TOO_LONG');
  const d = cleanText(description).trim();
  if (charLength(d) > LIMITS.DESCRIPTION_MAX) fail('DESCRIPTION_TOO_LONG');
  const c = cleanText(category).trim();
  if (charLength(c) > LIMITS.CATEGORY_MAX) fail('CATEGORY_TOO_LONG');
  if (color != null && color !== '' && !COLORS.includes(color)) fail('COLOR_INVALID');
  return { title: t, description: d, category: c, color: color || null };
}

export function validateBoardName(raw) {
  const board = cleanText(raw).trim();
  if (!board) fail('BOARD_NAME_EMPTY');
  if (charLength(board) > LIMITS.BOARD_NAME_MAX) fail('BOARD_NAME_TOO_LONG');
  return board;
}

export function validateOwnerName(raw) {
  const name = cleanText(raw).trim();
  if (!name) fail('NAME_EMPTY');
  if (charLength(name) > LIMITS.PARTICIPANT_NAME_MAX) fail('NAME_TOO_LONG');
  return name;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class Session {
  /**
   * @param {{boardName:string, ownerName:string, seed?:number}} opts
   */
  constructor({ boardName, ownerName, seed }) {
    this.boardName = validateBoardName(boardName);
    this.ownerName = validateOwnerName(ownerName);
    this.ownerId = 'p1';
    this.seed = seed ?? (Date.now() % 2147483647);
    this.mode = MODE.PREPARED;
    this.notes = [];
    this._nextNoteId = 1;
    this.queue = [];        // återstående par, queue[0] är aktuellt par
    this.history = [];      // besvarade par { pairId, left, right, outcome } i svarsordning
    this.manualOrder = null; // ägarens manuella ordning, skild från den automatiska (KR-5, KR-26)
  }

  _requireOwner(actor) {
    if (actor !== this.ownerId) fail('NOT_OWNER');
  }

  // ---------- Lappar (KR-1, KR-4) ----------

  /** Lappar kan bara läggas till innan sorteringen startat (OQ-31). */
  addNote(actor, fields) {
    this._requireOwner(actor);
    if (this.mode !== MODE.PREPARED) fail('NOTES_LOCKED');
    if (this.notes.length >= LIMITS.MAX_NOTES) fail('MAX_NOTES');
    const note = { id: `n${this._nextNoteId++}`, ...validateNoteFields(fields) };
    this.notes.push(note);
    if (this.manualOrder) this.manualOrder.push(note.id);
    return note;
  }

  /** Textändring syns direkt och påverkar inget annat (OQ-31). */
  editNote(actor, id, fields) {
    this._requireOwner(actor);
    if (this.mode === MODE.FINISHED) fail('WRONG_MODE');
    const note = this._note(id);
    Object.assign(note, validateNoteFields({ ...note, ...fields }));
    return note;
  }

  duplicateNote(actor, id) {
    this._requireOwner(actor);
    return this.addNote(actor, this._note(id));
  }

  /** Antal jämförelser som tas bort om lappen raderas (för varningen i KR-4). */
  comparisonsAffectedByRemoving(id) {
    this._note(id);
    const touches = (p) => p.left === id || p.right === id;
    return this.queue.filter(touches).length + this.history.filter(touches).length;
  }

  /** Efter start tas alla jämförelser med lappen bort och rangordningen räknas om (OQ-31). */
  removeNote(actor, id) {
    this._requireOwner(actor);
    if (this.mode === MODE.FINISHED) fail('WRONG_MODE');
    this._note(id);
    if (this.mode !== MODE.PREPARED && this.notes.length <= LIMITS.MIN_NOTES) fail('MIN_NOTES');
    this.notes = this.notes.filter((n) => n.id !== id);
    this.queue = this.queue.filter((p) => p.left !== id && p.right !== id);
    this.history = this.history.filter((h) => h.left !== id && h.right !== id);
    if (this.manualOrder) this.manualOrder = this.manualOrder.filter((x) => x !== id);
  }

  _note(id) {
    const n = this.notes.find((x) => x.id === id);
    if (!n) fail('NOTE_NOT_FOUND');
    return n;
  }

  // ---------- Sortering (KR-6, KR-7, KR-12, KR-30) ----------

  start(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.PREPARED) fail('WRONG_MODE');
    if (this.notes.length < LIMITS.MIN_NOTES) fail('MIN_NOTES');
    this.queue = arrangePairs(generatePairs(this.notes.map((n) => n.id)), this.seed);
    this.history = [];
    this.mode = MODE.RUNNING;
  }

  /** Aktuellt par att visa, eller null när alla par är besvarade. */
  currentPair() {
    return this.mode === MODE.RUNNING ? (this.queue[0] ?? null) : null;
  }

  allPairsDecided() {
    return this.mode === MODE.RUNNING && this.queue.length === 0;
  }

  /** Framsteg för användaren själv (KR-12). */
  progress() {
    const decided = this.history.length;
    return { decided, remaining: this.queue.length, total: decided + this.queue.length };
  }

  /** Registrerar svaret på aktuellt par och går vidare till nästa. */
  answer(choice) {
    if (!CHOICES.includes(choice)) fail('CHOICE_INVALID');
    if (this.mode !== MODE.RUNNING) fail('WRONG_MODE');
    const pair = this.queue[0];
    if (!pair) fail('NOTHING_TO_ANSWER');
    this.queue.shift();
    this.history.push({ pairId: pair.id, left: pair.left, right: pair.right, outcome: choice });
  }

  /** "Ångra senaste", ett steg bakåt åt gången (KR-6). */
  undo() {
    if (this.mode !== MODE.RUNNING) fail('WRONG_MODE');
    const last = this.history.pop();
    if (!last) fail('NOTHING_TO_UNDO');
    this.queue.unshift({ id: last.pairId, left: last.left, right: last.right });
  }

  /**
   * Avslutar. Slutgiltigt. Avslut innan alla par är besvarade ger ett preliminärt
   * resultat där svaren som getts räknas med (OQ-18, OQ-60).
   */
  finish(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.RUNNING) fail('WRONG_MODE');
    this.mode = MODE.FINISHED;
  }

  // ---------- Resultat (KR-11, KR-23, KR-24) ----------

  _comparisons() {
    return this.history.map((h) => ({ left: h.left, right: h.right, outcome: h.outcome }));
  }

  /** Summering via motorn. Med en deltagare är den deltagarens egen rangordning. */
  summary() {
    return summarize(this.notes.map((n) => n.id), [this._comparisons()]);
  }

  /** Automatisk rangordning enligt poäng (rådata ändras aldrig av manuell ordning). */
  autoRanking() {
    return this.summary().rows;
  }

  /** Statistik: vinster, förluster och lika viktiga per lapp (KR-24). */
  stats() {
    return this.autoRanking();
  }

  /** Cykler i den egna värderingen (KR-11, OQ-20). */
  cycles() {
    return findCycles(this.notes.map((n) => n.id), this._comparisons());
  }

  /** Preliminärt resultat: avslutad innan alla par är besvarade (OQ-18). */
  preliminary() {
    if (this.mode !== MODE.FINISHED) return null;
    const { decided, total } = this.progress();
    return decided < total ? { decided, total } : null;
  }

  // ---------- Manuell ordning (KR-3, KR-5, KR-26) ----------
  // Hålls skild från den automatiska rangordningen och ändrar aldrig poäng.

  /** Ordning att visa i Översikten: manuell om den finns, annars skapandeordning. */
  overviewOrder() {
    return this.manualOrder ? [...this.manualOrder] : this.notes.map((n) => n.id);
  }

  /** Startar manuell ordning från den automatiska rangordningen (resultatvyn). */
  startManualFromAuto(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.FINISHED) fail('WRONG_MODE');
    if (!this.manualOrder) this.manualOrder = this._startOrder();
  }

  _setOrder(order) {
    this.manualOrder = order;
  }

  /** Flyttar en lapp ett steg upp eller ned (KR-5, WCAG 2.5.7). Returnerar nya index. */
  moveNote(actor, id, direction) {
    this._requireOwner(actor);
    this._note(id);
    if (direction !== 'up' && direction !== 'down') fail('DIRECTION_INVALID');
    const order = this.manualOrder ? [...this.manualOrder] : this._startOrder();
    const i = order.indexOf(id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return i;
    [order[i], order[j]] = [order[j], order[i]];
    this._setOrder(order);
    return j;
  }

  /** Flyttar en lapp till ett visst index (dra och släpp). Returnerar nya index. */
  moveNoteTo(actor, id, index) {
    this._requireOwner(actor);
    this._note(id);
    if (!Number.isInteger(index)) fail('INDEX_INVALID');
    const order = this.manualOrder ? [...this.manualOrder] : this._startOrder();
    const target = Math.max(0, Math.min(order.length - 1, index));
    const from = order.indexOf(id);
    if (from === target) return from;
    order.splice(from, 1);
    order.splice(target, 0, id);
    this._setOrder(order);
    return target;
  }

  /** Utgångsordning när ingen manuell ordning finns: resultatet när det finns, annars skapandeordning. */
  _startOrder() {
    return this.mode === MODE.FINISHED ? this.autoRanking().map((r) => r.id) : this.notes.map((n) => n.id);
  }

  resetManualOrder(actor) {
    this._requireOwner(actor);
    this.manualOrder = null;
  }

  // ---------- Lokal lagring (KR-21) ----------

  /** Allt som behövs för att fortsätta efter omladdning. Innehåller inga hemligheter. */
  snapshot() {
    return {
      v: SNAPSHOT_VERSION,
      boardName: this.boardName,
      ownerName: this.ownerName,
      seed: this.seed,
      mode: this.mode,
      nextNoteId: this._nextNoteId,
      notes: this.notes.map((n) => ({ ...n })),
      queue: this.queue.map((p) => [p.id, p.left, p.right]),
      history: this.history.map((h) => [h.pairId, h.left, h.right, h.outcome]),
      manualOrder: this.manualOrder ? [...this.manualOrder] : null,
    };
  }

  /**
   * Återskapar en session från lagrad data. Lagrad data behandlas som opålitlig:
   * allt kontrolleras och vid minsta avvikelse kastas SNAPSHOT_INVALID.
   */
  static restore(raw) {
    const bad = () => fail('SNAPSHOT_INVALID');
    try {
      if (!isPlainObject(raw) || raw.v !== SNAPSHOT_VERSION) bad();
      const s = new Session({
        boardName: raw.boardName, ownerName: raw.ownerName,
        seed: Number.isInteger(raw.seed) ? raw.seed : bad(),
      });
      if (!Object.values(MODE).includes(raw.mode)) bad();
      if (!Array.isArray(raw.notes) || raw.notes.length > LIMITS.MAX_NOTES) bad();
      const ids = new Set();
      for (const n of raw.notes) {
        if (!isPlainObject(n) || typeof n.id !== 'string' || !/^n\d+$/.test(n.id) || ids.has(n.id)) bad();
        ids.add(n.id);
        s.notes.push({ id: n.id, ...validateNoteFields(n) });
      }
      const maxId = Math.max(0, ...s.notes.map((n) => Number(n.id.slice(1))));
      s._nextNoteId = Number.isInteger(raw.nextNoteId) && raw.nextNoteId > maxId ? raw.nextNoteId : bad();
      s.mode = raw.mode;

      if (s.mode === MODE.PREPARED) {
        if (raw.queue.length || raw.history.length) bad();
      } else {
        if (!Array.isArray(raw.queue) || !Array.isArray(raw.history)) bad();
        if (s.notes.length < LIMITS.MIN_NOTES) bad();
        const seen = new Set();
        const pairOk = (id, left, right) => {
          if (!ids.has(left) || !ids.has(right) || left === right) bad();
          const [a, b] = [left, right].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
          if (id !== `${a}|${b}` || seen.has(id)) bad();
          seen.add(id);
        };
        for (const p of raw.queue) {
          if (!Array.isArray(p) || p.length !== 3) bad();
          pairOk(...p);
          s.queue.push({ id: p[0], left: p[1], right: p[2] });
        }
        for (const h of raw.history) {
          if (!Array.isArray(h) || h.length !== 4 || !CHOICES.includes(h[3])) bad();
          pairOk(h[0], h[1], h[2]);
          s.history.push({ pairId: h[0], left: h[1], right: h[2], outcome: h[3] });
        }
        if (seen.size !== pairCount(s.notes.length)) bad();
      }

      if (raw.manualOrder != null) {
        const o = raw.manualOrder;
        if (!Array.isArray(o) || o.length !== s.notes.length || new Set(o).size !== o.length
          || !o.every((id) => ids.has(id))) bad();
        s.manualOrder = [...o];
      }
      return s;
    } catch (err) {
      if (err instanceof SessionError && err.code === 'SNAPSHOT_INVALID') throw err;
      throw new SessionError('SNAPSHOT_INVALID');
    }
  }
}
