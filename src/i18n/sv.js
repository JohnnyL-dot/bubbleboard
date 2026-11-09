// Alla texter i gränssnittet ligger här så att fler språk kan läggas till senare (NFR-11, OQ-39).
// UTF-8 överallt. Felmeddelanden säger vad som hänt och vad man kan göra (OQ-37).

export const sv = {
  'app.title': 'Prioriteringsboard',
  'app.tagline': 'Jämför lappar två och två och få en rangordning.',

  'start.boardName': 'Namn på boarden',
  'start.alias': 'Ditt namn eller alias',
  'start.individual': 'Prioritera själv',
  'start.group': 'Gruppsession',
  'start.groupSoon': 'Gruppsession är inte tillgänglig ännu. Den väntar på att realtidslösningen väljs (OQ-51).',

  'mode.prepared': 'Förberedd',
  'mode.running': 'Pågår',
  'mode.paused': 'Pausad',
  'mode.finished': 'Avslutad',
  'mode.label': 'Läge',

  'view.free': 'Fritt läge',
  'view.sort': 'Sorteringsläge',

  'note.add': 'Lägg till lapp',
  'note.title': 'Titel',
  'note.description': 'Beskrivning (valfri)',
  'note.category': 'Kategori (valfri)',
  'note.color': 'Färg (valfri)',
  'note.noColor': 'Ingen färg',
  'note.save': 'Spara',
  'note.edit': 'Redigera',
  'note.duplicate': 'Duplicera',
  'note.remove': 'Ta bort',
  'note.count': '{count} av {max} lappar',
  'note.empty': 'Inga lappar ännu. Lägg till minst två för att kunna starta.',
  'note.addLocked': 'Lappar kan inte läggas till när röstningen har startat.',

  'color.red': 'Röd',
  'color.orange': 'Orange',
  'color.yellow': 'Gul',
  'color.green': 'Grön',
  'color.teal': 'Blågrön',
  'color.blue': 'Blå',
  'color.purple': 'Lila',
  'color.pink': 'Rosa',

  'sort.start': 'Starta sortering',
  'sort.needTwo': 'Du behöver minst två lappar för att starta.',
  'sort.question': 'Vilket är viktigast?',
  'sort.left': 'Vänster är viktigast',
  'sort.right': 'Höger är viktigast',
  'sort.equal': 'Lika viktiga',
  'sort.progress': 'Jämförelse {current} av {total}',
  'sort.done': '{decided} av {total} jämförelser klara',
  'sort.undo': 'Ångra senaste',
  'sort.pause': 'Pausa',
  'sort.resume': 'Återuppta',
  'sort.pausedInfo': 'Sessionen är pausad. Inga jämförelser kan göras.',
  'sort.finishEarly': 'Avsluta i förtid',
  'sort.showResult': 'Visa resultat',
  'sort.allDone': 'Alla jämförelser är klara.',
  'sort.keys': 'Tangenter: vänsterpil, högerpil och likamedtecken.',

  'confirm.yes': 'Ja',
  'confirm.no': 'Avbryt',
  'confirm.finishEarly': '{decided} av {total} jämförelser är gjorda. Avsluta ändå? Avslutat är slutgiltigt.',
  'confirm.finish': 'Visa resultatet? Avslutat är slutgiltigt. Vill du rösta mer får du starta en ny session.',
  'confirm.remove': 'Lappen ingår i {count} jämförelser som tas bort. Ta bort lappen?',
  'confirm.removeSimple': 'Ta bort lappen "{title}"?',

  'result.title': 'Resultat',
  'result.preliminary': 'Preliminär, {decided} av {total} jämförelser',
  'result.place': 'Plats',
  'result.shared': 'delad',
  'result.points': 'poäng',
  'result.wins': 'vinster',
  'result.losses': 'förluster',
  'result.equals': 'lika viktiga',
  'result.statistics': 'Statistik',
  'result.cycleWarning': 'Motsägelse: lapparna {notes} hänger ihop i en cykel (A före B, B före C, C före A). Rangordningen bygger ändå på poäng.',
  'result.manualActive': 'Du har justerat ordningen manuellt. Statistiken är oförändrad.',
  'result.autoOrder': 'Automatisk ordning',
  'result.manualOrder': 'Manuell ordning',
  'result.up': 'Flytta upp',
  'result.down': 'Flytta ner',
  'result.reset': 'Återställ till automatisk',
  'result.copy': 'Kopiera resultat som text',
  'result.copied': 'Resultatet är kopierat.',
  'result.copyFailed': 'Det gick inte att kopiera. Markera texten nedan och kopiera själv.',
  'result.comparisons': 'Jämförelser',
  'result.votes': 'vänster {left}, höger {right}, lika {equal}',
  'result.newSession': 'Ny session',
  'result.copyHeader': 'Rangordning för {board}',

  'error.BOARD_NAME_EMPTY': 'Boarden behöver ett namn. Skriv ett namn och försök igen.',
  'error.BOARD_NAME_TOO_LONG': 'Namnet på boarden är för långt (högst 100 tecken).',
  'error.NAME_EMPTY': 'Skriv ditt namn eller alias.',
  'error.NAME_TOO_LONG': 'Namnet är för långt (högst 15 tecken).',
  'error.NAME_TAKEN': 'Namnet är redan upptaget i sessionen. Välj ett annat.',
  'error.SESSION_FULL': 'Sessionen är full.',
  'error.TITLE_EMPTY': 'Titeln får inte vara tom. Skriv en titel.',
  'error.TITLE_TOO_LONG': 'Titeln är för lång (högst 100 tecken).',
  'error.DESCRIPTION_TOO_LONG': 'Beskrivningen är för lång (högst 500 tecken).',
  'error.CATEGORY_TOO_LONG': 'Kategorin är för lång (högst 30 tecken).',
  'error.COLOR_INVALID': 'Välj en färg ur paletten.',
  'error.MAX_NOTES': 'Det finns redan 20 lappar. Ta bort en lapp för att lägga till en ny.',
  'error.MIN_NOTES': 'Det måste finnas minst två lappar.',
  'error.NOTES_LOCKED': 'Lappar kan inte läggas till när röstningen har startat.',
  'error.WRONG_MODE': 'Det går inte att göra det i det här läget.',
  'error.NOTHING_TO_UNDO': 'Det finns inget att ångra.',
  'error.VOTING_PAUSED': 'Sessionen är pausad. Återuppta för att fortsätta.',
  'error.VOTING_CLOSED': 'Omröstningen är redan stängd.',
  'error.NOT_OWNER': 'Bara ägaren kan göra det.',
  'error.generic': 'Något gick fel. Försök igen.',
};

export function t(key, params = {}, dict = sv) {
  const text = dict[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`));
}

export function errorText(err, dict = sv) {
  const key = `error.${err?.code}`;
  return dict[key] ? t(key, {}, dict) : t('error.generic', {}, dict);
}
