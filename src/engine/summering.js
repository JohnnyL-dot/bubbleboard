// Summering av deltagarnas värderingar (KR-17, OQ-59, OQ-60). Ren logik utan I/O,
// så att samma kod kan köras i webbläsaren och på en server.
//
// Resultatet är summan av varje deltagares poäng per lapp. Poäng är additiva, så
// det räcker att räkna alla deltagares jämförelser tillsammans. En deltagare som
// inte hunnit klart räknas med de jämförelser hen gjort (OQ-60). Placering och
// delad placering följer OQ-19 via computeRanking.

import { computeRanking } from './scoring.js';

const OUTCOMES = ['left', 'right', 'equal'];

/**
 * @param {string[]} noteIds lappar i skapandeordning
 * @param {{left:string,right:string,outcome:string}[][]} participants en lista med avgjorda jämförelser per deltagare
 * @returns {{rows:ReturnType<typeof computeRanking>, participantCount:number, comparisonCount:number}}
 */
export function summarize(noteIds, participants) {
  const known = new Set(noteIds);
  const valid = [];
  for (const list of participants) {
    for (const c of list) {
      if (known.has(c.left) && known.has(c.right) && c.left !== c.right && OUTCOMES.includes(c.outcome)) {
        valid.push(c);
      }
    }
  }
  return {
    rows: computeRanking(noteIds, valid),
    participantCount: participants.length,
    comparisonCount: valid.length,
  };
}
