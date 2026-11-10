// Ren tillståndsmaskin för gruppsession (ADR-003 avsnitt 5). Ingen databas, ingen
// I/O. Motorn (src/engine) används oförändrad, samma kod som i webbläsaren.

import { summarize } from '../../src/engine/summering.js';
import {
  comparisonsFromVector, countAnswered, decodeVector, isComplete,
} from '../../src/engine/vector.js';
import {
  LIMITS, validateBoardName, validateNoteFields, SessionError,
} from '../../src/session/session.js';

export const MAX_PARTICIPANTS = 20;        // OQ-29, ändrat av OQ-71: hård spärr 20 deltagare (normal last 10)
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'; // utan förväxlingsbara tecken (OQ-50)
export const CODE_LENGTH = 8;

/**
 * Klartext på svenska som skickas med i `message` (NFR-9, NFR-11, OQ-64): vad som hänt och vad man kan göra.
 * Koden i `error` är det som klienten och testerna går på. Texterna för taken är krav (OQ-72).
 */
export const ERROR_MESSAGES_SV = Object.freeze({
  create_limit: 'Du har skapat 5 sessioner den senaste timmen, vilket är högsta antalet. Vänta en stund och försök igen, eller använd en av dina sessioner.',
  capacity: 'Tjänsten har just nu 50 aktiva sessioner, vilket är högsta antalet. Försök igen om en stund, sessioner tas bort när de stängs eller löper ut.',
  full: 'Sessionen har redan 20 deltagare, vilket är högsta antalet. Be ägaren att skapa en ny session.',
  too_many_notes: `Det går att ha högst ${LIMITS.MAX_NOTES} lappar. Ta bort några och försök igen.`,
  too_few_notes: 'Det måste finnas minst två lappar.',
  name_taken: 'Namnet används redan i sessionen. Välj ett annat.',
  invalid_name: 'Namnet måste vara 1 till 15 tecken.',
  not_found: 'Koden eller länken hittades inte. Kontrollera den, eller så har sessionen tagits bort eller löpt ut.',
  too_many_attempts: 'För många felaktiga försök. Vänta en minut och försök igen.',
  too_fast: 'För tätt mellan anropen. Vänta ett ögonblick.',
  server_error: 'Något gick fel hos tjänsten. Försök igen om en stund.',
});

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Namn: NFC, trimmat, 1–15 tecken. Unikt skiftlägesokänsligt via name_key (OQ-27). */
export function normalizeName(raw) {
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_name');
  const name = raw.normalize('NFC').trim();
  const len = [...name].length;
  if (len < 1 || len > LIMITS.PARTICIPANT_NAME_MAX) throw new ApiError(400, 'invalid_name');
  return { name, key: name.toLowerCase() };
}

/** Kontrollerar lappar och namn vid skapande. Kastar ApiError(400, kod). */
export function validateNotes(rawNotes) {
  if (!Array.isArray(rawNotes)) throw new ApiError(400, 'invalid_notes');
  if (rawNotes.length < LIMITS.MIN_NOTES) throw new ApiError(400, 'too_few_notes');
  if (rawNotes.length > LIMITS.MAX_NOTES) throw new ApiError(400, 'too_many_notes');
  try {
    return rawNotes.map((n, i) => {
      if (!isObj(n)) throw new ApiError(400, 'invalid_notes');
      const f = validateNoteFields({
        title: typeof n.title === 'string' ? n.title.normalize('NFC') : n.title,
        description: typeof n.description === 'string' ? n.description.normalize('NFC') : n.description,
        category: typeof n.category === 'string' ? n.category.normalize('NFC') : n.category,
        color: n.color,
      });
      return { id: `n${i + 1}`, ...f };
    });
  } catch (err) {
    if (err instanceof SessionError) throw new ApiError(400, `note_${err.code.toLowerCase()}`);
    throw err;
  }
}

export function validateCreateBody(body) {
  if (!isObj(body)) throw new ApiError(400, 'invalid_body');
  let boardName;
  try {
    boardName = validateBoardName(body.boardName);
  } catch (err) {
    if (err instanceof SessionError) throw new ApiError(400, 'invalid_board_name');
    throw err;
  }
  const { name, key } = normalizeName(body.ownerName);
  return { boardName, notes: validateNotes(body.notes), ownerName: name, ownerKey: key };
}

/**
 * Kontrollerar en inkommande synk mot deltagarens lagrade läge.
 * Regler: äldre eller lika rev avvisas, fel längd eller ogiltiga värden avvisas,
 * Klar kräver komplett vektor, och en inlämnad värdering kan inte ändras.
 * @returns {{answers:string, answered:number, done:boolean}} nytt läge
 */
export function checkSync(participant, nNotes, body) {
  if (participant.done) throw new ApiError(409, 'already_done');
  if (!Number.isInteger(body.rev) || body.rev < 0 || body.rev > 1_000_000) throw new ApiError(400, 'invalid_rev');
  if (body.rev <= participant.rev) throw new ApiError(409, 'stale_rev');
  const values = decodeVector(body.answers, nNotes);
  if (!values) throw new ApiError(400, 'invalid_answers');
  const wantsDone = body.done === true;
  if (body.done !== undefined && typeof body.done !== 'boolean') throw new ApiError(400, 'invalid_done');
  if (wantsDone && !isComplete(values)) throw new ApiError(400, 'incomplete');
  return { answers: body.answers, answered: countAnswered(values), done: wantsDone };
}

/**
 * Summering när ägaren avslutar prioriteringen (KR-17, KR-20).
 * Deltagare som inte är klara räknas med de jämförelser de hunnit göra (OQ-60).
 * Resultatet innehåller aldrig individuella val eller räknare per deltagare (OQ-16, OQ-56).
 */
export function computeResult(notes, participants) {
  const ids = notes.map((n) => n.id);
  const lists = participants.map((p) => {
    const values = p.answers ? decodeVector(p.answers, ids.length) : null;
    return values ? comparisonsFromVector(ids, values) : [];
  });
  const sum = summarize(ids, lists);
  const done = participants.filter((p) => p.done).length;
  return {
    rows: sum.rows.map((r) => ({
      id: r.id, place: r.place, shared: r.shared, points: r.points, wins: r.wins, losses: r.losses, equals: r.equals,
    })),
    participants: participants.length,
    done,
    preliminary: done < participants.length,
  };
}

/** Status som alla deltagare och ägaren får: läge och Klar/Pågår, inga siffror (ADR-003 avsnitt 6). */
export function publicStatus(session, participants) {
  return {
    status: session.status === 'finished' ? 'finished' : session.status === 'finishing' ? 'finishing' : (session.started ? 'running' : 'prepared'),
    boardName: session.board_name,
    notesVersion: session.notes_version,
    participants: participants
      .map((p) => ({ name: p.name, state: p.done ? 'done' : 'working', owner: !!p.is_owner }))
      .sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name, 'sv')),
  };
}

/** Är sessionen utgången? Utgången session är oåtkomlig även innan rensningsjobbet har kört (M9). */
export function isExpired(session, now, cfg) {
  if (now - session.last_activity > cfg.inactivityMs) return true;
  if (session.finished_at != null && now - session.finished_at > cfg.afterFinishMs) return true;
  if (cfg.absoluteMs > 0 && now - session.created_at > cfg.absoluteMs) return true;
  return false;
}
