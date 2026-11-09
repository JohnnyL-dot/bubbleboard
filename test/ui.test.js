import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mount } from '../src/ui/app.js';
import { resultText } from '../src/ui/format.js';
import { sv, t } from '../src/i18n/sv.js';

function setup() {
  const dom = new JSDOM('<!doctype html><html lang="sv"><body><div id="app"></div></body></html>');
  globalThis.FormData = dom.window.FormData;
  const copied = [];
  const clipboard = { writeText: async (x) => { copied.push(x); } };
  const root = dom.window.document.getElementById('app');
  const app = mount(root, { clipboard });
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
  return { dom, root, app, copied, $, $$, submit, click, action, fill, key, begin, addNote };
}

test('startsidan är på svenska och gruppsession är avstängd med förklaring', () => {
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

test('lappar skapas, kan inte skickas in som HTML (XSS) och 21:a avvisas', () => {
  const { $, $$, root, begin, addNote } = setup();
  begin();
  addNote('<img src=x onerror=alert(1)>', { color: 'blue' });
  assert.equal(root.querySelectorAll('img').length, 0);
  assert.match($('.note-title').textContent, /<img/);
  assert.match($('.note').textContent, /Blå/, 'färgen står även som text');
  for (let i = 2; i <= 20; i++) addNote(`Lapp ${i}`);
  assert.equal($$('.note').length, 20);
  addNote('Lapp 21');
  assert.match($('.error').textContent, /20 lappar/);
  assert.equal($$('.note').length, 20);
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
  action('answer'); // första knappen i DOM = vänster kort
  assert.match($('.progress').textContent, /1 av 3 jämförelser klara/);
});

test('lappar kan inte läggas till efter start men kan redigeras och tas bort med bekräftelse (AT-11)', () => {
  const { $, $$, root, click, action, fill, submit, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  click($('[data-action="view"][data-view="free"]'));
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

test('tangentbord: vänsterpil, högerpil och = registrerar svar (NFR-1)', () => {
  const { $, action, key, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C', 'D'].forEach((x) => addNote(x));
  action('start');
  key('ArrowLeft');
  key('ArrowRight');
  key('=');
  assert.match($('.progress').textContent, /3 av 6/);
});

test('pausa låser jämförelserna och återuppta fortsätter (AT-8)', () => {
  const { $, root, action, key, begin, addNote } = setup();
  begin();
  ['A', 'B'].forEach((x) => addNote(x));
  action('start');
  action('pause');
  assert.match(root.textContent, /Pausad/);
  assert.equal($('.choice'), null);
  key('ArrowLeft');
  assert.match($('.progress').textContent, /0 av 1/);
  action('resume');
  assert.ok($('.choice'));
});

test('ångra senaste går tillbaka ett steg (OQ-22)', () => {
  const { $, action, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  assert.ok($('[data-action="undo"]').disabled);
  action('answer');
  assert.match($('.progress').textContent, /1 av 3/);
  action('undo');
  assert.match($('.progress').textContent, /0 av 3/);
});

test('hela flödet: sortera klart, visa resultat, justera manuellt och kopiera (AT-9)', async () => {
  const { $, $$, root, copied, click, action, begin, addNote } = setup();
  begin('Workshop', 'Johnny');
  ['Alfa', 'Beta', 'Gamma'].forEach((x) => addNote(x));
  action('start');
  for (let i = 0; i < 3; i++) action('answer');
  assert.match(root.textContent, /Alla jämförelser är klara/);
  action('show-result');
  assert.match($('.dialog').textContent, /slutgiltigt/);
  action('confirm-yes');
  assert.match($('.top').textContent, /Avslutad/);
  assert.equal($('.prelim'), null, 'inte preliminärt när alla par är klara');
  assert.equal($$('.rank-row').length, 3);

  const before = $$('.rank-row .note-title').map((e) => e.textContent);
  click($$('[data-action="move"][data-dir="down"]')[0]);
  const after = $$('.rank-row .note-title').map((e) => e.textContent);
  assert.deepEqual(after, [before[1], before[0], before[2]]);
  assert.match(root.textContent, /Manuell ordning/);
  assert.ok($('[data-action="reset-order"]'));
  click($('[data-action="reset-order"]'));
  assert.deepEqual($$('.rank-row .note-title').map((e) => e.textContent), before);

  click($('[data-action="copy"]'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied.length, 1);
  assert.match(copied[0], /^Rangordning för Workshop/);
  assert.match(root.textContent, /Resultatet är kopierat/);
});

test('avslut i förtid kräver bekräftelse och märker resultatet preliminärt (OQ-18)', () => {
  const { $, action, begin, addNote } = setup();
  begin();
  ['A', 'B', 'C', 'D'].forEach((x) => addNote(x));
  action('start');
  action('answer'); action('answer');
  action('finish-early');
  assert.match($('.dialog').textContent, /2 av 6 jämförelser är gjorda/);
  action('confirm-yes');
  assert.match($('.prelim').textContent, /Preliminär, 2 av 6 jämförelser/);
});

test('cykel ger varning med lapparna i resultatvyn (KR-11)', () => {
  const { root, begin, addNote, action, click } = setup();
  begin();
  ['A', 'B', 'C'].forEach((x) => addNote(x));
  action('start');
  const wins = { 'A|B': 'A', 'B|C': 'B', 'A|C': 'C' };
  while (root.querySelector('.choice')) {
    const [l, r] = [...root.querySelectorAll('.choice .note-title')].map((e) => e.textContent);
    const winner = wins[[l, r].sort().join('|')];
    click(root.querySelector(winner === l ? '[data-choice="left"]' : '[data-choice="right"]'));
  }
  action('show-result');
  action('confirm-yes');
  assert.match(root.querySelector('.warning').textContent, /Motsägelse: lapparna A, B, C/);
});

test('ny session återgår till startsidan utan sparad data (OQ-47)', () => {
  const { $, action, begin, addNote } = setup();
  begin();
  ['A', 'B'].forEach((x) => addNote(x));
  action('start');
  action('answer');
  action('show-result');
  action('confirm-yes');
  action('new-session');
  assert.ok($('[data-form="start"]'));
});

test('resultText: delad placering och manuell ordning', () => {
  const { app, begin, addNote, action } = setup();
  begin('Test', 'Johnny');
  ['A', 'B'].forEach((x) => addNote(x));
  action('start');
  const s = app.state.session;
  s.answer('equal');
  s.finish(s.ownerId);
  const text = resultText(s, (k, p) => t(k, p, sv));
  assert.match(text, /1 \(delad\)\. A \(0\.5 poäng\)/);
  assert.match(text, /1 \(delad\)\. B \(0\.5 poäng\)/);
  s.moveNote(s.ownerId, 'n2', 'up');
  const manual = resultText(s, (k, p) => t(k, p, sv));
  assert.match(manual, /1\. B/);
  assert.match(manual, /2\. A/);
});

test('alla gränssnittstexter finns i språkfilen (NFR-11)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]);
  for (const k of keys) assert.ok(k in sv, `saknad text: ${k}`);
  for (const c of ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink']) {
    assert.ok(`color.${c}` in sv);
  }
});
