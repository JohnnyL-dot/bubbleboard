// Sessionshantering: lägen, lappar, omröstning och resultat. Ren logik utan
// gränssnitt och utan nätverk (NFR-10). Sorteringsmotorn används via src/engine.
//
// Allt hålls i minnet. Inget sparas efter sessionens slut (OQ-47).
// Fel kastas som SessionError med en kod som gränssnittet översätter (NFR-11).

import { arrangePairs, generatePairs } from '../engine/pairs.js';
import { computeRanking, findCycles } from '../engine/scoring.js';
import { tally, CHOICES } from '../engine/ballot.js';

export const LIMITS = Object.freeze({
  MIN_NOTES: 2,          // OQ-34
  MAX_NOTES: 20,         // OQ-34
  TITLE_MAX: 100,        // OQ-33
  DESCRIPTION_MAX: 500,  // OQ-33
  CATEGORY_MAX: 30,      // OQ-33
  BOARD_NAME_MAX: 100,   // Ej beslutat, se fråga till projektledaren
  PARTICIPANT_NAME_MAX: 15, // OQ-27
  MAX_PARTICIPANTS: 30,  // OQ-29 (hård spärr)
});

/** Fast palett om 8 färger (OQ-33). Färg är enbart visuell markering. */
export const COLORS = Object.freeze([
  'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink',
]);

/** Sessionslägen (OQ-18). */
export const MODE = Object.freeze({
  PREPARED: 'prepared', // Förberedd
  RUNNING: 'running',   // Pågår
  PAUSED: 'paused',     // Pausad
  FINISHED: 'finished', // Avslutad
});

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

export class Session {
  /**
   * @param {{boardName:string, ownerName:string, seed?:number, individual?:boolean}} opts
   */
  constructor({ boardName, ownerName, seed, individual = true }) {
    const board = cleanText(boardName).trim();
    if (!board) fail('BOARD_NAME_EMPTY');
    if (charLength(board) > LIMITS.BOARD_NAME_MAX) fail('BOARD_NAME_TOO_LONG');

    this.boardName = board;
    this.individual = individual;
    this.seed = seed ?? (Date.now() % 2147483647);
    this.mode = MODE.PREPARED;
    this.notes = [];
    this._nextNoteId = 1;
    this.participants = new Map();
    this.ownerId = this._addParticipant(ownerName);

    this.queue = [];        // återstående par, queue[0] är aktuellt par
    this.history = [];      // avgjorda jämförelser { pairId, left, right, outcome, counts }
    this.votes = new Map(); // deltagar-id -> 'left' | 'right' | 'equal' (högst en aktiv)
    this.phase = 'open';    // 'open' | 'closed'
    this.closedInfo = null; // { pair, counts, total, decided, outcome } när phase === 'closed'
    this.manualOrder = null;
  }

  // ---------- Deltagare (OQ-25, OQ-27) ----------

  _addParticipant(rawName) {
    const name = cleanText(rawName).trim();
    if (!name) fail('NAME_EMPTY');
    if (charLength(name) > LIMITS.PARTICIPANT_NAME_MAX) fail('NAME_TOO_LONG');
    for (const p of this.participants.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) fail('NAME_TAKEN');
    }
    if (this.participants.size >= LIMITS.MAX_PARTICIPANTS) fail('SESSION_FULL');
    const id = `p${this.participants.size + 1}`;
    this.participants.set(id, { id, name });
    return id;
  }

  /** Gruppsession (KR-14). Ej tillgänglig i individuellt läge (OQ-23). */
  addParticipant(name) {
    if (this.individual) fail('INDIVIDUAL_SESSION');
    if (this.mode === MODE.FINISHED) fail('WRONG_MODE');
    return this._addParticipant(name);
  }

  _requireOwner(actor) {
    if (actor !== this.ownerId) fail('NOT_OWNER');
  }

  // ---------- Lappar (KR-1, KR-4) ----------

  _validateNote({ title, description, category, color }) {
    const t = cleanText(title).trim();
    if (!t) fail('TITLE_EMPTY');
    if (charLength(t) > LIMITS.TITLE_MAX) fail('TITLE_TOO_LONG');
    const d = cleanText(description);
    if (charLength(d) > LIMITS.DESCRIPTION_MAX) fail('DESCRIPTION_TOO_LONG');
    const c = cleanText(category).trim();
    if (charLength(c) > LIMITS.CATEGORY_MAX) fail('CATEGORY_TOO_LONG');
    if (color != null && color !== '' && !COLORS.includes(color)) fail('COLOR_INVALID');
    return { title: t, description: d.trim(), category: c, color: color || null };
  }

  /** Lappar kan bara läggas till innan röstningen startat (OQ-31). */
  addNote(actor, fields) {
    this._requireOwner(actor);
    if (this.mode !== MODE.PREPARED) fail('NOTES_LOCKED');
    if (this.notes.length >= LIMITS.MAX_NOTES) fail('MAX_NOTES');
    const note = { id: `n${this._nextNoteId++}`, ...this._validateNote(fields) };
    this.notes.push(note);
    return note;
  }

  /** Textändring syns direkt och påverkar inget annat (OQ-31). */
  editNote(actor, id, fields) {
    this._requireOwner(actor);
    if (this.mode === MODE.FINISHED) fail('WRONG_MODE');
    const note = this._note(id);
    Object.assign(note, this._validateNote({ ...note, ...fields }));
    return note;
  }

  duplicateNote(actor, id) {
    this._requireOwner(actor);
    const src = this._note(id);
    return this.addNote(actor, src);
  }

  /** Antal jämförelser som tas bort om lappen raderas (för varningen i KR-4). */
  comparisonsAffectedByRemoving(id) {
    this._note(id);
    const inQueue = this.queue.filter((p) => p.left === id || p.right === id).length;
    const inHistory = this.history.filter((h) => h.left === id || h.right === id).length;
    return inQueue + inHistory;
  }

  /**
   * Tar bort en lapp. Efter start tas alla jämförelser med lappen bort och
   * rangordningen räknas om. Ligger lappen i paret som visas avbryts den
   * omröstningen (rösterna kastas) och nästa par visas (OQ-31).
   */
  removeNote(actor, id) {
    this._requireOwner(actor);
    if (this.mode === MODE.FINISHED) fail('WRONG_MODE');
    this._note(id);
    const started = this.mode !== MODE.PREPARED;
    if (started && this.notes.length <= LIMITS.MIN_NOTES) fail('MIN_NOTES');

    const removedCurrent = this.currentPair()?.left === id || this.currentPair()?.right === id;
    this.notes = this.notes.filter((n) => n.id !== id);
    this.queue = this.queue.filter((p) => p.left !== id && p.right !== id);
    this.history = this.history.filter((h) => h.left !== id && h.right !== id);
    if (this.manualOrder) this.manualOrder = this.manualOrder.filter((x) => x !== id);

    if (started && removedCurrent) {
      this.votes.clear();
      this.phase = 'open';
      this.closedInfo = null;
    }
  }

  _note(id) {
    const n = this.notes.find((x) => x.id === id);
    if (!n) fail('NOTE_NOT_FOUND');
    return n;
  }

  // ---------- Sessionsadministration (KR-20, OQ-18) ----------

  start(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.PREPARED) fail('WRONG_MODE');
    if (this.notes.length < LIMITS.MIN_NOTES) fail('MIN_NOTES');
    const ids = this.notes.map((n) => n.id);
    this.queue = arrangePairs(generatePairs(ids), this.seed);
    this.history = [];
    this._resetRound();
    this.mode = MODE.RUNNING;
  }

  pause(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.RUNNING) fail('WRONG_MODE');
    this.mode = MODE.PAUSED;
  }

  resume(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.PAUSED) fail('WRONG_MODE');
    this.mode = MODE.RUNNING;
  }

  /**
   * Avslutar sessionen. Slutgiltigt (OQ-18). Avslut innan alla par är klara ger
   * ett preliminärt resultat. En pågående omröstning räknas inte med.
   */
  finish(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.RUNNING && this.mode !== MODE.PAUSED) fail('WRONG_MODE');
    this.votes.clear();
    this.closedInfo = null;
    this.phase = 'open';
    this.mode = MODE.FINISHED;
  }

  // ---------- Jämförelse och omröstning (KR-6, KR-7, KR-15–KR-18) ----------

  _closedDecidedPair() {
    return this.phase === 'closed' && this.closedInfo?.decided ? this.closedInfo.pair : null;
  }

  /** Aktuellt par att visa, eller null när alla par är avgjorda. */
  currentPair() {
    return this._closedDecidedPair() ?? this.queue[0] ?? null;
  }

  /** Alla par avgjorda och ägaren kan välja "Visa resultat" (OQ-18). */
  allPairsDecided() {
    return (this.mode === MODE.RUNNING || this.mode === MODE.PAUSED) && this.queue.length === 0;
  }

  progress() {
    const decided = this.history.length;
    const total = decided + this.queue.length;
    return { decided, remaining: this.queue.length, total };
  }

  _resetRound() {
    this.votes.clear();
    this.phase = 'open';
    this.closedInfo = null;
  }

  /**
   * Lämnar eller ändrar en röst. Högst en aktiv röst per deltagare och
   * jämförelse. Att rösta om är idempotent, så avbrott ger aldrig dubbla röster
   * (KR-16, NFR-9). Röstning är låst under paus (OQ-17).
   */
  vote(participantId, choice) {
    if (!this.participants.has(participantId)) fail('UNKNOWN_PARTICIPANT');
    if (!CHOICES.includes(choice)) fail('CHOICE_INVALID');
    if (this.mode === MODE.PAUSED) fail('VOTING_PAUSED');
    if (this.mode !== MODE.RUNNING) fail('WRONG_MODE');
    if (this.phase !== 'open' || !this.queue[0]) fail('VOTING_CLOSED');
    this.votes.set(participantId, choice);
  }

  hasVoted(participantId) {
    return this.votes.has(participantId);
  }

  /** Visas som "Alla har röstat" (stängning är ändå alltid manuell, OQ-49). */
  allVoted() {
    return this.votes.size === this.participants.size;
  }

  /**
   * Ägaren stänger omröstningen (alltid manuellt). Avgjort: jämförelsen registreras.
   * Inte avgjort (delad förstaplats eller noll röster): ingen poäng delas ut och
   * ägaren startar ny omröstning (OQ-49).
   */
  closeVoting(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.RUNNING) fail(this.mode === MODE.PAUSED ? 'VOTING_PAUSED' : 'WRONG_MODE');
    if (this.phase !== 'open' || !this.queue[0]) fail('VOTING_CLOSED');
    const pair = this.queue[0];
    const t = tally(this.votes.values());
    if (t.decided) {
      this.queue.shift();
      this.history.push({
        pairId: pair.id, left: pair.left, right: pair.right,
        outcome: t.outcome, counts: { ...t.counts },
      });
    }
    this.closedInfo = { pair, counts: t.counts, total: t.total, decided: t.decided, outcome: t.outcome };
    this.phase = 'closed';
    return this.closedInfo;
  }

  /** Efter avgjord omröstning går ägaren manuellt vidare (OQ-15). */
  nextComparison(actor) {
    this._requireOwner(actor);
    if (!(this.phase === 'closed' && this.closedInfo?.decided)) fail('NOT_DECIDED');
    this._resetRound();
  }

  /** "Ny omröstning" på samma par. Rösterna rensas, samma tre val, ingen gräns (OQ-49). */
  newRound(actor) {
    this._requireOwner(actor);
    if (!(this.phase === 'closed' && this.closedInfo && !this.closedInfo.decided)) fail('NOT_UNDECIDED');
    this._resetRound();
  }

  /**
   * Avbryter omröstningen. Rösterna kastas utan att räknas och paret läggs sist i
   * kön (OQ-49). Är det sista paret ligger det kvar.
   */
  cancelVoting(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.RUNNING && this.mode !== MODE.PAUSED) fail('WRONG_MODE');
    if (this._closedDecidedPair()) fail('ALREADY_DECIDED');
    if (this.queue.length > 1) this.queue.push(this.queue.shift());
    this._resetRound();
  }

  /**
   * Individuellt läge (OQ-23): ett val registreras, omröstningen stängs och nästa
   * par visas. Samma motor som gruppsession, bara utan manuella mellansteg.
   */
  answer(choice) {
    if (!this.individual) fail('NOT_INDIVIDUAL');
    this.vote(this.ownerId, choice);
    this.closeVoting(this.ownerId);
    this.nextComparison(this.ownerId);
  }

  /** "Ångra senaste", ett steg bakåt åt gången. Endast individuellt läge (OQ-22). */
  undo() {
    if (!this.individual) fail('NOT_INDIVIDUAL');
    if (this.mode !== MODE.RUNNING && this.mode !== MODE.PAUSED) fail('WRONG_MODE');
    const last = this.history.pop();
    if (!last) fail('NOTHING_TO_UNDO');
    this.queue.unshift({ id: last.pairId, left: last.left, right: last.right });
    this._resetRound();
  }

  // ---------- Resultat (KR-23, KR-24, KR-11, KR-26) ----------

  _comparisons() {
    return this.history.map((h) => ({ left: h.left, right: h.right, outcome: h.outcome }));
  }

  /** Automatisk rangordning enligt poäng (rådata ändras aldrig av manuell justering). */
  autoRanking() {
    return computeRanking(this.notes.map((n) => n.id), this._comparisons());
  }

  /** Visad rangordning: manuell om ägaren justerat, annars automatisk. */
  displayedOrder() {
    const auto = this.autoRanking().map((r) => r.id);
    return this.manualOrder ? [...this.manualOrder] : auto;
  }

  cycles() {
    return findCycles(this.notes.map((n) => n.id), this._comparisons());
  }

  /** Statistik: vinster, förluster, lika viktiga per lapp (KR-24, OQ-11). */
  stats() {
    return this.autoRanking();
  }

  /** Jämförelselista med röstsiffror per avgjord jämförelse (OQ-11). */
  comparisonList() {
    return this.history.map((h) => ({ ...h, counts: { ...h.counts } }));
  }

  /** Preliminärt resultat: avslutad innan alla par är avgjorda (OQ-18). */
  preliminary() {
    if (this.mode !== MODE.FINISHED) return null;
    const { decided, total } = this.progress();
    return decided < total ? { decided, total } : null;
  }

  /** Manuell efterjustering med upp/ned, endast ägaren efter avslut (OQ-36). */
  moveNote(actor, id, direction) {
    this._requireOwner(actor);
    if (this.mode !== MODE.FINISHED) fail('WRONG_MODE');
    this._note(id);
    const order = this.displayedOrder();
    const i = order.indexOf(id);
    const j = direction === 'up' ? i - 1 : direction === 'down' ? i + 1 : fail('DIRECTION_INVALID');
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    this.manualOrder = order;
  }

  resetManualOrder(actor) {
    this._requireOwner(actor);
    if (this.mode !== MODE.FINISHED) fail('WRONG_MODE');
    this.manualOrder = null;
  }
}
