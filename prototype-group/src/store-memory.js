// Lagring i minnet. Används av tester (ADR-003 avsnitt 5). Samma gränssnitt som store-d1.js.

import { isExpired } from './session-core.js';

export function createMemoryStore() {
  const sessions = new Map();     // sid -> rad
  const participants = new Map(); // sid -> Map(pid -> rad)
  const attempts = new Map();     // bucket -> { failures, expires_at }
  const stats = { statements: 0, rowsRead: 0, rowsWritten: 0 };
  const clone = (o) => (o ? { ...o } : null);

  return {
    kind: 'memory',
    stats,
    /** Direkt åtkomst för tester som kontrollerar att rader är borta (M6, M16). */
    _dump: () => ({ sessions: [...sessions.values()].map(clone), participants: [...participants.values()].flatMap((m) => [...m.values()].map(clone)), attempts: [...attempts.entries()] }),

    async getSessionBySid(sid) { return clone(sessions.get(sid)); },
    async getSessionByCode(code) { return clone([...sessions.values()].find((s) => s.code === code)); },
    async getSessionByLinkHash(hash) { return clone([...sessions.values()].find((s) => s.link_hash === hash)); },
    async countSessions() { return sessions.size; },
    async counts() { return { sessions: sessions.size, participants: [...participants.values()].reduce((a, m) => a + m.size, 0) }; },

    async createSession(session, owner) {
      if ([...sessions.values()].some((s) => s.code === session.code)) return false;
      sessions.set(session.sid, { ...session });
      participants.set(session.sid, new Map([[owner.pid, { ...owner }]]));
      return true;
    },
    async updateSession(sid, fields) {
      const s = sessions.get(sid);
      if (s) Object.assign(s, fields);
    },

    async listParticipants(sid) { return [...(participants.get(sid)?.values() ?? [])].map(clone); },
    async getParticipant(sid, pid) { return clone(participants.get(sid)?.get(pid)); },
    async addParticipant(p, max) {
      const m = participants.get(p.sid);
      if (!m) return 'gone';
      if ([...m.values()].some((x) => x.name_key === p.name_key)) return 'name_taken';
      if (m.size >= max) return 'full';
      m.set(p.pid, { ...p });
      return 'ok';
    },
    async updateParticipant(sid, pid, fields) {
      const p = participants.get(sid)?.get(pid);
      if (p) Object.assign(p, fields);
    },

    /** Avslut i ett steg: resultatet skrivs och alla individuella lägen raderas (ADR-003 avsnitt 6 punkt 6). */
    async finalize(sid, resultJson, finishedAt) {
      const s = sessions.get(sid);
      if (!s) return;
      Object.assign(s, { status: 'finished', result_json: resultJson, finished_at: finishedAt, last_activity: finishedAt });
      for (const p of participants.get(sid).values()) Object.assign(p, { answers: '', answered: 0 });
    },
    async deleteSession(sid) { sessions.delete(sid); participants.delete(sid); },

    async purgeExpired(now, cfg) {
      let n = 0;
      for (const s of [...sessions.values()]) {
        if (isExpired(s, now, cfg)) { sessions.delete(s.sid); participants.delete(s.sid); n++; }
      }
      for (const [k, v] of attempts) if (v.expires_at < now) attempts.delete(k);
      return n;
    },

    async peek(bucket, now) {
      const a = attempts.get(bucket);
      return a && a.expires_at >= now ? a.failures : 0;
    },
    async bump(bucket, now, windowMs) {
      const a = attempts.get(bucket);
      if (!a || a.expires_at < now) { attempts.set(bucket, { failures: 1, expires_at: now + windowMs }); return 1; }
      a.failures += 1;
      return a.failures;
    },
  };
}
