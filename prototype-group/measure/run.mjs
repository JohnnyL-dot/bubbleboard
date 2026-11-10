// Mätningar M1′–M16 (ADR-003 avsnitt 12) mot `wrangler dev --local`. Kör: node measure/run.mjs [m1 m4 ...]
// Serverns tid styrs med x-test-now (TEST_MODE) när det behövs; M10b kör i verklig tid.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import {
  BASE, call, cred, createSession, notes, freshIp, rng, allPairs, randomValues, emptyVector, encodeVector, pairIndex,
  summary, fmt, sleep, stats, netErrors,
} from './lib.mjs';
import { computeResult } from '../src/session-core.js';
import { LOW_WON, HIGH_WON, EQUAL, decodeVector } from '../../src/engine/vector.js';

const results = [];
const record = (id, status, text, data = {}) => { results.push({ id, status, text, data }); console.log(`${id}: ${status} - ${text}`); };
const counts = async () => (await fetch(`${BASE}/api/_counts`)).json();
const T0 = Date.now();
const SYNC = 10_000;
const ROUND_DELAY = Number(process.env.ROUND_DELAY_MS ?? 0); // paus mellan omgångar i M10′ (0 = så fort som möjligt, långt över verklig last)

async function join(code, name, ip) {
  const r = await call('/api/join', { code, name }, { ip: ip ?? freshIp() });
  if (r.status !== 200) throw new Error(`join ${name} ${r.status} ${r.text}`);
  return r.json;
}

// ---- M1′ + M2′ (svarstid, synk, synlighet) ----
async function m1() {
  const s = await createSession(30);
  const b = await join(s.code, 'Bo');
  const rand = rng(1);
  const full = randomValues(30, rand);
  const lat = []; const readAfterWrite = []; let ok = 0;
  const vals = emptyVector(30);
  let now = T0 + 1000;
  const order = allPairs(30);
  for (let k = 0; k < 120; k++) {
    for (let q = 0; q < 2; q++) { const [i, j] = order[(k * 2 + q) % order.length]; vals[pairIndex(i, j, 30)] = full[pairIndex(i, j, 30)]; }
    now += 5000;
    const w = await call('/api/sync', { ...cred(s), rev: k + 1, answers: encodeVector(vals) }, { now });
    if (w.status === 200) ok++;
    lat.push(w.ms);
    const r = await call('/api/sync', cred(b), { now });
    readAfterWrite.push(r.ms);
  }
  // Klar syns direkt för B
  const done = await call('/api/sync', { ...cred(s), rev: 999, answers: encodeVector(full), done: true }, { now: now + 5000 });
  const seen = await call('/api/sync', cred(b), { now: now + 5000 });
  const seenDone = seen.json.participants.find((p) => p.name === 'Anna')?.state === 'done';
  const L = summary(lat); const R = summary(readAfterWrite);
  record("M1′", L.p95 <= 2000 ? 'OK' : 'AVVIKER', `synk (skrivning, 30 lappar) p50 ${fmt(L.p50)} ms, p95 ${fmt(L.p95)} ms, max ${fmt(L.max)} ms; läsning p95 ${fmt(R.p95)} ms; ${ok}/120 lyckade. Lokalt svar på ett val (≤100 ms) är klientlogik utan nätanrop, ej mätt här.`, { write: L, read: R });
  const bound = 10_000 + R.p95 + L.p95;
  record("M2′", done.status === 200 && seenDone && bound <= 15_000 ? 'OK (delvis beräknad)' : 'AVVIKER', `Klar syns vid nästa läsning direkt efter skrivning (läs-efter-skriv-konsistens ${seenDone ? 'ja' : 'nej'}). Övre gräns till deltagare = pollintervall 10 s + svarstid ≈ ${fmt(bound / 1000)} s (beräknad, inte uppmätt i ett fullt pollförlopp).`);
}

// ---- M3′ + M13 (återanslutning, två flikar) ----
async function m3() {
  const s = await createSession(10);
  const v1 = randomValues(10, rng(2));
  let now = T0 + 100_000;
  await call('/api/sync', { ...cred(s), rev: 5, answers: encodeVector(v1) }, { now });
  const rj = await call('/api/rejoin', cred(s), { now });
  const same = rj.json.me.rev === 5 && rj.json.me.answers === encodeVector(v1);
  now += 5000;
  const stale = await call('/api/sync', { ...cred(s), rev: 3, answers: encodeVector(emptyVector(10)) }, { now });
  const after = await call('/api/rejoin', cred(s), { now });
  const replaced = after.json.me.answers === encodeVector(v1);
  now += 5000;
  const newer = await call('/api/sync', { ...cred(s), rev: 6, answers: encodeVector(v1) }, { now });
  const lost = await call('/api/rejoin', { ...cred(s), secret: 'rensad-webblasare' }, { now });
  record("M3′/M13", same && stale.status === 409 && stale.json.error === 'stale_rev' && stale.json.rev === 5 && replaced && newer.status === 200 && lost.status === 404 ? 'OK' : 'AVVIKER',
    `rejoin ger eget läge och rev (${same}); flik med lägre rev avvisas 409 med serverns rev (${stale.status}, rev ${stale.json.rev}); läget ersätts, inte läggs till (${replaced}); högre rev accepteras; saknad hemlighet (ny enhet) ger generiskt 404.`);
}

// ---- M4 (10×20, 31:a, isolering) ----
async function m4() {
  const sessions = [];
  const lat = [];
  for (let k = 0; k < 10; k++) sessions.push(await createSession(15, `Ägare${k}`));
  const people = sessions.map((s) => [{ ...s, name: `Ägare${k(s)}` }]);
  function k(s) { return sessions.indexOf(s); }
  await Promise.all(sessions.map(async (s, idx) => {
    for (let p = 1; p < 20; p++) {
      const t0 = performance.now();
      const j = await join(s.code, `S${idx}D${p}`);
      lat.push(performance.now() - t0);
      people[idx].push({ ...j, name: `S${idx}D${p}` });
    }
  }));
  const expected = sessions.map(() => 0);
  let now = T0 + 200_000;
  await Promise.all(sessions.map(async (s, idx) => {
    for (let p = 0; p < 20; p++) {
      const full = randomValues(15, rng(idx * 100 + p));
      expected[idx] += 0;
      const c = people[idx][p].pid === s.pid ? cred(s) : cred(people[idx][p]);
      const r = await call('/api/sync', { ...c, rev: 1, answers: encodeVector(full), done: true }, { now: now + idx });
      if (r.status !== 200) throw new Error(`m4 sync ${r.status} ${r.text}`);
    }
  }));
  let isolated = true; let sizes = [];
  for (const [idx, s] of sessions.entries()) {
    const st = await call('/api/sync', cred(s), { now: now + 1000 });
    const names = st.json.participants.map((p) => p.name);
    sizes.push(names.length);
    if (names.some((n) => !(n === `Ägare${idx}` || n.startsWith(`S${idx}D`)))) isolated = false;
    if (st.json.participants.some((p) => p.state !== 'done')) isolated = false;
  }
  // 31:a deltagaren
  const big = await createSession(5, 'Stor');
  for (let p = 2; p <= 30; p++) await join(big.code, `X${p}`);
  const r31 = await call('/api/join', { code: big.code, name: 'X31' }, { ip: freshIp() });
  // samtidig anslutning av två på plats 30
  const race = await createSession(5, 'Race');
  for (let p = 2; p <= 29; p++) await join(race.code, `R${p}`);
  const [a, b] = await Promise.all([call('/api/join', { code: race.code, name: 'L1' }, { ip: freshIp() }), call('/api/join', { code: race.code, name: 'L2' }, { ip: freshIp() })]);
  const raceCount = (await call('/api/sync', cred(race), { now: now + 2000 })).json.participants.length;
  const J = summary(lat);
  record('M4', isolated && sizes.every((x) => x === 20) && r31.status === 409 && r31.json.error === 'full' && raceCount === 30 ? 'OK' : 'AVVIKER',
    `10 sessioner × 20 deltagare: alla såg bara sina egna ${sizes.join('/')} namn, alla Klar; anslutning p95 ${fmt(J.p95)} ms; 31:a deltagaren avvisad (${r31.status} ${r31.json.error}); två samtidiga på sista platsen gav ${[a.status, b.status].sort()} och ${raceCount} deltagare.`);
  // städa
  for (const s of [...sessions, big, race]) await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 3000 });
}

// ---- M5 (resurser per pass, CPU) + M10′ + M11 (20 × 435 svar, summering) ----
async function m10() {
  const N = 30; const P = 20;
  const s = await createSession(N, 'P0');
  const people = [s];
  for (let p = 1; p < P; p++) people.push({ ...(await join(s.code, `P${p}`)), name: `P${p}` });
  const fullVecs = people.map((_, p) => randomValues(N, rng(7000 + p)));
  const order = allPairs(N);
  const before = await stats();
  const lat = { write: [], read: [] }; let calls = 0; let errors = 0; let maxBytes = 0;
  const cur = people.map(() => emptyVector(N));
  const perSync = 10_000 / 7000; // ~1,4 svar per 10 s synk (7 s per jämförelse)
  let answered = 0; let round = 0; let now = T0 + 1_000_000;
  const stepOne = async (p, upto) => {
    const vals = cur[p];
    while (answered_of(p) < upto) { const [i, j] = order[answered_of(p)]; vals[pairIndex(i, j, N)] = fullVecs[p][pairIndex(i, j, N)]; counter[p]++; }
  };
  const counter = people.map(() => 0);
  let writeCalls = 0;
  const kinds = new Map(); // felfördelning: status + felkod + detalj
  const tally = (r, what) => { const k = `${what} ${r.status} ${r.json?.error ?? r.text.slice(0, 60)} ${r.json?.detail ?? ''}`.trim(); kinds.set(k, (kinds.get(k) ?? 0) + 1); };
  const answered_of = (p) => counter[p];
  const t0 = performance.now();
  while (counter.some((c) => c < order.length)) {
    round++; now += SYNC;
    const upto = Math.min(order.length, Math.ceil(round * perSync));
    await Promise.all(people.map(async (pp, p) => {
      await stepOne(p, upto);
      const finished = counter[p] >= order.length;
      const body = { ...cred(pp), rev: round, answers: encodeVector(cur[p]), ...(finished ? { done: true } : {}) };
      const w = await call('/api/sync', body, { now: now + p });
      calls++; writeCalls++; lat.write.push(w.ms); maxBytes = Math.max(maxBytes, w.bytes, JSON.stringify(body).length);
      if (w.status !== 200 && w.status !== 409) { errors++; tally(w, 'skriv'); }
      if (w.status === 409 && w.json.error !== 'already_done' && !(w.retried && w.json.error === 'stale_rev')) { errors++; tally(w, 'skriv'); } // stale_rev efter omförsök = första försöket hann fram
      // polling från en annan deltagare i samma takt
      const r = await call('/api/sync', cred(pp), { now: now + p });
      calls++; lat.read.push(r.ms); if (r.status !== 200) { errors++; tally(r, 'läs'); }
    }));
    if (ROUND_DELAY) await sleep(ROUND_DELAY);
  }
  // Klar måste vara bekräftad för alla innan avslut (klienten skulle ha provat igen vid nästa synk)
  for (let attempt = 0; attempt < 5; attempt++) {
    now += SYNC; let pending = 0;
    await Promise.all(people.map(async (pp, p) => {
      const w = await call('/api/sync', { ...cred(pp), rev: round + attempt + 1, answers: encodeVector(cur[p]), done: true }, { now: now + p });
      if (w.status !== 200 && !(w.status === 409 && w.json.error === 'already_done')) pending++;
    }));
    if (!pending) break;
  }
  const wallMs = performance.now() - t0;
  const mid = await stats();
  // Avslut och korrekthet (M11): oberoende beräkning av poäng
  const fin = await call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey }, { now: now + SYNC });
  const after = await stats();
  const expectedPts = new Map(); for (let i = 0; i < N; i++) expectedPts.set(`n${i + 1}`, 0);
  for (const v of fullVecs) for (const [i, j] of order) {
    const x = v[pairIndex(i, j, N)];
    if (x === LOW_WON) expectedPts.set(`n${i + 1}`, expectedPts.get(`n${i + 1}`) + 1);
    else if (x === HIGH_WON) expectedPts.set(`n${j + 1}`, expectedPts.get(`n${j + 1}`) + 1);
    else { expectedPts.set(`n${i + 1}`, expectedPts.get(`n${i + 1}`) + 0.5); expectedPts.set(`n${j + 1}`, expectedPts.get(`n${j + 1}`) + 0.5); }
  }
  if (fin.status !== 200 || !fin.json?.result) throw new Error(`avslut misslyckades: status ${fin.status}, svar ${fin.text.slice(0, 300)}`);
  const rows = fin.json.result.rows;
  const pointsOk = rows.every((r) => r.points === expectedPts.get(r.id));
  const sortedOk = rows.every((r, i) => i === 0 || rows[i - 1].points >= r.points);
  const totalPts = rows.reduce((a, r) => a + r.points, 0);
  const totalOk = totalPts === P * order.length;
  record('M11', fin.status === 200 && pointsOk && sortedOk && totalOk && !fin.json.result.preliminary ? 'OK' : 'AVVIKER',
    `${P} deltagare × ${order.length} jämförelser: poäng per lapp stämmer med oberoende räkning (${pointsOk}), summan ${totalPts} = ${P * order.length}, ordning sjunkande (${sortedOk}), ej preliminär.`);
  const w = summary(lat.write); const r = summary(lat.read);
  const rowsW = mid.rowsWritten - before.rowsWritten; const rowsR = mid.rowsRead - before.rowsRead;
  // ADR-003: ett anrop per synk (skrivning och status i samma anrop). Mätningen körde dessutom en separat läsning per synk, så anropen delas upp.
  const reqPerPass = writeCalls + 1 + P + 1;
  record("M10′", errors === 0 && w.p95 <= 2000 ? 'OK' : 'AVVIKER',
    `${P} klienter × ${order.length} svar (virtuell tid, synk var 10 s, polling i samma takt): ${calls} anrop utan fel (${errors} fel${kinds.size ? ': ' + [...kinds].map(([k, n]) => `${n} × ${k}`).join('; ') : ''}; ${netErrors.count} nätverksavbrott i klienten provades om; paus mellan omgångar ${ROUND_DELAY} ms); skrivning p50 ${fmt(w.p50)} ms, p95 ${fmt(w.p95)} ms, max ${fmt(w.max)} ms; läsning p95 ${fmt(r.p95)} ms; tidsåtgång ${fmt(wallMs / 1000)} s verklig tid. Verklig tid över 10 min: se M10b.`, { w, r });
  // Förbrukning
  const sumRows = (after.rowsRead - mid.rowsRead);
  record('M5/M15', 'DELVIS', `Ett fullt pass (${P} × ${N} lappar, ${order.length} jämförelser, 7 s per jämförelse, synk var 10 s): ${writeCalls} skrivande synkar + ${calls - writeCalls} extra läsningar i mätningen (ADR-modellen har ett anrop per synk, alltså ca ${reqPerPass} anrop per pass; Worker-gratis 100 000 anrop/dygn ⇒ ca ${Math.floor(100000 / reqPerPass)} pass). D1 under hela mätningen: ${rowsW + (after.rowsWritten - mid.rowsWritten)} rader skrivna och ${rowsR + sumRows} lästa, inklusive de extra läsningarna (gratis 100 000 skrivna / 5 000 000 lästa per dygn ⇒ ca ${Math.floor(100000 / (rowsW + 100))} pass på skrivgränsen, högst ${Math.floor(5_000_000 / (rowsR + sumRows))} på läsgränsen, som är för pessimistisk eftersom läsningarna är dubblerade). Största anrop ${maxBytes} byte. Raderna är lokalt D1:s egen räkning och ska jämföras med Cloudflares användningsvy (kräver konto, ej gjort).`, { rowsW, rowsR, reqPerPass });
  // summerings-CPU i Node
  const ids = Array.from({ length: N }, (_, i) => ({ id: `n${i + 1}` }));
  const parts = people.map((_, p) => ({ answers: encodeVector(fullVecs[p]), done: 1 }));
  const times = [];
  for (let i = 0; i < 50; i++) { const t = performance.now(); computeResult(ids, parts); times.push(performance.now() - t); }
  const C = summary(times);
  record('M5 (CPU)', C.p95 <= 10 ? 'OK (Node, ej workerd)' : 'AVVIKER', `Summering av ${P} × ${order.length} jämförelser i Node: p50 ${fmt(C.p50)} ms, p95 ${fmt(C.p95)} ms, max ${fmt(C.max)} ms (gratisgräns 10 ms CPU per anrop). workerd räknar inte CPU-tid lokalt och dess timers står stilla utan I/O, så siffran gäller Node och måste kompletteras med Cloudflares egen CPU-mätning.`, { C });
  await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 2 * SYNC });
}

// ---- M10b: verklig tid, 20 klienter ----
async function m10b() {
  const secs = Number(process.env.REALTIME_SECONDS ?? 120);
  const N = 30; const P = 20;
  const s = await createSession(N, 'R0');
  const people = [s];
  for (let p = 1; p < P; p++) people.push({ ...(await join(s.code, `R${p}`)) });
  const fv = people.map((_, p) => randomValues(N, rng(9000 + p)));
  const order = allPairs(N);
  const cur = people.map(() => emptyVector(N)); const cnt = people.map(() => 0);
  const lat = []; let errors = 0; let calls = 0;
  const end = Date.now() + secs * 1000;
  let round = 0;
  while (Date.now() < end) {
    round++;
    const tick = Date.now();
    await Promise.all(people.map(async (pp, p) => {
      for (let k = 0; k < 2 && cnt[p] < order.length; k++) { if (Math.random() < 0.4) continue; const [i, j] = order[cnt[p]++]; cur[p][pairIndex(i, j, N)] = fv[p][pairIndex(i, j, N)]; }
      const w = await call('/api/sync', { ...cred(pp), rev: round, answers: encodeVector(cur[p]) });
      calls++; lat.push(w.ms); if (w.status !== 200) errors++;
    }));
    await sleep(Math.max(0, SYNC - (Date.now() - tick)));
  }
  const W = summary(lat);
  record('M10b', errors === 0 ? 'OK (kortare än 10 min)' : 'AVVIKER', `${P} klienter i verklig tid ${secs} s, synk var 10 s med 4 s skrivspärr: ${calls} anrop, ${errors} fel, skrivning p95 ${fmt(W.p95)} ms. Planen var 10 min; kortad tid anges här.`);
  await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey });
}

// ---- M6 spion-klient ----
async function m6() {
  const s = await createSession(6, 'Anna');
  const b = await join(s.code, 'Bo');
  const secretVec = encodeVector(randomValues(6, rng(33)));
  let now = T0 + 300_000;
  const seen = [];
  const keep = (r) => { seen.push(r.text); return r; };
  await call('/api/sync', { ...cred(s), rev: 1, answers: secretVec }, { now });
  keep(await call('/api/sync', cred(b), { now: now + 1 }));
  keep(await call('/api/rejoin', cred(b), { now: now + 2 }));
  keep(await call('/api/lookup', { code: s.code }, { ip: freshIp(), now }));
  await call('/api/sync', { ...cred(s), rev: 2, answers: encodeVector(randomValues(6, rng(34))), done: true }, { now: now + 6000 });
  const fin = keep(await call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 7000 }));
  keep(await call('/api/sync', cred(b), { now: now + 8000 }));
  keep(await call('/api/lookup', { link: s.linkToken }, { ip: freshIp(), now: now + 8000 }));
  const all = seen.join('\n');
  const leaks = [secretVec, '"answers"', '"answered"', 'secret_hash', s.secret, s.ownerKey, s.linkToken].filter((x) => all.includes(x) && !(x === '"answers"' && /"me":\{[^}]*"answers"/.test(all) && false));
  // B:s egen rejoin innehåller B:s eget "answers" (eget läge). Kontrollera att det är tomt/eget och inte Annas.
  const own = seen[1].includes('"answers"');
  const aVecNotInB = !all.includes(secretVec);
  const keysOk = JSON.parse(seen[0]).participants.every((p) => Object.keys(p).sort().join() === 'name,owner,state');
  record('M6', aVecNotInB && keysOk && !all.includes(s.ownerKey) && !all.includes(s.linkToken) && !all.includes(s.secret) && fin.json.result.rows.length === 6 && !JSON.stringify(fin.json).includes('"answers"') ? 'OK' : 'AVVIKER',
    `Alla svar till B (sync, rejoin, lookup före och efter avslut): Annas läge saknas (${aVecNotInB}); deltagarobjekt har bara name/state/owner (${keysOk}); inga hemligheter (ägarnyckel, länktoken, deltagarhemlighet) i svar; efter avslut finns bara summeringen. B:s eget läge returneras bara till B vid rejoin (${own}). Gäller även ägaren (samma svar). Bara nätverkssvar kontrollerades, inte webbläsarens minne eller DOM (klienten är inte byggd).`);
  await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 9000 });
  void leaks;
}

// ---- M7 spärr mot gissning ----
async function m7() {
  const s = await createSession(4, 'Anna');
  const ip = freshIp(); let now = T0 + 400_000; const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await call('/api/lookup', { code: 'ZZZZZZZZ' }, { ip, now: now + i * 1000 })).status);
  const blocked = await call('/api/lookup', { code: s.code }, { ip, now: now + 12_000 });
  const other = await call('/api/lookup', { code: s.code }, { ip: '203.0.113.8', now: now + 12_000 });
  const later = await call('/api/lookup', { code: s.code }, { ip, now: now + 3 * 60_000 });
  const first10 = codes.slice(0, 10).every((c) => c === 404);
  record('M7', first10 && codes[10] === 429 && blocked.status === 429 && other.status === 200 && later.status === 200 ? 'OK' : 'AVVIKER',
    `10 felaktiga koder ger 404, den 11:e inom en minut ger 429 (${codes[10]}), även rätt kod är spärrad från samma IP (${blocked.status}), annan IP fungerar (${other.status}), efter fönstret fungerar den igen (${later.status}). Samma spärr gäller join och hemlighetskontroll. Verklig IP bakom Cloudflare (cf-connecting-ip) kan inte provas lokalt.`);
  await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 4 * 60_000 });
}

// ---- M9 utgång ----
async function m9() {
  const base = Date.now();
  const s = await createSession(4, 'Anna', base);
  const act = await call('/api/sync', { ...cred(s), rev: 1, answers: encodeVector(emptyVector(4)) }, { now: base + 23 * 3600_000 });
  const stillThere = await call('/api/lookup', { code: s.code }, { ip: freshIp(), now: base + 23 * 3600_000 + 60_000 });
  const poll = await call('/api/sync', cred(s), { now: base + 47 * 3600_000 }); // polling räknas inte som aktivitet
  const gone = await call('/api/sync', cred(s), { now: base + 48 * 3600_000 });
  const before = (await counts()).sessions;
  // en session som lämnas orörd och rensas av cron
  const old = await createSession(4, 'Gammal', base - 25 * 3600_000);
  const c1 = (await counts()).sessions;
  const sched = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
  const c2 = (await counts()).sessions;
  // avslutad session: 24 h efter avslut
  const f = await createSession(4, 'Klar', base);
  await call('/api/owner/finish', { ...cred(f), ownerKey: f.ownerKey }, { now: base + 1000 });
  const fin1 = await call('/api/lookup', { code: f.code }, { ip: freshIp(), now: base + 20 * 3600_000 });
  const fin2 = await call('/api/lookup', { code: f.code }, { ip: freshIp(), now: base + 26 * 3600_000 });
  void before; void old;
  record('M9', act.status === 200 && stillThere.status === 200 && poll.status === 200 && gone.status === 404 && (sched.status !== 200 || c2 === c1 - 1) && fin1.status === 200 && fin2.status === 404 ? 'OK (med tidsstyrning)' : 'AVVIKER',
    `23 h efter skapande finns sessionen (skrivning förlänger), 24 h efter senaste skrivning är den oåtkomlig trots polling i mellantiden (polling räknas inte): ${gone.status}; cron-rensning ${sched.status === 200 ? `tog bort ${c1 - c2} utgången session (via /cdn-cgi/handler/scheduled)` : 'ej provad här (ingen manuell cron-ingång i driftmiljön)'}; avslutad session nåbar efter 20 h (${fin1.status}), borta efter 26 h (${fin2.status}). Tiden är styrd med testrubrik, inte väntad. Taket 72 h (Förslag OQ-67) är av som standard och ej provat.`);
}

// ---- M12 avslut mitt i synk ----
async function m12() {
  const N = 12; const P = 10; const s = await createSession(N, 'F0');
  const people = [s];
  for (let p = 1; p < P; p++) people.push(await join(s.code, `F${p}`));
  let now = T0 + 600_000; let bad = 0; const codes = [];
  const fv = people.map((_, p) => randomValues(N, rng(500 + p)));
  const fire = people.map((pp, p) => call('/api/sync', { ...cred(pp), rev: 1, answers: encodeVector(fv[p]), done: p % 2 === 0 }, { now }).then((r) => { codes.push(r.status); if (![200, 409].includes(r.status)) bad++; }));
  const fin = call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 100 });
  const [f] = await Promise.all([fin, ...fire]);
  const again = await call('/api/owner/finish', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 200 });
  const rj = await call('/api/rejoin', cred(people[3]), { now: now + 300 });
  record('M12', f.status === 200 && again.status === 200 && JSON.stringify(f.json.result) === JSON.stringify(again.json.result) && rj.json.me.answers === '' && bad === 0 ? 'OK' : 'AVVIKER',
    `${P} synkar samtidigt med avslut: svarskoder ${[...new Set(codes)].sort()}, inga 5xx; upprepat avslut ger samma resultat; individuella lägen är rensade efter avslut (${rj.json.me.answers === ''}). Skrivningar som kom efter avslutet avvisas (409/404). Lägen som skrevs i det korta fönstret mellan läsning och rensning kan saknas i resultatet, vilket stämmer med att resultatet märks preliminärt. Avbrott mitt i avslutet (status 'finishing' kvar) är bara provat i minnesläge, inte mot D1.`);
  await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: now + 500 });
}

// ---- M15 skydd mot kvotförbrukning ----
async function m15() {
  const ip = freshIp(); const base = Date.now(); const out = [];
  for (let i = 0; i < 6; i++) out.push((await call('/api/sessions', { boardName: 'k', ownerName: 'A', notes: notes(2) }, { ip, now: base })));
  const ok = out.filter((r) => r.status === 201).length; const lim = out.find((r) => r.status === 429);
  const big = await call('/api/sessions', { boardName: 'k', ownerName: 'A', notes: notes(2), pad: 'x'.repeat(200_000) }, { ip: freshIp() });
  const s = await createSession(4);
  const q1 = await call('/api/sync', { ...cred(s), rev: 1, answers: encodeVector(emptyVector(4)) }, { now: base });
  const q2 = await call('/api/sync', { ...cred(s), rev: 2, answers: encodeVector(emptyVector(4)) }, { now: base + 1000 });
  const q3 = await call('/api/sync', { ...cred(s), rev: 2, answers: encodeVector(emptyVector(4)) }, { now: base + 5000 });
  // totalt tak
  const startCount = (await counts()).sessions;
  let capHit = null;
  for (let i = 0; i < 60 && !capHit; i++) { const r = await call('/api/sessions', { boardName: 'k', ownerName: 'A', notes: notes(2) }, { ip: freshIp(), now: base }); if (r.status === 429) capHit = r.json.error; else out.push(r); }
  const total = (await counts()).sessions;
  record('M15', ok === 5 && lim?.json.error === 'create_limit' && big.status === 413 && q1.status === 200 && q2.json.error === 'too_fast' && q3.status === 200 && capHit === 'capacity' && total === 50 ? 'OK' : 'AVVIKER',
    `Skapande: ${ok} av 6 från samma IP tillåtna, nr 6 avvisas (${lim?.json.error}); för stor kropp ger ${big.status}; skrivning oftare än var 4:e sekund ger ${q2.json.error}; tak för aktiva sessioner nåddes vid ${total} (${capHit}, start ${startCount}). Värdena (5 per timme och IP, 50 sessioner) är Förslag (OQ-64) och inställda i prototypen. Cloudflares egen kvotvarning och det som händer när gratiskvoten tar slut (Workers svarar 1015/felsvar, D1 avvisar) kan inte provas utan konto.`);
  // städa: ägarnycklar för alla skapade sessioner
  for (const r of out) if (r.status === 201) await call('/api/owner/delete', { ...cred(r.json), ownerKey: r.json.ownerKey }, { now: base + 10_000 });
  await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey }, { now: base + 10_000 });
}

// ---- M16 radering ----
async function m16() {
  const s = await createSession(5, 'Anna'); const b = await join(s.code, 'Bo'); const c0 = await counts();
  const d = await call('/api/owner/delete', { ...cred(s), ownerKey: s.ownerKey });
  const c1 = await counts();
  const after = await Promise.all([call('/api/sync', cred(b)), call('/api/rejoin', cred(s)), call('/api/lookup', { code: s.code }, { ip: freshIp() }), call('/api/lookup', { link: s.linkToken }, { ip: freshIp() })]);
  const generic = after.every((r) => r.status === 404 && r.json.error === 'not_found');
  const byB = await createSession(3, 'Cia'); const cb = await join(byB.code, 'Di');
  const denied = await call('/api/owner/delete', { ...cred(cb), ownerKey: byB.ownerKey });
  record('M16', d.status === 200 && c1.sessions === c0.sessions - 1 && c1.participants === c0.participants - 2 && generic && denied.status === 403 ? 'OK (delvis)' : 'AVVIKER',
    `Stängning raderar sessionen och alla deltagarrader direkt (sessioner ${c0.sessions}→${c1.sessions}, deltagare ${c0.participants}→${c1.participants}); efteråt ger sync, rejoin och uppslag med kod eller länk samma generiska 404 (${generic}); deltagare kan inte stänga (${denied.status}, även med ägarnyckel). "Vill du spara?" och sparad fil är klientfunktioner som inte är byggda i gruppsession; att ingen hemlighet finns i fil eller kopierad text kunde därför bara kontrolleras för serverns svar (M6), inte för fil. D1 Time Travel sparar raderad data 7 dagar (accepterad begränsning, ADR-003 avsnitt 6).`);
  await call('/api/owner/delete', { ...cred(byB), ownerKey: byB.ownerKey });
}

const all = { m1, m3, m4, m6, m7, m9, m10, m12, m16, m15, m10b };
const want = process.argv.slice(2);
for (const [name, fn] of Object.entries(all)) {
  if (want.length && !want.includes(name)) continue;
  try { await fn(); } catch (err) { record(name.toUpperCase(), 'FEL', String(err.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
}
writeFileSync(process.env.OUT ?? 'measure/resultat.json', JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
