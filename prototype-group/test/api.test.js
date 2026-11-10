import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/worker.js';
import { createMemoryStore } from '../src/store-memory.js';
import { emptyVector, encodeVector, pairIndex, LOW_WON, HIGH_WON, EQUAL } from '../../src/engine/vector.js';

const ENV = { ALLOWED_ORIGINS: 'http://localhost:8787', TEST_MODE: '1' };
const ORIGIN = 'http://localhost:8787';

function make(env = {}) {
  const store = createMemoryStore();
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const call = async (path, body, extra = {}) => {
    const res = await handleRequest(new Request(`http://localhost:8787${path}`, {
      method: extra.method ?? 'POST',
      headers: { origin: extra.origin ?? ORIGIN, 'content-type': 'application/json', 'x-test-now': String(t), ...(extra.headers ?? {}) },
      body: extra.method === 'GET' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    }), { ...ENV, ...env }, store);
    return { status: res.status, json: await res.json() };
  };
  return { store, call, clock };
}

const notes = (n) => Array.from({ length: n }, (_, i) => ({ title: `Lapp ${i + 1}` }));
async function create(h, n = 4, name = 'Anna') {
  const r = await h.call('/api/sessions', { boardName: 'Test', ownerName: name, notes: notes(n) });
  assert.equal(r.status, 201);
  return r.json;
}
const cred = (s) => ({ sid: s.sid, pid: s.pid, secret: s.secret });
function vec(n, pick) {
  const v = emptyVector(n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) v[pairIndex(i, j, n)] = pick(i, j);
  return encodeVector(v);
}

test('skapa, slå upp med kod och länk, gå med', async () => {
  const h = make();
  const s = await create(h);
  assert.match(s.code, /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
  assert.equal((await h.call('/api/lookup', { code: s.code.toLowerCase() })).json.canJoin, true);
  assert.equal((await h.call('/api/lookup', { link: s.linkToken })).status, 200);
  const j = await h.call('/api/join', { code: s.code, name: 'Bo' });
  assert.equal(j.status, 200);
  assert.equal(j.json.notes.length, 4);
  assert.equal((await h.call('/api/join', { code: s.code, name: 'BO' })).json.error, 'name_taken');
});

test('31:a deltagaren avvisas (hård spärr OQ-29)', async () => {
  const h = make();
  const s = await create(h);
  for (let i = 2; i <= 30; i++) assert.equal((await h.call('/api/join', { code: s.code, name: `D${i}` })).status, 200);
  const r = await h.call('/api/join', { code: s.code, name: 'D31' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'full');
});

test('sync: rev, rate limit, ogiltigt läge, Klar kräver komplett', async () => {
  const h = make();
  const s = await create(h);
  const a = vec(4, () => LOW_WON);
  assert.equal((await h.call('/api/sync', { ...cred(s), rev: 1, answers: a, done: true })).status, 200);
  h.clock.advance(5000);
  assert.equal((await h.call('/api/sync', { ...cred(s), rev: 2, answers: a })).json.error, 'already_done');

  const h2 = make();
  const s2 = await create(h2);
  const partial = encodeVector(Object.assign(emptyVector(4), { [pairIndex(0, 1, 4)]: LOW_WON }));
  assert.equal((await h2.call('/api/sync', { ...cred(s2), rev: 1, answers: partial })).status, 200);
  assert.equal((await h2.call('/api/sync', { ...cred(s2), rev: 2, answers: partial })).json.error, 'too_fast');
  h2.clock.advance(5000);
  assert.equal((await h2.call('/api/sync', { ...cred(s2), rev: 1, answers: partial })).json.error, 'stale_rev');
  assert.equal((await h2.call('/api/sync', { ...cred(s2), rev: 3, answers: 'abc' })).json.error, 'invalid_answers');
  assert.equal((await h2.call('/api/sync', { ...cred(s2), rev: 3, answers: partial, done: true })).json.error, 'incomplete');
});

test('status visar Pågår/Klar men aldrig läge eller antal (OQ-16, OQ-56)', async () => {
  const h = make();
  const s = await create(h);
  const b = (await h.call('/api/join', { code: s.code, name: 'Bo' })).json;
  const one = encodeVector(Object.assign(emptyVector(4), { [pairIndex(0, 1, 4)]: HIGH_WON }));
  await h.call('/api/sync', { ...cred(s), rev: 1, answers: one });
  const r = await h.call('/api/sync', cred(b));
  assert.equal(r.json.status, 'running');
  assert.deepEqual(r.json.participants.map((p) => [p.name, p.state]), [['Anna', 'working'], ['Bo', 'working']]);
  const text = JSON.stringify(r.json);
  assert.ok(!text.includes(one), 'Annas läge får inte finnas i Bos svar');
  for (const key of ['answers', 'answered', 'count', 'rev']) {
    assert.ok(!r.json.participants.some((p) => key in p), key);
  }
});

test('ägaren avslutar: summering, individuella lägen raderas, bara ägaren får avsluta', async () => {
  const h = make();
  const s = await create(h);
  const b = (await h.call('/api/join', { code: s.code, name: 'Bo' })).json;
  await h.call('/api/sync', { ...cred(s), rev: 1, answers: vec(4, () => LOW_WON), done: true });
  h.clock.advance(5000);
  assert.equal((await h.call('/api/owner/finish', { ...cred(b), ownerKey: s.ownerKey })).status, 403);
  assert.equal((await h.call('/api/owner/finish', { ...cred(s), ownerKey: 'fel' })).status, 403);
  const f = await h.call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey });
  assert.equal(f.status, 200);
  assert.equal(f.json.result.preliminary, true);
  assert.equal(f.json.result.rows[0].id, 'n1');
  assert.equal(f.json.result.rows[0].points, 3);
  for (const p of h.store._dump().participants) assert.equal(p.answers, '');
  assert.equal((await h.call('/api/sync', { ...cred(b), rev: 1, answers: vec(4, () => LOW_WON) })).json.error, 'finished');
  assert.equal((await h.call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey })).status, 200);
  assert.ok(!JSON.stringify(f.json).includes('answers'));
});

test('stäng: alla rader borta, generiskt fel efteråt (M16)', async () => {
  const h = make();
  const s = await create(h);
  assert.equal((await h.call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey })).status, 200);
  const d = h.store._dump();
  assert.equal(d.sessions.length + d.participants.length, 0);
  assert.equal((await h.call('/api/sync', cred(s))).json.error, 'not_found');
  assert.equal((await h.call('/api/lookup', { code: s.code })).json.error, 'not_found');
});

test('lappar kan bara ändras före start (OQ-60)', async () => {
  const h = make();
  const s = await create(h);
  const ok = await h.call('/api/owner/notes', { ...cred(s), ownerKey: s.ownerKey, notes: notes(5) });
  assert.equal(ok.json.notesVersion, 2);
  const stale = await h.call('/api/sync', { ...cred(s), notesVersion: 1 });
  assert.equal(stale.json.notes.length, 5);
  await h.call('/api/sync', { ...cred(s), rev: 1, answers: encodeVector(Object.assign(emptyVector(5), { [pairIndex(0, 1, 5)]: EQUAL })) });
  const late = await h.call('/api/owner/notes', { ...cred(s), ownerKey: s.ownerKey, notes: notes(3) });
  assert.equal(late.json.error, 'already_started');
});

test('utgången session är oåtkomlig och rensas (M9)', async () => {
  const h = make({ INACTIVITY_MS: '1000' });
  const s = await create(h);
  h.clock.advance(1500);
  assert.equal((await h.call('/api/sync', cred(s))).status, 404);
  assert.equal(h.store._dump().sessions.length, 0);
});

test('11 felaktiga koder på en minut ger spärr (NFR-6, M7)', async () => {
  const h = make();
  const s = await create(h);
  let last;
  for (let i = 0; i < 11; i++) last = await h.call('/api/lookup', { code: 'AAAAAAAA' }, { headers: { 'x-test-ip': '1.1.1.1' } });
  assert.equal(last.status, 429);
  assert.equal((await h.call('/api/lookup', { code: s.code }, { headers: { 'x-test-ip': '1.1.1.1' } })).status, 429);
  assert.equal((await h.call('/api/lookup', { code: s.code }, { headers: { 'x-test-ip': '2.2.2.2' } })).status, 200);
});

test('skapande begränsas per IP och totalt (Förslag OQ-64)', async () => {
  const h = make({ CREATE_PER_HOUR: '2', MAX_ACTIVE_SESSIONS: '3' });
  await create(h); await create(h);
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A', notes: notes(2) })).json.error, 'create_limit');
  const o = { headers: { 'x-test-ip': '9.9.9.9' } };
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A', notes: notes(2) }, o)).status, 201);
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A', notes: notes(2) }, { headers: { 'x-test-ip': '8.8.8.8' } })).json.error, 'capacity');
});

test('origin, metod, storlek och ogiltig JSON', async () => {
  const h = make();
  assert.equal((await h.call('/api/lookup', { code: 'X' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await h.call('/api/lookup', {}, { method: 'GET' })).status, 405);
  assert.equal((await h.call('/api/lookup', 'inte json')).status, 400);
  assert.equal((await h.call('/api/lookup', { code: 'A'.repeat(200_000) })).status, 413);
  assert.equal((await h.call('/api/nope', {})).status, 404);
});

test('2–30 lappar, validering av lappar och namn', async () => {
  const h = make();
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A', notes: notes(1) })).json.error, 'too_few_notes');
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A', notes: notes(31) })).json.error, 'too_many_notes');
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A'.repeat(16), notes: notes(2) })).json.error, 'invalid_name');
  assert.equal((await h.call('/api/sessions', { boardName: 'x', ownerName: 'A', notes: notes(30) })).status, 201);
});

test('rejoin ger eget läge och bara sitt eget', async () => {
  const h = make();
  const s = await create(h);
  const b = (await h.call('/api/join', { code: s.code, name: 'Bo' })).json;
  const a = vec(4, () => HIGH_WON);
  await h.call('/api/sync', { ...cred(s), rev: 4, answers: a });
  const r = await h.call('/api/rejoin', cred(s));
  assert.equal(r.json.me.rev, 4);
  assert.equal(r.json.me.answers, a);
  assert.equal((await h.call('/api/rejoin', cred(b))).json.me.rev, 0);
  assert.equal((await h.call('/api/rejoin', { ...cred(b), secret: 'fel' })).status, 404);
});

test('ägarens manuella ordning lagras, visas bara för ägaren', async () => {
  const h = make();
  const s = await create(h);
  const b = (await h.call('/api/join', { code: s.code, name: 'Bo' })).json;
  await h.call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey });
  const ord = ['n4', 'n3', 'n2', 'n1'];
  assert.equal((await h.call('/api/owner/order', { ...cred(s), ownerKey: s.ownerKey, order: ord })).status, 200);
  assert.equal((await h.call('/api/owner/order', { ...cred(s), ownerKey: s.ownerKey, order: ['n1'] })).status, 400);
  assert.deepEqual((await h.call('/api/rejoin', cred(s))).json.manualOrder, ord);
  assert.equal((await h.call('/api/rejoin', cred(b))).json.manualOrder, undefined);
});

test('inga hemligheter i svar till andra: länktoken, ägarnyckel, kod', async () => {
  const h = make();
  const s = await create(h);
  const b = (await h.call('/api/join', { code: s.code, name: 'Bo' })).json;
  const r = JSON.stringify((await h.call('/api/sync', cred(b))).json) + JSON.stringify((await h.call('/api/rejoin', cred(b))).json);
  for (const secret of [s.ownerKey, s.linkToken, s.code, s.secret]) assert.ok(!r.includes(secret));
});
