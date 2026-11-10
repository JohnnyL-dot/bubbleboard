// Mätprototyp för gruppsession i egen takt (ADR-003, OQ-51 godkänd för prototyp).
// Cloudflare Worker + D1. Bara POST med JSON under /api/*. Inget loggas (ADR-003 avsnitt 6 punkt 7).
// Allt som är märkt "Förslag" är en inställning för mätningen, inte ett krav (OQ-61–OQ-70).

import {
  ApiError, CODE_ALPHABET, CODE_LENGTH, MAX_PARTICIPANTS, checkSync, computeResult,
  isExpired, normalizeName, publicStatus, validateCreateBody, validateNotes,
} from './session-core.js';
import { emptyVector, encodeVector } from '../../src/engine/vector.js';
import { createD1Store } from './store-d1.js';

const MAX_BODY_BYTES = 128 * 1024;
const MINUTE = 60_000;
const HOUR = 3_600_000;

export function configFrom(env = {}) {
  const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    allowedOrigins: String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    testMode: env.TEST_MODE === '1',
    inactivityMs: num(env.INACTIVITY_MS, 24 * HOUR),      // ADR-003 avsnitt 8: 24 h utan skrivning
    afterFinishMs: num(env.FINISHED_MS, 24 * HOUR),
    absoluteMs: num(env.ABSOLUTE_MS, 0),                   // Förslag OQ-67 (72 h). 0 = av.
    createPerHour: num(env.CREATE_PER_HOUR, 5),            // Förslag OQ-64
    maxActiveSessions: num(env.MAX_ACTIVE_SESSIONS, 50),   // Förslag OQ-64
    activityWriteMs: num(env.ACTIVITY_WRITE_MS, 5 * MINUTE), // hur ofta last_activity får skrivas vid synk
    syncMinIntervalMs: num(env.SYNC_MIN_INTERVAL_MS, 4000),
    failuresPerMinute: num(env.FAILURES_PER_MINUTE, 10),   // NFR-6
  };
}

// ---------- hjälpare ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(d));
}

function randomCode() {
  let out = '';
  const limit = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return out;
}

function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ---------- spärrar (NFR-6, Förslag OQ-64) ----------
async function guardFailures(store, ip, now, cfg) {
  const bucket = `f:${ip}:${Math.floor(now / MINUTE)}`;
  if ((await store.peek(bucket, now)) >= cfg.failuresPerMinute) throw new ApiError(429, 'too_many_attempts');
  return bucket;
}
async function fail(store, bucket, now, err) {
  await store.bump(bucket, now, 2 * MINUTE);
  throw err;
}

// ---------- sessionsåtkomst ----------
async function loadActive(store, session, now, cfg) {
  if (!session) return null;
  if (isExpired(session, now, cfg)) {
    await store.deleteSession(session.sid); // utgången session är oåtkomlig direkt (M9)
    return null;
  }
  return session;
}

/** Avslut i två steg (M12): 'finishing' sätts först, resultatet skrivs idempotent av den som först ser det. */
async function completeFinish(store, session, now) {
  if (session.status !== 'finishing') return session;
  const parts = await store.listParticipants(session.sid);
  const result = computeResult(JSON.parse(session.notes_json), parts);
  await store.finalize(session.sid, JSON.stringify(result), now);
  return store.getSessionBySid(session.sid);
}

async function authParticipant(store, body, ip, now, cfg) {
  const bucket = await guardFailures(store, ip, now, cfg);
  if (!isStr(body.sid) || !isStr(body.pid) || !isStr(body.secret)) await fail(store, bucket, now, new ApiError(400, 'invalid_body'));
  let session = await loadActive(store, await store.getSessionBySid(body.sid), now, cfg);
  if (!session) await fail(store, bucket, now, new ApiError(404, 'not_found'));
  const p = await store.getParticipant(session.sid, body.pid);
  if (!p || !sameHash(p.secret_hash, await sha256(body.secret))) await fail(store, bucket, now, new ApiError(404, 'not_found'));
  session = await completeFinish(store, session, now);
  return { session, participant: p, bucket };
}

async function authOwner(store, body, ip, now, cfg) {
  const ctx = await authParticipant(store, body, ip, now, cfg);
  if (!isStr(body.ownerKey) || !ctx.participant.is_owner || !sameHash(ctx.session.owner_hash, await sha256(body.ownerKey))) {
    await fail(store, ctx.bucket, now, new ApiError(403, 'forbidden'));
  }
  return ctx;
}

function viewFor(session, participants, { includeNotes = false, isOwner = false } = {}) {
  const view = publicStatus(session, participants);
  if (session.status === 'finished') {
    view.result = JSON.parse(session.result_json);
    // Manuell ordning lagras (OQ-55) men visas bara för ägaren. Delning med deltagare är Förslag OQ-63.
    if (isOwner && session.manual_order) view.manualOrder = JSON.parse(session.manual_order);
  }
  if (includeNotes || session.status === 'finished') view.notes = JSON.parse(session.notes_json);
  return view;
}

// ---------- endpoints ----------
const routes = {
  async '/api/sessions'(req) {
    const { store, body, ip, now, cfg } = req;
    const input = validateCreateBody(body);
    const bucket = `c:${ip}:${Math.floor(now / HOUR)}`;
    if ((await store.peek(bucket, now)) >= cfg.createPerHour) throw new ApiError(429, 'create_limit');
    if ((await store.countSessions()) >= cfg.maxActiveSessions) throw new ApiError(429, 'capacity');

    const linkToken = randomToken();
    const ownerKey = randomToken();
    const secret = randomToken();
    const seed = cfg.testMode && Number.isInteger(body.seed) ? body.seed : crypto.getRandomValues(new Uint32Array(1))[0];
    const sid = randomToken(12);
    const pid = randomToken(9);
    const n = input.notes.length;
    const session = {
      sid, code: '', link_hash: await sha256(linkToken), owner_hash: await sha256(ownerKey),
      board_name: input.boardName, notes_json: JSON.stringify(input.notes), notes_version: 1, n_notes: n,
      seed, status: 'open', started: 0, created_at: now, last_activity: now,
    };
    const owner = {
      sid, pid, name: input.ownerName, name_key: input.ownerKey, secret_hash: await sha256(secret), is_owner: 1,
      rev: 0, answers: encodeVector(emptyVector(n)), answered: 0, done: 0, updated_at: 0,
    };
    let created = false;
    for (let i = 0; i < 5 && !created; i++) {
      session.code = randomCode();
      created = await store.createSession(session, owner);
    }
    if (!created) throw new ApiError(500, 'server_error');
    await store.bump(bucket, now, HOUR);
    return {
      status: 201,
      body: { sid, pid, secret, ownerKey, linkToken, code: session.code, seed, boardName: input.boardName, notesVersion: 1, notes: input.notes },
    };
  },

  async '/api/lookup'(req) {
    const { store, body, ip, now, cfg } = req;
    const bucket = await guardFailures(store, ip, now, cfg);
    const session = await findByCodeOrLink(store, body, now, cfg);
    if (!session) await fail(store, bucket, now, new ApiError(404, 'not_found'));
    const done = await completeFinish(store, session, now);
    const out = { status: publicStatus(done, []).status, boardName: done.board_name, canJoin: done.status === 'open' };
    if (done.status === 'finished') {
      out.result = JSON.parse(done.result_json);
      out.notes = JSON.parse(done.notes_json);
    }
    return { body: out };
  },

  async '/api/join'(req) {
    const { store, body, ip, now, cfg } = req;
    const bucket = await guardFailures(store, ip, now, cfg);
    const session = await findByCodeOrLink(store, body, now, cfg);
    if (!session) await fail(store, bucket, now, new ApiError(404, 'not_found'));
    const current = await completeFinish(store, session, now);
    if (current.status !== 'open') throw new ApiError(409, 'not_open');
    const { name, key } = normalizeName(body.name);
    const secret = randomToken();
    const p = {
      sid: current.sid, pid: randomToken(9), name, name_key: key, secret_hash: await sha256(secret), is_owner: 0,
      rev: 0, answers: encodeVector(emptyVector(current.n_notes)), answered: 0, done: 0, updated_at: 0,
    };
    const res = await store.addParticipant(p, MAX_PARTICIPANTS);
    if (res === 'name_taken') throw new ApiError(409, 'name_taken');
    if (res === 'full') throw new ApiError(409, 'full');
    if (res !== 'ok') throw new ApiError(404, 'not_found');
    await store.updateSession(current.sid, { last_activity: now });
    return {
      body: {
        sid: current.sid, pid: p.pid, secret, seed: current.seed, boardName: current.board_name,
        notesVersion: current.notes_version, notes: JSON.parse(current.notes_json),
      },
    };
  },

  async '/api/rejoin'(req) {
    const { store, body, ip, now, cfg } = req;
    const { session, participant } = await authParticipant(store, body, ip, now, cfg);
    const parts = await store.listParticipants(session.sid);
    return {
      body: {
        ...viewFor(session, parts, { includeNotes: true, isOwner: !!participant.is_owner }),
        seed: session.seed, notesVersion: session.notes_version,
        me: { rev: participant.rev, answers: participant.answers, done: !!participant.done, owner: !!participant.is_owner },
      },
    };
  },

  async '/api/sync'(req) {
    const { store, body, ip, now, cfg } = req;
    let { session, participant } = await authParticipant(store, body, ip, now, cfg);
    let wrote = false;
    if (body.answers !== undefined) {
      if (session.status !== 'open') throw new ApiError(409, session.status === 'finished' ? 'finished' : 'not_open');
      if (now - participant.updated_at < cfg.syncMinIntervalMs) throw new ApiError(429, 'too_fast');
      let next;
      try {
        next = checkSync(participant, session.n_notes, body);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'stale_rev') err.extra = { rev: participant.rev };
        throw err;
      }
      await store.updateParticipant(session.sid, participant.pid, {
        rev: body.rev, answers: next.answers, answered: next.answered, done: next.done ? 1 : 0, updated_at: now,
      });
      // Aktivitetsstämpeln skrivs högst var ACTIVITY_WRITE_MS (Johnny 2026-11-10: får skrivas mer sällan), för att halvera D1-skrivningarna.
      const fields = {};
      if (now - session.last_activity >= cfg.activityWriteMs) fields.last_activity = now;
      if (!session.started && next.answered > 0) fields.started = 1; // Pågår börjar när någon påbörjat sorteringen (TC-091)
      if (Object.keys(fields).length) await store.updateSession(session.sid, fields);
      Object.assign(session, fields);
      participant = { ...participant, rev: body.rev, done: next.done ? 1 : 0 };
      wrote = true;
    }
    const parts = await store.listParticipants(session.sid);
    const view = viewFor(session, parts, { includeNotes: body.notesVersion !== session.notes_version, isOwner: !!participant.is_owner });
    view.me = { rev: participant.rev, done: !!participant.done };
    view.wrote = wrote;
    return { body: view };
  },

  async '/api/owner/notes'(req) {
    const { store, body, ip, now, cfg } = req;
    const { session } = await authOwner(store, body, ip, now, cfg);
    if (session.status !== 'open') throw new ApiError(409, 'not_open');
    const parts = await store.listParticipants(session.sid);
    if (session.started || parts.some((p) => p.answered > 0)) throw new ApiError(409, 'already_started'); // OQ-60: bara före start
    const notes = validateNotes(body.notes);
    const blank = encodeVector(emptyVector(notes.length));
    await store.updateSession(session.sid, {
      notes_json: JSON.stringify(notes), notes_version: session.notes_version + 1, n_notes: notes.length, last_activity: now,
    });
    for (const p of parts) await store.updateParticipant(session.sid, p.pid, { answers: blank, answered: 0 });
    return { body: { notesVersion: session.notes_version + 1, notes } };
  },

  async '/api/owner/finish'(req) {
    const { store, body, ip, now, cfg } = req;
    const { session } = await authOwner(store, body, ip, now, cfg);
    if (session.status === 'open') {
      await store.updateSession(session.sid, { status: 'finishing', last_activity: now });
      const finished = await completeFinish(store, { ...session, status: 'finishing' }, now);
      return { body: { status: 'finished', result: JSON.parse(finished.result_json) } };
    }
    return { body: { status: 'finished', result: JSON.parse(session.result_json) } };
  },

  async '/api/owner/order'(req) {
    const { store, body, ip, now, cfg } = req;
    const { session } = await authOwner(store, body, ip, now, cfg);
    if (session.status !== 'finished') throw new ApiError(409, 'not_finished');
    const ids = JSON.parse(session.notes_json).map((n) => n.id);
    const order = body.order;
    if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || !order.every((id) => ids.includes(id))) {
      throw new ApiError(400, 'invalid_order');
    }
    await store.updateSession(session.sid, { manual_order: JSON.stringify(order), last_activity: now });
    return { body: { ok: true } };
  },

  async '/api/owner/delete'(req) {
    const { store, body, ip, now, cfg } = req;
    const { session } = await authOwner(store, body, ip, now, cfg);
    await store.deleteSession(session.sid);
    return { body: { ok: true } };
  },
};

async function findByCodeOrLink(store, body, now, cfg) {
  let session = null;
  if (isStr(body.code, 32)) {
    session = await store.getSessionByCode(body.code.toUpperCase().replace(/[\s-]/g, ''));
  } else if (isStr(body.link, 100)) {
    session = await store.getSessionByLinkHash(await sha256(body.link));
  }
  return loadActive(store, session, now, cfg);
}

// ---------- ingång ----------
export async function handleRequest(request, env, store, nowOverride) {
  const cfg = configFrom(env);
  const url = new URL(request.url);
  const h = request.headers;
  const now = cfg.testMode && h.get('x-test-now') ? Number(h.get('x-test-now')) : (nowOverride ?? Date.now());
  const ip = (cfg.testMode && h.get('x-test-ip')) || h.get('cf-connecting-ip') || 'local';

  if (cfg.testMode && url.pathname === '/api/_stats') return reply(200, store.stats ?? {});
  if (cfg.testMode && url.pathname === '/api/_counts') return reply(200, await store.counts()); // bara testläge
  const route = routes[url.pathname];
  if (!url.pathname.startsWith('/api/') || !route) return reply(404, { error: 'not_found' });
  if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
  if (!cfg.allowedOrigins.includes(h.get('origin') ?? '')) return reply(403, { error: 'bad_origin' });
  if (!(h.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return reply(400, { error: 'invalid_body' });

  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new ApiError(413, 'too_large');
    let body;
    try { body = JSON.parse(text); } catch { throw new ApiError(400, 'invalid_body'); }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_body');
    const out = await route({ store, body, ip, now, cfg });
    return reply(out.status ?? 200, out.body);
  } catch (err) {
    if (err instanceof ApiError) return reply(err.status, { error: err.code, ...(err.extra ?? {}) });
    return reply(500, { error: 'server_error' }); // inga detaljer, inget loggas
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env, createD1Store(env.DB));
  },
  async scheduled(_event, env) {
    await createD1Store(env.DB).purgeExpired(Date.now(), configFrom(env));
  },
};
