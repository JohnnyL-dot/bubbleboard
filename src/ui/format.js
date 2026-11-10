// Textformatering för resultatet. Egen modul så att den kan testas utan DOM.

/** Platsetikett: "2" eller "2 (delad)" (OQ-19). */
export function placeLabel(row, t) {
  return row.shared ? `${row.place} (${t('result.shared')})` : String(row.place);
}

/** Tabb och radbrytning i ett fält ersätts med mellanslag så att raderna alltid är hela (OQ-52). */
export function tsvField(value) {
  return String(value ?? '').replace(/[\t\r\n\u2028\u2029]+/g, ' ');
}

/**
 * Resultatet som tabbavgränsad text (KR-23, OQ-52): UTF-8, LF, rubrikrad, ingen
 * avslutande radbrytning. Kolumner: Placering, Titel, Beskrivning, Kategori, Poäng,
 * Vinster, Förluster, Lika viktiga. Texten innehåller aldrig hemligheter.
 * Raderna följer den visade ordningen (manuell om ägaren justerat, annars automatisk).
 * Preliminärt resultat märks med en sista rad.
 *
 * Inte byggt (OQ-68, ej beslutat): decimalkomma, extra kolumner, skydd mot formler.
 *
 * @param {{notes:{id:string,title:string,description:string,category:string}[],
 *   rows:{id:string,place:number,shared:boolean,points:number,wins:number,losses:number,equals:number}[],
 *   manual:string[]|null, preliminary:{decided:number,total:number}|null}} model
 */
export function resultTsv(model, t) {
  const note = new Map(model.notes.map((n) => [n.id, n]));
  const row = new Map(model.rows.map((r) => [r.id, r]));
  const lines = [[
    t('tsv.place'), t('tsv.title'), t('tsv.description'), t('tsv.category'),
    t('tsv.points'), t('tsv.wins'), t('tsv.losses'), t('tsv.equals'),
  ].join('\t')];
  const order = model.manual ?? model.rows.map((r) => r.id);
  order.forEach((id, i) => {
    const n = note.get(id);
    const r = row.get(id);
    lines.push([
      model.manual ? String(i + 1) : placeLabel(r, t),
      tsvField(n.title), tsvField(n.description), tsvField(n.category),
      r.points, r.wins, r.losses, r.equals,
    ].join('\t'));
  });
  if (model.preliminary) lines.push(tsvField(t('result.preliminary', model.preliminary)));
  return lines.join('\n');
}
