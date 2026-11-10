# Prioriteringsboard (Collaborative Prioritization Board)

Webbapp där lappar prioriteras genom parvisa jämförelser. Statisk sajt utan bygge, driftas initialt på GitHub Pages (OQ-41).

## Köra
Öppna `index.html` via en statisk server, till exempel `python3 -m http.server`, och besök http://localhost:8000.

## Testa
```
npm install
npm test
```

## Struktur
| Mapp | Innehåll |
|---|---|
| `src/engine/` | Ren logik utan I/O: par, poäng, cykler och summering av deltagares poäng (`summering.js`, KR-17, OQ-60). Kan köras i webbläsaren och på en server (KR-8, NFR-10). |
| `src/session/` | `session.js` (lappar, sortering, manuell ordning, snapshot), `file.js` (spara och läsa in JSON-fil, KR-31), `storage.js` (lokal lagring, KR-21). |
| `src/ui/` | Gränssnitt (individuellt läge), `format.js` (tabbavgränsad text, KR-23), `reorder.js` (dra och släpp, ren logik). Ingen sorteringslogik. |
| `src/i18n/` | Alla texter på svenska i språkfil (NFR-11). |
| `test/` | Enhetstester (`node:test`), inklusive egenskapstester för summeringen. |

## Status (kravspecifikation v3.0)
Byggt: KR-1 (2–25 lappar, OQ-71), 3, 4, 5, 6, 7, 8, 10, 11, 12, 21 (lokal lagring), 23 (kopiera tabbavgränsad text), 24, 26, 29, 30, 31 (spara och läsa in fil) och NFR-1, 9, 10, 11.
Ej byggt: gruppsession och server (KR-13–17, 20, 21, 32, NFR-2–6). OQ-51 är godkänd för en mätprototyp (gren `prototype-group`, körs lokalt, publiceras inte); det riktiga bygget väntar på att mätresultatet godkänns. Allt märkt Förslag (OQ-61 till OQ-70) är inte byggt.
