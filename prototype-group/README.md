# Mätprototyp för gruppsession (OQ-51, ADR-003)

**Status:** mätprototyp. Pushas inte till GitHub Pages och är inte den riktiga gruppsessionen. Allt märkt Förslag
(OQ-61–OQ-70) är inställningar för mätningen, inte krav.

Cloudflare Worker + D1 (EU), vanliga HTTPS-anrop med polling. Bara POST med JSON under `/api/*`. Inget loggas.

## Köra lokalt (inget konto, ingen token)

```
cd prototype-group
npm install
npx wrangler d1 migrations apply DB --local --persist-to .wrangler-state
npm run dev -- --test-scheduled      # http://localhost:8787
node measure/run.mjs                 # M1′–M16, resultat i measure/resultat.json
npm test                             # API-tester mot minneslagring
```

`TEST_MODE="1"` i `wrangler.toml` styr tid och IP via testrubriker och öppnar `/api/_stats` och `/api/_counts`.
**Får aldrig sättas i drift.** `database_id` i `wrangler.toml` är en platshållare tills Johnny skapat en databas.

## Parametrar (miljövariabler, standardvärden)
`INACTIVITY_MS` 24 h (ADR-003 avsnitt 8), `FINISHED_MS` 24 h, `ABSOLUTE_MS` 0 = av (Förslag OQ-67: 72 h),
`CREATE_PER_HOUR` 5 och `MAX_ACTIVE_SESSIONS` 50 (Förslag OQ-64), `SYNC_MIN_INTERVAL_MS` 4000, `FAILURES_PER_MINUTE` 10 (NFR-6).
