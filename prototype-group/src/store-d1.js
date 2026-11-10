// Lagring i Cloudflare D1 (ADR-003). Samma gränssnitt som store-memory.js.
// Räknar rader och satser så att M5 och M10′ kan jämföras med kontots användningsvy.

import { isExpired } from './session-core.js';

const SESSION_FIELDS = new Set(['notes_json', 'notes_version', 'n_notes', 'status', 'started', 'last_activity', 'finished_at', 'result_json', 'manual_order']);
const PARTICIPANT_FIELDS = new Set(['rev', 'answers', 'answered', 'done', 'updated_at']);

// Gemensam räknare per Worker-instans (testläge visar den via /api/_stats).
const stats = { statements: 0, rowsRead: 0, rowsWritten: 0 };

export function createD1Store(db) {
  const note = (res) => {
    stats.statements += 1;
    stats.rowsRead += res?.meta?.rows_read ?? 0;
    stats.rowsWritten += res?.meta?.rows_written ?? 0;
    return res;
  };
  const first = async (sql, ...args) => {
    const res = note(await db.prepare(sql).bind(...args).all());
    return res.results?.[0] ?? null;
  };
  const all = async (sql, ...args) => note(await db.prepare(sql).bind(...args).all()).results ?? [];
  const run = async (sql, ...args) => note(await db.prepare(sql).bind(...args).run());
  const sets = (fields, allowed) => {
    const keys = Object.keys(fields).filter((k) => allowed.has(k));
    return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => fields[k]) };
  };

  return {
    kind: 'd1',
    stats,

    getSessionBySid: (sid) => first('SELECT * FROM sessions WHERE sid = ?', sid),
    getSessionByCode: (code) => first('SELECT * FROM sessions WHERE code = ?', code),
    getSessionByLinkHash: (hash) => first('SELECT * FROM sessions WHERE link_hash = ?', hash),
    async countSessions() { return (await first('SELECT COUNT(*) AS c FROM sessions')).c; },
    async counts() {
      const r = await first('SELECT (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM participants) AS participants');
      return { sessions: r.sessions, participants: r.participants };
    },

    async createSession(s, o) {
      try {
        const res = await db.batch([
          db.prepare('INSERT INTO sessions (sid, code, link_hash, owner_hash, board_name, notes_json, notes_version, n_notes, seed, status, started, created_at, last_activity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .bind(s.sid, s.code, s.link_hash, s.owner_hash, s.board_name, s.notes_json, s.notes_version, s.n_notes, s.seed, s.status, s.started, s.created_at, s.last_activity),
          db.prepare('INSERT INTO participants (sid, pid, name, name_key, secret_hash, is_owner, rev, answers, answered, done, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .bind(o.sid, o.pid, o.name, o.name_key, o.secret_hash, o.is_owner, o.rev, o.answers, o.answered, o.done, o.updated_at),
        ]);
        res.forEach(note);
        return true;
      } catch (err) {
        if (/UNIQUE/i.test(String(err?.message ?? err))) return false;
        throw err;
      }
    },
    async updateSession(sid, fields) {
      const { sql, values } = sets(fields, SESSION_FIELDS);
      if (sql) await run(`UPDATE sessions SET ${sql} WHERE sid = ?`, ...values, sid);
    },

    listParticipants: (sid) => all('SELECT * FROM participants WHERE sid = ?', sid),
    getParticipant: (sid, pid) => first('SELECT * FROM participants WHERE sid = ? AND pid = ?', sid, pid),
    async addParticipant(p, max) {
      if (await first('SELECT 1 AS x FROM participants WHERE sid = ? AND name_key = ?', p.sid, p.name_key)) return 'name_taken';
      // Taket kontrolleras i samma sats som raden skrivs, så att två samtidiga anslutningar inte kan passera det.
      const res = await run(
        'INSERT INTO participants (sid, pid, name, name_key, secret_hash, is_owner, rev, answers, answered, done, updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM participants WHERE sid = ?) < ?',
        p.sid, p.pid, p.name, p.name_key, p.secret_hash, p.is_owner, p.rev, p.answers, p.answered, p.done, p.updated_at, p.sid, max,
      );
      return res.meta.changes > 0 ? 'ok' : 'full';
    },
    async updateParticipant(sid, pid, fields) {
      const { sql, values } = sets(fields, PARTICIPANT_FIELDS);
      if (sql) await run(`UPDATE participants SET ${sql} WHERE sid = ? AND pid = ?`, ...values, sid, pid);
    },

    async finalize(sid, resultJson, finishedAt) {
      const res = await db.batch([
        db.prepare("UPDATE sessions SET status = 'finished', result_json = ?, finished_at = ?, last_activity = ? WHERE sid = ?").bind(resultJson, finishedAt, finishedAt, sid),
        db.prepare("UPDATE participants SET answers = '', answered = 0 WHERE sid = ?").bind(sid),
      ]);
      res.forEach(note);
    },
    async deleteSession(sid) {
      const res = await db.batch([
        db.prepare('DELETE FROM participants WHERE sid = ?').bind(sid),
        db.prepare('DELETE FROM sessions WHERE sid = ?').bind(sid),
      ]);
      res.forEach(note);
    },

    async purgeExpired(now, cfg) {
      const rows = await all('SELECT sid, created_at, last_activity, finished_at FROM sessions');
      const dead = rows.filter((s) => isExpired(s, now, cfg));
      for (const s of dead) await this.deleteSession(s.sid);
      await run('DELETE FROM attempts WHERE expires_at < ?', now);
      return dead.length;
    },

    async peek(bucket, now) {
      const a = await first('SELECT failures, expires_at FROM attempts WHERE bucket = ?', bucket);
      return a && a.expires_at >= now ? a.failures : 0;
    },
    async bump(bucket, now, windowMs) {
      await run(
        'INSERT INTO attempts (bucket, failures, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET failures = CASE WHEN expires_at < ? THEN 1 ELSE failures + 1 END, expires_at = CASE WHEN expires_at < ? THEN ? ELSE expires_at END',
        bucket, now + windowMs, now, now, now + windowMs,
      );
      return (await first('SELECT failures FROM attempts WHERE bucket = ?', bucket)).failures;
    },
  };
}
