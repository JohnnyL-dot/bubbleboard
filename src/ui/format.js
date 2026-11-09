// Textformatering för resultatet. Egen modul så att den kan testas utan DOM.

/** Platsetikett: "2" eller "2 (delad)" (OQ-19). */
export function placeLabel(row, t) {
  return row.shared ? `${row.place} (${t('result.shared')})` : String(row.place);
}

/**
 * Resultatet som ren text för "Kopiera resultat som text" (OQ-50).
 * Följer den visade ordningen (manuell om ägaren justerat).
 */
export function resultText(session, t) {
  const auto = new Map(session.autoRanking().map((r) => [r.id, r]));
  const titleOf = new Map(session.notes.map((n) => [n.id, n.title]));
  const prelim = session.preliminary();
  const lines = [t('result.copyHeader', { board: session.boardName })];
  if (prelim) lines.push(t('result.preliminary', prelim));
  const manual = session.manualOrder != null;
  session.displayedOrder().forEach((id, i) => {
    const r = auto.get(id);
    const place = manual ? String(i + 1) : placeLabel(r, t);
    lines.push(`${place}. ${titleOf.get(id)} (${r.points} ${t('result.points')})`);
  });
  return lines.join('\n');
}
