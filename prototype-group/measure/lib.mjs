// Gemensamma hjälpare för mätskripten. Mäter mot en körande `wrangler dev` (BASE).
import { performance } from 'node:perf_hooks';
import { emptyVector, encodeVector, pairIndex, LOW_WON, HIGH_WON, EQUAL } from '../../src/engine/vector.js';

export const BASE = process.env.BASE ?? 'http://localhost:8787';
export const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8787';

export const netErrors = { count: 0 };

export async function call(path, body, { ip, now, origin = ORIGIN } = {}) {
  const headers = { origin, 'content-type': 'application/json' };
  if (ip) headers['x-test-ip'] = ip;
  if (now) headers['x-test-now'] = String(now);
  const t0 = performance.now();
  // Nätverksfel (anslutning bruten) provas om upp till 3 gånger och räknas i `retried`, så att de syns i rapporten.
  let res; let text; let retried = 0;
  for (;;) {
    try {
      res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
      text = await res.text();
      break;
    } catch (err) {
      if (retried >= 3) throw err;
      retried++; netErrors.count++;
      await new Promise((r) => setTimeout(r, 500 * retried));
    }
  }
  const ms = performance.now() - t0;
  let json = null;
  try { json = JSON.parse(text); } catch { /* ok */ }
  return { status: res.status, json, ms, text, bytes: text.length, retried };
}

export async function stats() {
  const res = await fetch(BASE + '/api/_stats');
  return res.json();
}

export const notes = (n) => Array.from({ length: n }, (_, i) => ({ title: `Lapp ${i + 1}`, description: i % 3 ? 'Kort beskrivning av lappen.' : '', category: i % 4 ? 'Kategori' : '' }));
let ipCounter = Math.floor(Math.random() * 1_000_000);
export const freshIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export async function createSession(n, ownerName = 'Anna', now) {
  const r = await call('/api/sessions', { boardName: 'Mätning', ownerName, notes: notes(n) }, { ip: freshIp(), now });
  if (r.status !== 201) throw new Error(`create ${r.status} ${r.text}`);
  return r.json;
}
export const cred = (s) => ({ sid: s.sid, pid: s.pid, secret: s.secret });

/** Slumpmässigt val per par (deterministisk med seed). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function allPairs(n) {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}
export function randomValues(n, rand) {
  const v = emptyVector(n);
  for (const [i, j] of allPairs(n)) { const r = rand(); v[pairIndex(i, j, n)] = r < 0.45 ? LOW_WON : r < 0.9 ? HIGH_WON : EQUAL; }
  return v;
}
export { emptyVector, encodeVector, pairIndex };

export function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]; }
export function summary(values) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const fmt = (x) => (Math.round(x * 10) / 10).toString();
