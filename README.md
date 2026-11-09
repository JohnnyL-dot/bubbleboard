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
| `src/engine/` | Sorteringsmotor: par, poäng, cykler, röstsammanställning. Ingen koppling till gränssnitt eller session (KR-8, NFR-10). |
| `src/session/` | Sessionslägen, lappar, omröstning, resultat. Ren logik, allt i minnet. |
| `src/ui/` | Gränssnitt (individuellt läge). Ingen sorteringslogik. |
| `src/i18n/` | Alla texter på svenska i språkfil (NFR-11). |
| `test/` | Enhetstester (`node:test`). |

## Status
Byggt: KR-1, 3, 4, 6, 7, 8, 10, 11, 12, 20, 23, 24, 26, 29 och NFR-1, 9, 10, 11 för individuell prioritering.
Ej byggt: gruppsession och realtid (KR-13–KR-21, NFR-2, 5, 6) i väntan på OQ-51.
