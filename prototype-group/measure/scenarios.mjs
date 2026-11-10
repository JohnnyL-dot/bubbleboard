// Tre lastscenarier i verklig tid: 10 personer som sorterar 20 lappar (190 jämförelser) samtidigt.
//   normal : ca 7 s per jämförelse (ADR-003 avsnitt 8), ca 22 min
//   peak   : alla klickar supersnabbt, 2 s per jämförelse, ca 6,5 min
//   double : dubbel peak = två sessioner à 10 personer samtidigt (20 klienter, peak-takt), ca 6,5 min
// Varje klient har egen takt (±jitter) och egen synkfas, synkar var 10 s (endast skrivning vid ändring, annars läsning),
// lämnar in direkt efter sista jämförelsen och väntar på att ägaren avslutar. Ingen testrubrik för tid används.
// Kör: node measure/scenarios.mjs normal|peak|double|all   (BASE och ORIGIN som vanligt)
// TIME_SCALE<1 komprimerar tiden för en snabb rökprovning (servern måste då ha SYNC_MIN_INTERVAL_MS skalat lika).
import { writeFileSync } from 'node:fs';
import { call, cred, createSession, rng, allPairs, emptyVector, encodeVector, pairIndex, summary, fmt, sleep, netErrors } from './lib.mjs';
import { LOW_WON, HIGH_WON, EQUAL } from '../../src/engine/vector.js';

const SCALE = Number(process.env.TIME_SCALE ?? 1);
const SYNC_MS = 10_000 * SCALE;
const WRITE_GAP_MS = 4_100 * SCALE;       // servern tillåter en skrivning per 4 s och deltagare
const N = 20; const PEOPLE = 10;
const SCENARIOS = {
  normal: { label: 'Normal last (7 s per jämförelse)', sessions: 1, answerMs: 7000, jitter: 0.4 },
  peak: { label: 'Peaklast (2 s per jämförelse, supersnabba)', sessions: 1, answerMs: 2000, jitter: 0.3 },
  double: { label: 'Dubbel peak (två sessioner à 10 personer, 2 s per jämförelse)', sessions: 2, answerMs: 2000, jitter: 0.3 },
};

function fullValues(seed) {
  const rand = rng(seed); const v = emptyVector(N);
  for (const [i, j] of allPairs(N)) { const r = rand(); v[pairIndex(i, j, N)] = r < 0.45 ? LOW_WON : r < 0.9 ? HIGH_WON : EQUAL; }
  return v;
}
function shuffled(arr, rand) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function runSession(sc, sIdx, metrics) {
  const owner = await createSession(N, 'P0');
  const people = [{ ...owner, name: 'P0' }];
  for (let p = 1; p < PEOPLE; p++) {
    const j = await call('/api/join', { code: owner.code, name: `P${p}` }, { ip: `10.77.${sIdx}.${p}` });
    if (j.status !== 200) throw new Error(`join ${j.status} ${j.text}`);
    people.push({ ...j.json, name: `P${p}` });
  }
  const full = people.map((_, p) => fullValues(1000 * (sIdx + 1) + p));
  const total = allPairs(N).length;
  const doneAck = new Map(); // namn -> tid då Klar bekräftades
  const finished = { at: 0, result: null };
  const seenDone = people.map(() => new Set());
  const lags = []; const finishLags = [];
  const t0 = Date.now(); const deadline = t0 + 45 * 60_000;

  async function client(p) {
    const me = people[p]; const rand = rng(77 + p + 100 * sIdx);
    const order = shuffled(allPairs(N), rand);
    const vals = emptyVector(N);
    let answered = 0; let rev = 0; let dirty = false; let lastWrite = 0; let doneSent = false; let finishedSeen = false;
    const jit = () => sc.answerMs * SCALE * (1 + (rand() * 2 - 1) * sc.jitter);
    let nextAnswer = Date.now() + rand() * sc.answerMs * SCALE;
    let nextSync = Date.now() + rand() * SYNC_MS;             // egen synkfas
    const body = (extra = {}) => ({ ...cred(me), ...extra });
    async function doSync(final) {
      const wantsWrite = final || dirty;
      if (wantsWrite && Date.now() - lastWrite < WRITE_GAP_MS) { await sleep(WRITE_GAP_MS - (Date.now() - lastWrite)); }
      const req = wantsWrite ? body({ rev: rev + 1, answers: encodeVector(vals), ...(final ? { done: true } : {}) }) : body();
      const r = await call('/api/sync', req);
      metrics.calls++;
      if (r.retried) metrics.retried += r.retried;
      (wantsWrite ? metrics.write : metrics.read).push(r.ms);
      if (r.status === 200) {
        if (wantsWrite) { rev += 1; dirty = false; lastWrite = Date.now(); if (final) { doneSent = true; doneAck.set(me.name, Date.now()); } }
        for (const q of r.json.participants) {
          if (q.state === 'done' && q.name !== me.name && !seenDone[p].has(q.name) && doneAck.has(q.name)) { seenDone[p].add(q.name); lags.push(Date.now() - doneAck.get(q.name)); }
        }
        if (r.json.status === 'finished') { finishedSeen = true; if (finished.at) finishLags.push(Date.now() - finished.at); }
        return r.json;
      }
      const k = `${wantsWrite ? 'skriv' : 'läs'} ${r.status} ${r.json?.error ?? r.text.slice(0, 60)} ${r.json?.detail ?? ''}`.trim();
      metrics.errors.set(k, (metrics.errors.get(k) ?? 0) + 1);
      return null;
    }
    while (!finishedSeen && Date.now() < deadline) {
      const now = Date.now();
      while (answered < total && nextAnswer <= now) {
        const [i, j] = order[answered++]; vals[pairIndex(i, j, N)] = full[p][pairIndex(i, j, N)]; dirty = true; nextAnswer += jit();
      }
      if (answered === total && !doneSent) { await doSync(true); nextSync = Date.now() + SYNC_MS; continue; }
      if (now >= nextSync) {
        const st = await doSync(false); nextSync = Date.now() + SYNC_MS;
        if (p === 0 && st && !finished.at && doneSent && st.participants.every((q) => q.state === 'done')) {
          // ägaren ser att alla är klara och avslutar
          const f = await call('/api/owner/finish', body({ ownerKey: owner.ownerKey }));
          metrics.calls++; metrics.write.push(f.ms);
          if (f.status === 200) { finished.at = Date.now(); finished.result = f.json.result; finishedSeen = true; }
          else metrics.errors.set(`avslut ${f.status} ${f.json?.error} ${f.json?.detail ?? ''}`, 1);
        }
      }
      await sleep(40);
    }
  }
  await Promise.all(people.map((_, p) => client(p)));
  metrics.elapsed = Date.now() - t0;
  metrics.lags.push(...lags); metrics.finishLags.push(...finishLags);
  // korrekthet: oberoende räkning av poäng
  const exp = new Map(); for (let i = 0; i < N; i++) exp.set(`n${i + 1}`, 0);
  for (const v of full) for (const [i, j] of allPairs(N)) {
    const x = v[pairIndex(i, j, N)];
    if (x === LOW_WON) exp.set(`n${i + 1}`, exp.get(`n${i + 1}`) + 1);
    else if (x === HIGH_WON) exp.set(`n${j + 1}`, exp.get(`n${j + 1}`) + 1);
    else { exp.set(`n${i + 1}`, exp.get(`n${i + 1}`) + 0.5); exp.set(`n${j + 1}`, exp.get(`n${j + 1}`) + 0.5); }
  }
  const res = finished.result;
  metrics.correct.push(!!res && !res.preliminary && res.rows.every((r) => r.points === exp.get(r.id)) && res.rows.reduce((a, r) => a + r.points, 0) === PEOPLE * total);
  const del = await call('/api/owner/delete', { ...cred(owner), ownerKey: owner.ownerKey });
  metrics.deleted.push(del.status === 200);
}

async function runScenario(name) {
  const sc = SCENARIOS[name];
  console.log(`\n== ${sc.label}: ${sc.sessions * PEOPLE} klienter, ${N} lappar, ${allPairs(N).length} jämförelser per person ==`);
  const m = { calls: 0, retried: 0, write: [], read: [], errors: new Map(), lags: [], finishLags: [], correct: [], deleted: [], finish: null, elapsed: 0 };
  const netBefore = netErrors.count;
  await Promise.all(Array.from({ length: sc.sessions }, (_, s) => runSession(sc, s, m)));
  const W = summary(m.write); const R = summary(m.read.length ? m.read : [0]); const L = summary(m.lags.length ? m.lags : [0]);
  const errs = [...m.errors].map(([k, n]) => `${n} × ${k}`).join('; ');
  const ok = m.errors.size === 0 && W.p95 <= 2000 && L.p95 <= 15_000 && m.correct.every(Boolean) && m.deleted.every(Boolean);
  const line = `${ok ? 'OK' : 'AVVIKER'} – ${sc.label}: ${m.calls} anrop på ${fmt(m.elapsed / 60000)} min (${fmt(m.calls / (m.elapsed / 1000))} anrop/s), fel: ${errs || 'inga'}; ` +
    `nätverksavbrott provade om: ${netErrors.count - netBefore}; skrivning p50 ${fmt(W.p50)} ms, p95 ${fmt(W.p95)} ms, max ${fmt(W.max)} ms; läsning p95 ${fmt(R.p95)} ms; ` +
    `Klar syns för andra efter p50 ${fmt(L.p50 / 1000)} s, p95 ${fmt(L.p95 / 1000)} s (mål ≤15 s); summering korrekt: ${m.correct.every(Boolean)}; sessionen raderad: ${m.deleted.every(Boolean)}.`;
  console.log(line);
  return { name, label: sc.label, ok, line, write: W, read: R, lag: L, errors: [...m.errors], calls: m.calls, elapsedMs: m.elapsed };
}

const arg = process.argv[2] ?? 'all';
const names = arg === 'all' ? Object.keys(SCENARIOS) : [arg];
const out = [];
for (const n of names) {
  if (!SCENARIOS[n]) { console.log('okänt scenario', n); continue; }
  try { out.push(await runScenario(n)); } catch (err) { console.log(`${n}: FEL ${String(err.stack ?? err).split('\n').slice(0, 3).join(' | ')}`); }
}
writeFileSync(process.env.OUT ?? `measure/scenarier-${arg}.json`, JSON.stringify({ at: new Date().toISOString(), scale: SCALE, out }, null, 2));
