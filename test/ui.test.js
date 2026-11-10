import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mount } from '../src/ui/app.js';
import { sv } from '../src/i18n/sv.js';
import { createStore, STORAGE_KEY } from '../src/session/storage.js';
import { MAX_FILE_BYTES, serializeFile } from '../src/session/file.js';
import { Session } from '../src/session/session.js';

function memoryBackend({ failSet = false } = {}) {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { if (failSet) throw new Error('QuotaExceededError'); data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

function setup(options = {}) {
  const dom = options.dom ?? new JSDOM('<!doctype html><html lang="sv"><body><div id="app"></div></body></html>');
  globalThis.FormData = dom.window.FormData;
  globalThis.CSS = dom.window.CSS ?? { escape: (s) => s };
  const backend = options.backend ?? memoryBackend();
  const copied = [];
  const downloads = [];
  const clipboard = { writeText: async (x) => { copied.push(x); } };
  const root = dom.window.document.getElementById('app');
  const app = mount(root, {
    clipboard, minAnswerInterval: 0, store: createStore(() => backend),
    download: (name, text) => downloads.push({ name, text }), ...options.mount,
  });
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const submit = (form) => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const action = (name) => click($(`[data-action="${name}"]`));
  const fill = (form, values) => {
    for (const [k, v] of Object.entries(values)) form.elements[k].value = v;
  };
  const key = (k) => dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const begin = (board = 'Workshop', alias = 'Johnny') => {
    fill($('[data-form="start"]'), { boardName: board, alias });
    submit($('[data-form="start"]'));
  };
  const addNote = (title, extra = {}) => {
    const f = $('[data-form="note"]');
    fill(f, { title, description: '', category: '', color: '', ...extra });
    submit(f);
  };
  const titles = (sel = '.sortable .note-title') => $$(sel).map((e) => e.textContent);
  const wait = () => new Promise((r) => setTimeout(r, 0));
  return { dom, root, app, backend, copied, downloads, $, $$, submit, click, action, fill, key, begin, addNote, titles, wait };
}

const reload = (prev, extra = {}) => setup({ dom: new JSDOM('<!doctype html><body><div id="app"></div></body>'), backend: prev.backend, ...extra });

async function pickFile(ctx, { text, size, name = 'fil.json' }) {
  const input = ctx.$('[data-file]');
  const file = { name, size: size ?? text.length, text: async () => text };
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new ctx.dom.window.Event('change', { bubbles: true }));
  await ctx.wait(); await ctx.wait();
}

const boardFile = (n = 3) => {
  const s = new Session({ boardName: 'Från fil', ownerName: 'X', seed: 1 });
  for (let i = 1; i <= n; i++) s.addNote('p1', { title: `Fil ${i}` });
  return s;
};

// ---- Start, lappar, gränser ----

test('startsidan är på svenska, gruppsession är avstängd med förklaring', () => {
  const { root, $ } = setup();
  assert.match(root.textContent, /Prioriteringsboard/);
  assert.equal($('button[disabled]').textContent, 'Gruppsession');
  assert.match(root.textContent, /OQ-51/);
});

test('board utan namn ger begripligt felmeddelande (KR-29)', () => {
  const { $, begin } = setup();
  begin('  ', 'Johnny');
  assert.match($('.error').textContent, /behöver ett namn/);
});

test('tom titel ger felmeddelande och lappen skapas inte (AT-1)', () => {
  const { $, $$, begin, addNote } = setup();
  begin();
  addNote('   ');
  assert.match($('.error').textContent, /Titeln får inte vara tom/);
  assert.equal($$('.note').length, 0);
});

test('HTML i lapptext visas som text, 30 lappar går och den 31:a avvisas (AT-1, OQ-58)', () => {
  const { $, $$, root, begin, addNote } = setup();
  begin();
  addNote('<img src=x onerror=alert(1)>', { color: 'blue' });
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match($('.note-title').textContent, /<img/);
  assert.match($('.note').textContent, /Blå/, 'färgen står även som text');
  for (let i = 2; i <= 30; i++) addNote(`Lapp ${i}`);
  assert.equal($$('.note').length, 30);
  assert.match($('.count').textContent, /30 av 30 lappar/);
  addNote('Lapp 31');
  assert.match($('.error').textContent, /30 lappar/);
  assert.equal($$('.note').length, 30);
});

test('för lång titel ger felmeddelande i stället för att tyst klippas (TC-005)', () => {
  const { $, $$, begin, addNote } = setup();
  begin();
  addNote('x'.repeat(100));
  addNote('x'.repeat(101));
  assert.match($('.error').textContent, /för lång/);
  assert.equal($$('.note').length, 1);
});

// ---- Översikt (nytt namn, KR-3) ----

test('läget heter Översikt överallt och "fritt läge" finns inte kvar i texterna (OQ-55)', () => {
  const { $, action, begin, addNote } = setup();
  for (const [k, v] of Object.entries(sv)) assert.equal(/fritt läge/i.test(v), false, `${k}: ${v}`);
  begin();
  ['A', 'B'].forEach((x) => addNote(x));
  action('start');
  assert.match($('.toggle').textContent, /Översikt/);
  assert.match($('.toggle').textContent, /Sorteringsläge/);
  assert.equal(/fritt/i.test($('.toggle').textContent), false);
});

test('start kräver två lappar, därefter pågår sortering och framsteg visas (AT-3, KR-12)', () => {
  const { $, action, begin, addNote } = setup();
  begin();
  addNote('A');
  assert.ok($('[data-action="start"]').disabled);
  addNote('B');
  addNote('C');
  action('start');
  assert.match($('.top').textContent, /Pågår/);
  assert.match($('.progress').textContent, /0 av 3 jämförelser klara/);
  assert.equal($('.pair').querySelectorAll('.choice').length, 2);
  action('answer');
  assert.match($('.progress').textContent, /1 av 3 jämförelser klara/);
});

test('efter start: ingen ny lapp, men redigera och ta bort med bekräftelse (AT-11)', () => {
  const { $, $$, root, click, action, fill, submit, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  click($('[data-action="view"][data-view="overview"]'));
  assert.match(root.textContent, /kan inte läggas till/);
  assert.equal($('[data-form="note"]'), null);
  click($('[data-action="edit"]'));
  fill($('[data-form="note"]'), { title: 'A2', description: '', category: '', color: '' });
  submit($('[data-form="note"]'));
  assert.match($('.note-title').textContent, /A2/);
  click($$('[data-action="remove"]')[1]);
  assert.match($('.dialog').textContent, /ingår i 2 jämförelser som tas bort/);
  action('confirm-no');
  assert.equal($$('.note').length, 3);
  click($$('[data-action="remove"]')[1]);
  action('confirm-yes');
  assert.equal($$('.note').length, 2);
});

// ---- Sortering ----

test('tangentbord: vänsterpil, högerpil och = registrerar svar (NFR-1)', () => {
  const { $, action, key, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C', 'D'].forEach((x) => addNote(x));
  action('start');
  key('ArrowLeft'); key('ArrowRight'); key('=');
  assert.match($('.progress').textContent, /3 av 6/);
});

test('tangenter i Översikten besvarar inga jämförelser', () => {
  const { $, click, key, action, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  click($('[data-action="view"][data-view="overview"]'));
  key('ArrowLeft');
  click($('[data-action="view"][data-view="sort"]'));
  assert.match($('.progress').textContent, /0 av 3/);
});

test('paus finns inte längre (OQ-60)', () => {
  const { $, root, action, begin, addNote } = setup();
  begin();
  ['A', 'B'].forEach((x) => addNote(x));
  action('start');
  assert.equal($('[data-action="pause"]'), null);
  assert.equal(/Pausa/.test(root.textContent), false);
});

test('ångra senaste går tillbaka ett steg åt gången (KR-6)', () => {
  const { $, action, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  assert.ok($('[data-action="undo"]').disabled);
  action('answer'); action('answer');
  assert.match($('.progress').textContent, /2 av 3/);
  action('undo');
  assert.match($('.progress').textContent, /1 av 3/);
  action('undo');
  assert.match($('.progress').textContent, /0 av 3/);
});

test('bekräftelse visas efter varje val (KR-7, TC-041)', () => {
  const { root, begin, addNote, action } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  action('answer');
  assert.match(root.querySelector('.notice').textContent, /Valet är registrerat/);
});

test('dubbelklick och tangentspam hoppar inte över par (NFR-9, TC-106, TC-108)', () => {
  let t0 = 1000;
  const { $, key, begin, addNote, action } = setup({ mount: { minAnswerInterval: 350, now: () => t0 } });
  begin();
  ['A', 'B', 'C', 'D'].forEach((x) => addNote(x));
  action('start');
  action('answer');
  action('answer');
  key('ArrowLeft');
  assert.match($('.progress').textContent, /1 av 6/);
  t0 += 400;
  action('answer');
  assert.match($('.progress').textContent, /2 av 6/);
});

test('fast seed från mount ger samma par i samma ordning (TF-8)', () => {
  const order = (seed) => {
    const { root, begin, addNote, action } = setup({ mount: { seed } });
    begin();
    ['A', 'B', 'C', 'D'].forEach((x) => addNote(x));
    action('start');
    return [...root.querySelectorAll('.choice .note-title')].map((e) => e.textContent);
  };
  assert.deepEqual(order(7), order(7));
});

test('30 lappar ger 435 jämförelser i sorteringsläget (KR-30)', () => {
  const { $, action, begin, addNote } = setup();
  begin();
  for (let i = 1; i <= 30; i++) addNote(`L${i}`);
  action('start');
  assert.match($('.progress').textContent, /0 av 435 jämförelser klara/);
});

// ---- Resultat, kopiering, manuell ordning ----

function finishedFlow(ctx, names = ['Alfa', 'Beta', 'Gamma']) {
  ctx.begin('Workshop', 'Johnny');
  names.forEach((x) => ctx.addNote(x));
  ctx.action('start');
  while (ctx.$('.choice')) ctx.action('answer');
  ctx.action('show-result');
  ctx.action('confirm-yes');
}

test('hela flödet: sortera klart, visa resultat och kopiera tabbavgränsad text (AT-9, AT-18)', async () => {
  const ctx = setup();
  const { $, $$, root, copied, click, begin, addNote, action } = ctx;
  begin('Workshop', 'Johnny');
  ['Alfa', 'Beta', 'Gamma'].forEach((x) => addNote(x, { description: 'rad\tmed tabb' }));
  action('start');
  for (let i = 0; i < 3; i++) action('answer');
  assert.match(root.textContent, /Alla jämförelser är klara/);
  action('show-result');
  assert.match($('.dialog').textContent, /slutgiltigt/);
  action('confirm-yes');
  assert.match($('.top').textContent, /Avslutad/);
  assert.equal($('.prelim'), null);
  assert.equal($$('.ranking:not(.sortable) .rank-row').length, 3);
  click($('[data-action="copy"]'));
  await ctx.wait();
  assert.equal(copied.length, 1);
  const lines = copied[0].split('\n');
  assert.equal(lines[0], 'Placering\tTitel\tBeskrivning\tKategori\tPoäng\tVinster\tFörluster\tLika viktiga');
  assert.equal(lines.length, 4);
  assert.ok(lines.slice(1).every((l) => l.split('\t').length === 8));
  assert.match(root.textContent, /Resultatet är kopierat/);
  assert.equal(/Johnny|seed|owner/i.test(copied[0]), false, 'inga hemligheter eller alias');
});

test('kopiering faller tillbaka på en markerbar textruta om urklipp saknas', async () => {
  const ctx = setup({ mount: { clipboard: undefined } });
  finishedFlow(ctx);
  ctx.click(ctx.$('[data-action="copy"]'));
  await ctx.wait();
  assert.match(ctx.$('.copybox').value, /^Placering\tTitel/);
});

test('manuell ordning i resultatet: startas, flyttas, markeras och återställs (KR-26, AT-19)', () => {
  const ctx = setup();
  const { $, $$, root, click, titles } = ctx;
  finishedFlow(ctx);
  const auto = titles('.ranking:not(.sortable) .note-title');
  assert.equal($('.sortable'), null);
  click($('[data-action="start-manual"]'));
  assert.match(root.textContent, /Manuell ordning/);
  assert.deepEqual(titles(), auto);
  click($$('.sortable [data-action="move"][data-dir="down"]')[0]);
  assert.deepEqual(titles(), [auto[1], auto[0], auto[2]]);
  assert.deepEqual(titles('.ranking:not(.sortable) .note-title'), auto, 'den automatiska ordningen är oförändrad');
  click($('[data-action="reset-order"]'));
  assert.equal($('.sortable'), null);
});

test('avslut i förtid kräver bekräftelse och märker resultatet preliminärt (OQ-18)', async () => {
  const ctx = setup();
  const { $, action, begin, addNote, click } = ctx;
  begin();
  ['A', 'B', 'C', 'D'].forEach((x) => addNote(x));
  action('start');
  action('answer'); action('answer');
  action('finish-early');
  assert.match($('.dialog').textContent, /2 av 6 jämförelser är gjorda/);
  action('confirm-yes');
  assert.match($('.prelim').textContent, /Preliminär, 2 av 6 jämförelser/);
  click($('[data-action="copy"]'));
  await ctx.wait();
  assert.match(ctx.copied[0].split('\n').at(-1), /Preliminär, 2 av 6/);
});

test('cykel ger varning med lapparna i resultatvyn (KR-11)', () => {
  const { root, begin, addNote, action, click } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  const wins = { 'A|B': 'A', 'B|C': 'B', 'A|C': 'C' };
  while (root.querySelector('.choice')) {
    const [l, r] = [...root.querySelectorAll('.choice .note-title')].map((e) => e.textContent);
    click(root.querySelector(wins[[l, r].sort().join('|')] === l ? '[data-choice="left"]' : '[data-choice="right"]'));
  }
  action('show-result');
  action('confirm-yes');
  assert.match(root.querySelector('.warning').textContent, /Motsägelse: lapparna A, B, C/);
});

// ---- Översikt: flytta med knappar och dra (KR-5, AT-19) ----

test('Översikt: upp/ned-knappar flyttar lappar, kanterna är avstängda och flytten meddelas', () => {
  const ctx = setup();
  const { $, $$, click, begin, addNote, titles, dom } = ctx;
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  assert.ok($$('[data-action="move"][data-dir="up"]')[0].disabled);
  assert.ok($$('[data-action="move"][data-dir="down"]')[2].disabled);
  click($$('[data-action="move"][data-dir="down"]')[0]);
  assert.deepEqual(titles(), ['B', 'A', 'C']);
  const live = dom.window.document.querySelector('[aria-live]');
  assert.match(live.textContent, /A flyttad till plats 2 av 3/);
  assert.equal(dom.window.document.activeElement?.dataset?.id, 'n1', 'fokus följer med lappen');
  assert.match($('.hint + .hint, .hint').textContent, /./);
  assert.match(ctx.root.textContent, /manuellt/);
  click($('[data-action="reset-order"]'));
  assert.deepEqual(titles(), ['A', 'B', 'C']);
});

test('Översikt: lappar utan fokus-förlust när knappen når kanten (fokus flyttas till andra knappen)', () => {
  const ctx = setup();
  const { $$, click, begin, addNote, dom } = ctx;
  begin();
  ['A', 'B'].forEach((x) => addNote(x));
  click($$('[data-action="move"][data-dir="down"]')[0]);
  const active = dom.window.document.activeElement;
  assert.equal(active?.dataset?.action, 'move');
  assert.equal(active.disabled, false);
});

test('Översikt: flera drag- och flyttknappar har tillgängliga namn med lappens titel', () => {
  const { $$, begin, addNote } = setup();
  begin();
  ['A', 'B'].forEach((x) => addNote(x));
  assert.match($$('[data-drag]')[0].getAttribute('aria-label'), /Dra för att flytta: A/);
  assert.match($$('[data-action="move"]')[1].getAttribute('aria-label'), /Flytta ner: A/);
});

test('Översikt: dra och släpp med pekare flyttar lappen (30 lappar)', () => {
  const ctx = setup();
  const { $$, begin, addNote, titles, dom, app } = ctx;
  begin();
  for (let i = 1; i <= 30; i++) addNote(`L${i}`);
  const rows = $$('.sortable > li');
  assert.equal(rows.length, 30);
  rows.forEach((r, i) => { r.getBoundingClientRect = () => ({ top: i * 50, height: 50, bottom: i * 50 + 50 }); });
  const ev = (type, y) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    return e;
  };
  const handle = rows[0].querySelector('[data-drag]');
  handle.dispatchEvent(ev('pointerdown', 25));
  assert.ok(rows[0].classList.contains('dragging'));
  handle.dispatchEvent(ev('pointermove', 130));
  assert.ok(rows[0].style.transform.includes('105px'));
  handle.dispatchEvent(ev('pointerup', 130));
  const t = titles();
  assert.equal(t.length, 30);
  assert.equal(t[2], 'L1', 'L1 passerade L2 och L3');
  assert.deepEqual(app.state.session.overviewOrder().slice(0, 3), ['n2', 'n3', 'n1']);
});

test('Översikt: avbruten dragning ändrar ingenting', () => {
  const ctx = setup();
  const { $$, begin, addNote, titles, dom } = ctx;
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  const rows = $$('.sortable > li');
  rows.forEach((r, i) => { r.getBoundingClientRect = () => ({ top: i * 50, height: 50, bottom: i * 50 + 50 }); });
  const ev = (type, y) => {
    const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y, button: 0 });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    return e;
  };
  const h = rows[0].querySelector('[data-drag]');
  h.dispatchEvent(ev('pointerdown', 25));
  h.dispatchEvent(ev('pointermove', 140));
  h.dispatchEvent(ev('pointercancel', 140));
  assert.deepEqual(titles(), ['A', 'B', 'C']);
});

test('manuell ordning från Översikten bevaras när sorteringen startar och i sparad fil', () => {
  const ctx = setup();
  const { $$, click, begin, addNote, action, titles } = ctx;
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  click($$('[data-action="move"][data-dir="up"]')[2]);
  action('start');
  click(ctx.$('[data-action="view"][data-view="overview"]'));
  assert.deepEqual(titles(), ['A', 'C', 'B']);
});

// ---- Lokal lagring (KR-21) ----

test('arbetet överlever omladdning mitt i sorteringen (KR-21, AT-7)', () => {
  const a = setup();
  a.begin('Workshop', 'Johnny');
  ['A', 'B', 'C', 'D'].forEach((x) => a.addNote(x));
  a.action('start');
  a.action('answer'); a.action('answer'); a.action('answer');
  const pair = a.titles('.choice .note-title');
  const b = reload(a);
  assert.match(b.$('.progress').textContent, /3 av 6/);
  assert.deepEqual(b.titles('.choice .note-title'), pair);
  b.action('answer');
  assert.match(b.$('.progress').textContent, /4 av 6/);
  const c = reload(b);
  assert.match(c.$('.progress').textContent, /4 av 6/);
});

test('omladdning i Översikten och i resultatet behåller lappar och manuell ordning', () => {
  const a = setup();
  a.begin();
  ['A', 'B', 'C'].forEach((x) => a.addNote(x));
  a.click(a.$$('[data-action="move"][data-dir="down"]')[0]);
  const b = reload(a);
  assert.deepEqual(b.titles(), ['B', 'A', 'C']);
  b.action('start');
  while (b.$('.choice')) b.action('answer');
  b.action('show-result');
  b.action('confirm-yes');
  const c = reload(b);
  assert.match(c.$('.top').textContent, /Avslutad/);
  assert.equal(c.$$('.ranking:not(.sortable) .rank-row').length, 3);
});

test('ny session rensar lagrad data efter bekräftelse', () => {
  const a = setup();
  a.begin();
  ['A', 'B'].forEach((x) => a.addNote(x));
  assert.ok(a.backend.data.has(STORAGE_KEY));
  a.action('start'); a.action('answer'); a.action('show-result'); a.action('confirm-yes');
  a.action('new-session');
  assert.match(a.$('.dialog').textContent, /tar bort det här arbetet/);
  a.action('confirm-no');
  assert.ok(a.backend.data.has(STORAGE_KEY));
  a.action('new-session');
  a.action('confirm-yes');
  assert.ok(a.$('[data-form="start"]'));
  assert.equal(a.backend.data.has(STORAGE_KEY), false);
  assert.ok(reload(a).$('[data-form="start"]'));
});

test('lagring som inte går att använda ger en synlig varning (KR-21)', () => {
  const a = setup({ backend: memoryBackend({ failSet: true }) });
  assert.match(a.$('.warning').textContent, /tillåter inte lokal lagring/);
  a.begin();
  a.addNote('A');
  assert.match(a.$('.warning').textContent, /Spara en fil/);
  assert.equal(a.$$('.note').length, 1, 'appen fungerar ändå');
});

test('lagring som blir full under arbetet varnar', () => {
  const backend = memoryBackend();
  const a = setup({ backend });
  a.begin();
  assert.equal(a.$('.warning'), null);
  backend.setItem = () => { throw new Error('QuotaExceededError'); };
  a.addNote('A');
  assert.match(a.$('.warning').textContent, /Det gick inte att spara arbetet i webbläsaren/);
});

test('trasig lagrad data tas bort med ett begripligt meddelande (NFR-9)', () => {
  const backend = memoryBackend();
  backend.data.set(STORAGE_KEY, '{"v":1,"mode":"running"');
  const a = setup({ backend });
  assert.ok(a.$('[data-form="start"]'));
  assert.match(a.$('.warning').textContent, /gick inte att läsa/);
  assert.equal(backend.data.has(STORAGE_KEY), false);
  const b = setup({ backend: (() => { const x = memoryBackend(); x.data.set(STORAGE_KEY, JSON.stringify({ v: 1, boardName: 'x' })); return x; })() });
  assert.match(b.$('.warning').textContent, /gick inte att läsa/);
});

// ---- Fil (KR-31) ----

test('spara board som fil: nedladdning med rätt namn och utan hemligheter', () => {
  const a = setup();
  a.begin('Plan: Q1', 'Johnny');
  assert.ok(a.$('[data-action="save-file"]').disabled);
  ['A', 'B'].forEach((x) => a.addNote(x));
  a.action('save-file');
  assert.equal(a.downloads.length, 1);
  assert.equal(a.downloads[0].name, 'Plan Q1.json');
  const o = JSON.parse(a.downloads[0].text);
  assert.equal(o.typ, 'board');
  assert.equal(o.lappar.length, 2);
  assert.equal(/Johnny/.test(a.downloads[0].text), false);
  assert.match(a.root.textContent, /Filen är sparad/);
});

test('spara resultat som fil efter avslut', () => {
  const a = setup();
  finishedFlow(a);
  a.action('save-file');
  assert.equal(JSON.parse(a.downloads[0].text).typ, 'resultat');
});

test('läs in boardfil: lapparna används när användaren startar (KR-31)', async () => {
  const a = setup();
  await pickFile(a, { text: serializeFile(boardFile(4)) });
  assert.match(a.$('.notice').textContent, /"Från fil" är inläst med 4 lappar/);
  assert.equal(a.$('[name="boardName"]').value, 'Från fil');
  a.fill(a.$('[data-form="start"]'), { boardName: 'Från fil', alias: 'Johnny' });
  a.submit(a.$('[data-form="start"]'));
  assert.deepEqual(a.titles(), ['Fil 1', 'Fil 2', 'Fil 3', 'Fil 4']);
  a.addNote('Fil 5');
  assert.equal(a.$$('.note').length, 5, 'lapparna kan redigeras och utökas');
});

test('läs in resultatfil: skrivskyddad vy som kan starta om värderingen (KR-31)', async () => {
  const ctx = setup();
  finishedFlow(ctx);
  ctx.action('start-manual');
  const text = serializeFile(ctx.app.state.session);
  const b = setup();
  await pickFile(b, { text });
  assert.match(b.root.textContent, /Resultat från fil \(skrivskyddat\)/);
  assert.equal(b.$('[data-action="move"]'), null, 'ingen flytt i skrivskyddad vy');
  assert.equal(b.$('[data-action="copy"]'), null);
  assert.ok(b.$$('.rank-row').length >= 3);
  b.action('restart-from-file');
  assert.match(b.$('.notice').textContent, /3 lappar/);
  b.begin('Om', 'Johnny');
  assert.equal(b.$$('.note').length, 3);
  assert.ok(!b.$('[data-action="start"]').disabled);
});

test('felaktiga filer ger begripliga fel och ändrar ingenting (NFR-9)', async () => {
  const cases = [
    [{ text: '{ trasig' }, /går inte att läsa/],
    [{ text: JSON.stringify({ app: 'bubble', v: 9, typ: 'board', namn: 'x', lappar: [] }) }, /version som den här appen inte stöder/],
    [{ text: '{}', size: MAX_FILE_BYTES + 1 }, /för stor/],
    [{ text: JSON.stringify({ app: 'bubble', v: 1, typ: 'board', namn: 'x', lappar: [{ id: 1, t: 'x'.repeat(101) }, { id: 2, t: 'b' }] }) }, /Titeln är för lång/],
  ];
  for (const [file, re] of cases) {
    const a = setup();
    await pickFile(a, file);
    assert.match(a.$('.error').textContent, re);
    assert.ok(a.$('[data-form="start"]'));
    assert.equal(a.$('.notice'), null);
  }
});

test('innehåll från fil visas som text, aldrig som kod', async () => {
  const text = JSON.stringify({
    app: 'bubble', v: 1, typ: 'board', namn: '<img src=x onerror=alert(1)>',
    lappar: [{ id: 1, t: '<script>alert(1)</script>' }, { id: 2, t: 'B' }],
  });
  const a = setup();
  await pickFile(a, { text });
  assert.equal(a.root.querySelectorAll('img, script').length, 0);
  a.fill(a.$('[data-form="start"]'), { boardName: '<b>x</b>', alias: 'J' });
  a.submit(a.$('[data-form="start"]'));
  assert.equal(a.root.querySelectorAll('script, b').length, 0);
  assert.match(a.$('.note-title').textContent, /<script>/);
});

test('alla gränssnittstexter finns i språkfilen (NFR-11)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 40);
  for (const k of keys) assert.ok(k in sv, `saknad text: ${k}`);
  for (const k of ['tsv.place', 'tsv.title', 'tsv.description', 'tsv.category', 'tsv.points', 'tsv.wins', 'tsv.losses', 'tsv.equals']) {
    assert.ok(k in sv);
  }
  for (const c of ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']) assert.ok(`color.${c}` in sv);
  for (const code of ['FILE_TOO_LARGE', 'FILE_INVALID', 'FILE_VERSION', 'MAX_NOTES', 'MIN_NOTES']) {
    assert.ok(`error.${code}` in sv, code);
  }
});

test('versionsnumret visas längst ner och följer package.json och taggen', async () => {
  const fs = await import('node:fs');
  const { VERSION } = await import('../src/version.js');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  const { dom } = setup();
  const el = dom.window.document.querySelector('.app-version');
  assert.equal(el.textContent, `Version ${VERSION}`);
});
