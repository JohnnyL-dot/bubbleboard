// Felsökning: bygger ett fullt pass (20 deltagare × 30 lappar × 435 svar) snabbt och avslutar. Ca 60 anrop.
import { call, cred, createSession, randomValues, rng, encodeVector } from './lib.mjs';
const N = 30; const P = Number(process.env.P ?? 20);
const s = await createSession(N, 'D0');
const people = [s];
for (let p = 1; p < P; p++) {
  const j = await call('/api/join', { code: s.code, name: `D${p}` }, { ip: `10.9.9.${p}` });
  people.push(j.json);
}
const now = Date.now();
for (const [p, pp] of people.entries()) {
  const r = await call('/api/sync', { ...cred(pp), rev: 1, answers: encodeVector(randomValues(N, rng(p + 1))), done: true }, { now: now + p * 5000 });
  if (r.status !== 200) console.log('sync', p, r.status, r.text.slice(0, 200));
}
const t0 = Date.now();
const f = await call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 200_000 });
console.log(`avslut: status ${f.status} på ${Date.now() - t0} ms (${P} deltagare)`);
console.log(f.text.slice(0, 400));
await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 300_000 });
