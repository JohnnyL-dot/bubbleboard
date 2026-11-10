// Gränssnitt för individuell prioritering.
// Presentationen använder Session och motorn men innehåller ingen sorteringslogik (NFR-10).
// Arbetet sparas i webbläsarens lokala lagring så att det överlever omladdning (KR-21).
// Alla texter sätts som text, aldrig som kod (esc), även innehåll från filer (KR-31).

import {
  Session, SessionError, LIMITS, COLORS, MODE,
} from '../session/session.js';
import { createStore } from '../session/storage.js';
import { MAX_FILE_BYTES, fileName, parseFile, serializeFile } from '../session/file.js';
import { VERSION } from '../version.js';
import { sv, t as translate, errorText } from '../i18n/sv.js';
import { placeLabel, resultTsv } from './format.js';
import { scrollDelta, targetIndex } from './reorder.js';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

function defaultDownload(doc, name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mount(root, {
  dict = sv,
  clipboard = globalThis.navigator?.clipboard,
  seed,                      // fast seed för reproducerbar ordning i testbygge (TF-8, OQ-21)
  minAnswerInterval = 350,   // ms, skyddar mot dubbelklick och tangentspam (NFR-9)
  now = () => Date.now(),
  store = createStore(() => globalThis.localStorage),
  download,
  readFile = (file) => file.text(),
} = {}) {
  const t = (key, params) => translate(key, params, dict);
  const doc = root.ownerDocument;
  const win = doc.defaultView;

  const state = {
    session: null,
    view: 'overview',    // 'overview' (Översikt) | 'sort' (sorteringsläge), OQ-35, OQ-55
    editingId: null,
    draft: { title: '', description: '', category: '', color: '' },
    startDraft: { boardName: '', alias: '' },
    error: '',
    notice: '',
    confirm: null,       // { message, onYes }
    copyFallback: '',
    lastAnswerAt: -Infinity,
    storageOk: true,     // false: lagringen går inte att använda (KR-21)
    storageNote: '',     // t.ex. trasigt sparat arbete
    pendingFile: null,   // inläst board-fil som väntar på namn och start
    fileView: null,      // inläst resultatfil, visas skrivskyddat
    focus: null,         // { id, dir } återställer fokus efter flytt (tangentbord)
  };

  const live = doc.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('role', 'status');
  if (root.parentNode) root.insertAdjacentElement('afterend', live);

  // Versionsnummer längst ner till höger, utanför det som ritas om.
  const versionEl = doc.createElement('footer');
  versionEl.className = 'app-version';
  versionEl.textContent = t('app.version', { version: VERSION });
  if (root.parentNode) root.insertAdjacentElement('afterend', versionEl);

  const owner = () => state.session.ownerId;
  const emptyDraft = () => ({ title: '', description: '', category: '', color: '' });

  // ---------- Lagring (KR-21) ----------

  state.storageOk = store.available();

  function persist() {
    if (!state.session) { store.clear(); return; }
    if (!store.save(state.session.snapshot())) state.storageOk = false;
  }

  let saved = null;
  try {
    saved = store.load();
    if (saved) {
      state.session = Session.restore(saved);
      state.view = state.session.mode === MODE.RUNNING ? 'sort' : 'overview';
    }
  } catch {
    // Sparat arbete från version 1.0.x kan ha 26–30 lappar (högst 25 sedan OQ-71). Säg det rakt ut.
    const tooMany = Array.isArray(saved?.notes) && saved.notes.length > LIMITS.MAX_NOTES;
    store.clear();
    state.storageNote = t(tooMany ? 'storage.tooMany' : 'storage.corrupt');
  }

  // ---------- Hjälpare ----------

  function run(fn) {
    state.error = '';
    state.notice = '';
    try {
      fn();
    } catch (err) {
      if (err instanceof SessionError) state.error = errorText(err, dict);
      else throw err;
    }
    persist();
    render();
  }

  const noteTitle = (id) => state.session.notes.find((n) => n.id === id)?.title ?? '';

  function colorBadge(color) {
    if (!color) return '';
    // Färg är aldrig enda indikator: namnet står som text bredvid (NFR-1).
    return `<span class="swatch swatch-${esc(color)}" aria-hidden="true"></span><span class="color-name">${esc(t(`color.${color}`))}</span>`;
  }

  function noteBody(note) {
    return `
      <h3 class="note-title">${esc(note.title)}</h3>
      ${note.description ? `<p class="note-desc">${esc(note.description)}</p>` : ''}
      <p class="note-meta">${note.category ? `<span class="category">${esc(note.category)}</span>` : ''}${colorBadge(note.color)}</p>`;
  }

  function banners() {
    return `
      ${!state.storageOk ? `<p class="warning" role="alert">${esc(t(state.session ? 'storage.failed' : 'storage.unavailable'))}</p>` : ''}
      ${state.storageNote ? `<p class="warning" role="alert">${esc(state.storageNote)}</p>` : ''}`;
  }

  // ---------- Vyer ----------

  function renderStart() {
    const pending = state.pendingFile;
    return `
      <main class="start">
        <h1>${esc(t('app.title'))}</h1>
        <p>${esc(t('app.tagline'))}</p>
        ${banners()}
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
        ${pending ? `<p class="notice" role="status">${esc(t('file.loaded', { board: pending.boardName, count: pending.notes.length }))}</p>` : ''}
        <form data-form="start">
          <label>${esc(t('start.boardName'))}
            <input name="boardName" value="${esc(state.startDraft.boardName)}" autocomplete="off"></label>
          <label>${esc(t('start.alias'))}
            <input name="alias" value="${esc(state.startDraft.alias)}" autocomplete="nickname"></label>
          <div class="row">
            <button type="submit" class="primary">${esc(t('start.individual'))}</button>
            <button type="button" disabled aria-describedby="group-info">${esc(t('start.group'))}</button>
          </div>
          <p id="group-info" class="hint">${esc(t('start.groupSoon'))}</p>
        </form>
        <p class="file-load">
          <label>${esc(t('file.load'))}
            <input type="file" accept=".json,application/json" data-file></label>
        </p>
        <p class="hint">${esc(t('file.loadHint'))}</p>
      </main>`;
  }

  function header(s) {
    const showToggle = s.mode === MODE.RUNNING;
    return `
      <header class="top">
        <div>
          <h1>${esc(s.boardName)}</h1>
          <p class="mode">${esc(t('mode.label'))}: <strong>${esc(t(`mode.${s.mode}`))}</strong></p>
        </div>
        ${showToggle ? `
        <nav class="toggle" aria-label="${esc(t('mode.label'))}">
          <button data-action="view" data-view="overview" aria-pressed="${state.view === 'overview'}">${esc(t('view.overview'))}</button>
          <button data-action="view" data-view="sort" aria-pressed="${state.view === 'sort'}">${esc(t('view.sort'))}</button>
        </nav>` : ''}
      </header>`;
  }

  function noteForm(s) {
    const editing = state.editingId != null;
    if (!editing && s.mode !== MODE.PREPARED) return `<p class="hint">${esc(t('note.addLocked'))}</p>`;
    const d = state.draft;
    return `
      <form data-form="note" class="note-form">
        <label>${esc(t('note.title'))}
          <input name="title" value="${esc(d.title)}" autocomplete="off"></label>
        <label>${esc(t('note.description'))}
          <textarea name="description" rows="2">${esc(d.description)}</textarea></label>
        <label>${esc(t('note.category'))}
          <input name="category" value="${esc(d.category)}" autocomplete="off"></label>
        <label>${esc(t('note.color'))}
          <select name="color">
            <option value="">${esc(t('note.noColor'))}</option>
            ${COLORS.map((c) => `<option value="${c}"${d.color === c ? ' selected' : ''}>${esc(t(`color.${c}`))}</option>`).join('')}
          </select></label>
        <div class="row">
          <button type="submit" class="primary">${esc(editing ? t('note.save') : t('note.add'))}</button>
          ${editing ? `<button type="button" data-action="cancel-edit">${esc(t('confirm.no'))}</button>` : ''}
        </div>
      </form>`;
  }

  /** Dragpunkt och upp/ned-knappar för en rad (KR-5, WCAG 2.5.7: alternativ till drag). */
  function moveControls(id, index, count, title) {
    return `
      <span class="move">
        <button type="button" class="handle" data-drag aria-label="${esc(t('move.drag'))}: ${esc(title)}" title="${esc(t('move.drag'))}">⠿</button>
        <button data-action="move" data-dir="up" data-id="${esc(id)}" aria-label="${esc(t('move.up'))}: ${esc(title)}"${index === 0 ? ' disabled' : ''}>▲</button>
        <button data-action="move" data-dir="down" data-id="${esc(id)}" aria-label="${esc(t('move.down'))}: ${esc(title)}"${index === count - 1 ? ' disabled' : ''}>▼</button>
      </span>`;
  }

  function renderOverview() {
    const s = state.session;
    const canEditList = s.mode !== MODE.FINISHED;
    const order = s.overviewOrder();
    const items = order.map((id, i) => {
      const n = s.notes.find((x) => x.id === id);
      const editing = state.editingId === n.id;
      const body = editing ? noteForm(s) : noteBody(n);
      const actions = canEditList && !editing ? `
        <div class="row small">
          <button data-action="edit" data-id="${n.id}">${esc(t('note.edit'))}</button>
          ${s.mode === MODE.PREPARED ? `<button data-action="duplicate" data-id="${n.id}"${s.notes.length >= LIMITS.MAX_NOTES ? ' disabled' : ''}>${esc(t('note.duplicate'))}</button>` : ''}
          <button data-action="remove" data-id="${n.id}">${esc(t('note.remove'))}</button>
        </div>` : '';
      return `
        <li class="note${n.color ? ` note-${esc(n.color)}` : ''}" data-id="${n.id}">
          <div class="note-head"><span class="num">${i + 1}</span><div class="note-main">${body}</div></div>
          ${editing ? '' : moveControls(n.id, i, order.length, n.title)}
          ${actions}
        </li>`;
    }).join('');
    return `
      ${state.editingId == null ? noteForm(s) : ''}
      <p class="count">${esc(t('note.count', { count: s.notes.length, max: LIMITS.MAX_NOTES }))}</p>
      ${s.notes.length > 1 ? `<p class="hint">${esc(t('overview.hint'))}</p>` : ''}
      ${s.manualOrder ? `<p class="hint">${esc(t('overview.manualInfo'))} <button data-action="reset-order">${esc(t('overview.reset'))}</button></p>` : ''}
      ${s.notes.length ? `<ol class="notes sortable" data-sortable>${items}</ol>` : `<p class="hint">${esc(t('note.empty'))}</p>`}
      <div class="row">
        ${s.mode === MODE.PREPARED ? `<button data-action="start" class="primary"${s.notes.length < LIMITS.MIN_NOTES ? ' disabled' : ''}>${esc(t('sort.start'))}</button>` : ''}
        <button data-action="save-file"${s.notes.length < LIMITS.MIN_NOTES ? ' disabled' : ''}>${esc(t('file.saveBoard'))}</button>
      </div>
      ${s.mode === MODE.PREPARED && s.notes.length < LIMITS.MIN_NOTES ? `<p class="hint">${esc(t('sort.needTwo'))}</p>` : ''}
      ${state.notice ? `<p role="status">${esc(state.notice)}</p>` : ''}`;
  }

  function renderSort() {
    const s = state.session;
    const { decided, total } = s.progress();
    const pair = s.currentPair();
    const controls = `
      <div class="row small">
        <button data-action="undo"${decided === 0 ? ' disabled' : ''}>${esc(t('sort.undo'))}</button>
        <button data-action="finish-early">${esc(t('sort.finishEarly'))}</button>
      </div>`;
    const progress = `
      <div class="progress">
        <progress max="${total}" value="${decided}" aria-label="${esc(t('sort.done', { decided, total }))}"></progress>
        <span>${esc(t('sort.done', { decided, total }))}</span>
      </div>`;
    if (!pair) {
      return `${progress}<p role="status">${esc(t('sort.allDone'))}</p>
        <div class="row"><button data-action="show-result" class="primary">${esc(t('sort.showResult'))}</button></div>${controls}`;
    }
    const card = (id, side, label) => {
      const n = s.notes.find((x) => x.id === id);
      return `
        <button class="choice choice-${side}${n.color ? ` note-${esc(n.color)}` : ''}" data-action="answer" data-choice="${side}" aria-label="${esc(label)}: ${esc(n.title)}">
          ${noteBody(n)}
        </button>`;
    };
    return `
      ${progress}
      <h2 class="question">${esc(t('sort.question'))}</h2>
      <p class="hint">${esc(t('sort.progress', { current: decided + 1, total }))}</p>
      <div class="pair">
        ${card(pair.left, 'left', t('sort.left'))}
        ${card(pair.right, 'right', t('sort.right'))}
      </div>
      <div class="row"><button class="equal" data-action="answer" data-choice="equal">${esc(t('sort.equal'))}</button></div>
      ${controls}
      <p class="hint">${esc(t('sort.keys'))}</p>`;
  }

  /** Underlag för resultatvyn, från en session eller en inläst fil. */
  function sessionModel(s) {
    return {
      boardName: s.boardName,
      notes: s.notes,
      rows: s.autoRanking(),
      manual: s.manualOrder ? [...s.manualOrder] : null,
      preliminary: s.preliminary(),
      preliminaryKnown: s.preliminary() !== null,
      cycles: s.cycles(),
    };
  }

  function fileModel(f) {
    const id = (n) => `n${n}`;
    return {
      boardName: f.boardName,
      notes: f.notes.map((n) => ({ ...n, id: id(n.id) })),
      rows: f.resultat.rang.map((r) => ({
        id: id(r.id), place: r.plats, shared: r.delad, points: r.p, wins: r.v, losses: r.f, equals: r.l,
      })),
      manual: f.resultat.manuell ? f.resultat.manuell.map(id) : null,
      preliminary: null,
      preliminaryKnown: f.resultat.preliminar,
      cycles: [],
    };
  }

  function renderResultBody(model, editable) {
    const note = new Map(model.notes.map((n) => [n.id, n]));
    const title = (id) => note.get(id)?.title ?? '';
    const rowOf = new Map(model.rows.map((r) => [r.id, r]));

    const autoRows = model.rows.map((r) => {
      const n = note.get(r.id);
      return `
        <li class="rank-row${n.color ? ` note-${esc(n.color)}` : ''}">
          <span class="place" aria-label="${esc(t('result.place'))}">${esc(placeLabel(r, t))}</span>
          <div class="rank-body">${noteBody(n)}</div>
          <span class="pts">${r.points} ${esc(t('result.points'))}</span>
        </li>`;
    }).join('');

    const manualRows = model.manual ? model.manual.map((id, i) => {
      const n = note.get(id);
      const r = rowOf.get(id);
      return `
        <li class="rank-row manual${n.color ? ` note-${esc(n.color)}` : ''}" data-id="${esc(id)}">
          <span class="place" aria-label="${esc(t('result.place'))}">${i + 1}</span>
          <div class="rank-body">${noteBody(n)}</div>
          <span class="pts">${r.points} ${esc(t('result.points'))}</span>
          ${editable ? moveControls(id, i, model.manual.length, n.title) : ''}
        </li>`;
    }).join('') : '';

    const stats = model.rows.map((r) => `
      <tr><th scope="row">${esc(title(r.id))}</th><td>${r.wins}</td><td>${r.losses}</td><td>${r.equals}</td></tr>`).join('');

    return `
      ${model.preliminary
        ? `<p class="prelim" role="status"><strong>${esc(t('result.preliminary', model.preliminary))}</strong></p>`
        : (model.preliminaryKnown ? `<p class="prelim" role="status"><strong>${esc(t('result.preliminaryShort'))}</strong></p>` : '')}
      ${model.cycles.map((g) => `<p class="warning" role="alert">${esc(t('result.cycleWarning', { notes: g.map(title).join(', ') }))}</p>`).join('')}
      <h3>${esc(t('result.autoOrder'))}</h3>
      <ol class="ranking">${autoRows}</ol>
      ${model.manual ? `
        <h3>${esc(t('result.manualOrder'))}</h3>
        <p class="hint">${esc(t('result.manualActive'))}</p>
        <ol class="ranking sortable" data-sortable>${manualRows}</ol>` : ''}
      ${editable ? `<div class="row">
        ${model.manual
          ? `<button data-action="reset-order">${esc(t('result.reset'))}</button>`
          : `<button data-action="start-manual">${esc(t('result.startManual'))}</button>`}
      </div>` : ''}
      <h3>${esc(t('result.statistics'))}</h3>
      <table class="stats"><thead><tr><th scope="col"></th><th scope="col">${esc(t('result.wins'))}</th><th scope="col">${esc(t('result.losses'))}</th><th scope="col">${esc(t('result.equals'))}</th></tr></thead><tbody>${stats}</tbody></table>`;
  }

  function renderResult() {
    const s = state.session;
    return `
      <h2>${esc(t('result.title'))}</h2>
      ${renderResultBody(sessionModel(s), true)}
      <div class="row">
        <button data-action="copy" class="primary">${esc(t('result.copy'))}</button>
        <button data-action="save-file">${esc(t('file.saveResult'))}</button>
        <button data-action="new-session">${esc(t('result.newSession'))}</button>
      </div>
      ${state.notice ? `<p role="status">${esc(state.notice)}</p>` : ''}
      ${state.copyFallback ? `<textarea readonly rows="6" class="copybox">${esc(state.copyFallback)}</textarea>` : ''}`;
  }

  function renderFileView() {
    const f = state.fileView;
    return `
      <header class="top"><div><h1>${esc(f.boardName)}</h1><p class="mode">${esc(t('file.readonlyTitle'))}</p></div></header>
      <main>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
        <h2>${esc(t('result.title'))}</h2>
        ${renderResultBody(fileModel(f), false)}
        <div class="row">
          <button data-action="restart-from-file" class="primary">${esc(t('file.restart'))}</button>
          <button data-action="close-file">${esc(t('file.close'))}</button>
        </div>
      </main>`;
  }

  function renderConfirm() {
    if (!state.confirm) return '';
    return `
      <div class="overlay" role="alertdialog" aria-modal="true" aria-labelledby="confirm-msg">
        <div class="dialog">
          <p id="confirm-msg">${esc(state.confirm.message)}</p>
          <div class="row">
            <button class="primary" data-action="confirm-yes">${esc(t('confirm.yes'))}</button>
            <button data-action="confirm-no">${esc(t('confirm.no'))}</button>
          </div>
        </div>
      </div>`;
  }

  function render() {
    const s = state.session;
    if (!s) {
      root.innerHTML = state.fileView ? renderFileView() : renderStart();
      return;
    }
    let content;
    if (s.mode === MODE.FINISHED) content = renderResult();
    else if (state.view === 'sort' && s.mode === MODE.RUNNING) content = renderSort();
    else content = renderOverview();
    root.innerHTML = `
      ${header(s)}
      <main>
        ${banners()}
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
        ${content}
        ${state.notice && s.mode === MODE.RUNNING && state.view === 'sort' ? `<p class="notice" role="status">${esc(state.notice)}</p>` : ''}
      </main>
      ${renderConfirm()}`;
    restoreFocus();
  }

  /** Efter en flytt byggs listan om. Fokus läggs tillbaka så att tangentbordsanvändaren inte tappar sin plats. */
  function restoreFocus() {
    const f = state.focus;
    state.focus = null;
    if (!f) return;
    const find = (dir) => root.querySelector(`[data-action="move"][data-dir="${dir}"][data-id="${CSS.escape ? CSS.escape(f.id) : f.id}"]`);
    const other = f.dir === 'up' ? 'down' : 'up';
    const el = [find(f.dir), find(other)].find((e) => e && !e.disabled)
      ?? root.querySelector(`li[data-id="${f.id}"] [data-drag]`);
    el?.focus?.();
  }

  function announce(text) {
    live.textContent = '';
    live.textContent = text;
  }

  // ---------- Händelser ----------

  const actions = {
    view: (el) => { state.view = el.dataset.view; state.editingId = null; },
    edit: (el) => {
      const n = state.session.notes.find((x) => x.id === el.dataset.id);
      state.editingId = n.id;
      state.draft = { title: n.title, description: n.description, category: n.category, color: n.color ?? '' };
    },
    'cancel-edit': () => { state.editingId = null; state.draft = emptyDraft(); },
    duplicate: (el) => state.session.duplicateNote(owner(), el.dataset.id),
    remove: (el) => {
      const s = state.session;
      const id = el.dataset.id;
      const affected = s.comparisonsAffectedByRemoving(id);
      state.confirm = {
        message: s.mode !== MODE.PREPARED && affected > 0
          ? t('confirm.remove', { count: affected })
          : t('confirm.removeSimple', { title: noteTitle(id) }),
        onYes: () => s.removeNote(owner(), id),
      };
    },
    start: () => { state.session.start(owner()); state.view = 'sort'; },
    answer: (el) => answer(el.dataset.choice),
    undo: () => state.session.undo(),
    'finish-early': () => {
      const s = state.session;
      const { decided, total } = s.progress();
      state.confirm = {
        message: decided < total ? t('confirm.finishEarly', { decided, total }) : t('confirm.finish'),
        onYes: () => s.finish(owner()),
      };
    },
    'show-result': () => {
      const s = state.session;
      state.confirm = { message: t('confirm.finish'), onYes: () => s.finish(owner()) };
    },
    move: (el) => {
      const s = state.session;
      const id = el.dataset.id;
      const dir = el.dataset.dir;
      const index = s.moveNote(owner(), id, dir);
      state.focus = { id, dir };
      announce(t('move.moved', { title: noteTitle(id), place: index + 1, total: s.notes.length }));
    },
    'start-manual': () => state.session.startManualFromAuto(owner()),
    'reset-order': () => state.session.resetManualOrder(owner()),
    'save-file': () => {
      const s = state.session;
      (download ?? ((name, text) => defaultDownload(doc, name, text)))(fileName(s.boardName), serializeFile(s));
      state.notice = t('file.saved');
    },
    'restart-from-file': () => {
      const f = state.fileView;
      state.pendingFile = { boardName: f.boardName, notes: f.notes };
      state.startDraft.boardName = f.boardName;
      state.fileView = null;
    },
    'close-file': () => { state.fileView = null; },
    'new-session': () => {
      state.confirm = {
        message: t('confirm.newSession'),
        onYes: () => {
          state.session = null; state.view = 'overview'; state.editingId = null;
          state.draft = emptyDraft(); state.copyFallback = ''; state.pendingFile = null;
          state.startDraft = { boardName: '', alias: '' };
        },
      };
    },
    'confirm-yes': () => {
      const c = state.confirm;
      state.confirm = null;
      c.onYes();
    },
    'confirm-no': () => { state.confirm = null; },
  };

  /** Registrerar ett svar, men ignorerar upprepade tryck inom intervallet (NFR-9). */
  function answer(choice) {
    const at = now();
    if (at - state.lastAnswerAt < minAnswerInterval) return;
    state.lastAnswerAt = at;
    state.session.answer(choice);
    state.notice = t('sort.registered');
  }

  async function copyResult() {
    const s = state.session;
    const text = resultTsv(sessionModel(s), t);
    try {
      if (!clipboard) throw new Error('no clipboard');
      await clipboard.writeText(text);
      state.notice = t('result.copied');
      state.copyFallback = '';
    } catch {
      state.notice = t('result.copyFailed');
      state.copyFallback = text;
    }
    render();
  }

  root.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const action = el.dataset.action;
    if (action === 'copy') { copyResult(); return; }
    run(() => actions[action](el));
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'start') {
      state.startDraft = { boardName: data.boardName ?? '', alias: data.alias ?? '' };
      run(() => {
        const session = new Session({ boardName: data.boardName, ownerName: data.alias, seed });
        if (state.pendingFile) {
          for (const n of state.pendingFile.notes) session.addNote(session.ownerId, n);
        }
        state.session = session;
        state.pendingFile = null;
        state.view = 'overview';
      });
    } else if (form.dataset.form === 'note') {
      state.draft = {
        title: data.title ?? '', description: data.description ?? '',
        category: data.category ?? '', color: data.color ?? '',
      };
      run(() => {
        const s = state.session;
        if (state.editingId != null) {
          s.editNote(owner(), state.editingId, state.draft);
          state.editingId = null;
        } else {
          s.addNote(owner(), state.draft);
        }
        state.draft = emptyDraft();
      });
    }
  });

  // Inläsning av fil (KR-31). Storleken kontrolleras innan filen läses.
  root.addEventListener('change', async (event) => {
    const input = event.target;
    if (!input.matches?.('[data-file]')) return;
    const file = input.files?.[0];
    if (!file) return;
    // Namn och alias som skrivits hålls kvar.
    const form = root.querySelector('[data-form="start"]');
    if (form) {
      const d = Object.fromEntries(new FormData(form));
      state.startDraft = { boardName: d.boardName ?? '', alias: d.alias ?? '' };
    }
    state.error = '';
    try {
      if (file.size > MAX_FILE_BYTES) throw new SessionError('FILE_TOO_LARGE');
      const parsed = parseFile(await readFile(file));
      if (parsed.typ === 'resultat') {
        state.fileView = parsed;
      } else {
        state.pendingFile = parsed;
        state.startDraft.boardName = parsed.boardName;
      }
    } catch (err) {
      if (err instanceof SessionError) state.error = errorText(err, dict);
      else state.error = errorText(new SessionError('FILE_INVALID'), dict);
    }
    render();
  });

  // Tangentbordsnavigering i jämförelseflödet (NFR-1).
  doc.addEventListener('keydown', (event) => {
    const s = state.session;
    if (!s || s.mode !== MODE.RUNNING || state.view !== 'sort' || state.confirm) return;
    if (!s.currentPair()) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return;
    const map = { ArrowLeft: 'left', ArrowRight: 'right', '=': 'equal' };
    const choice = map[event.key];
    if (!choice) return;
    event.preventDefault();
    if (event.repeat) return;
    run(() => answer(choice));
  });

  // ---------- Dra och släpp med Pointer Events (KR-5, arkitektens C3) ----------
  // HTML5-drag fungerar inte på pekskärm. Handtaget har touch-action: none så att
  // resten av sidan går att rulla. Upp/ned-knapparna är alternativet utan drag.

  let drag = null;

  function dragFrame() {
    if (!drag) return;
    const dy = drag.y - drag.startY + (win.scrollY - drag.scrollStart);
    drag.li.style.transform = `translateY(${dy}px)`;
    const target = targetIndex(drag.mids, drag.from, drag.y + win.scrollY);
    drag.target = target;
    drag.rows.forEach((r, i) => r.classList.remove('drop-before', 'drop-after'));
    const others = drag.rows.filter((_, i) => i !== drag.from);
    if (target < others.length) others[target].classList.add('drop-before');
    else others[others.length - 1]?.classList.add('drop-after');
  }

  root.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest?.('[data-drag]');
    if (!handle || (event.button != null && event.button > 0) || state.confirm) return;
    const li = handle.closest('li[data-id]');
    const list = li?.parentElement;
    if (!list) return;
    const rows = [...list.children];
    const scrollY = win.scrollY || 0;
    drag = {
      id: li.dataset.id, li, rows, from: rows.indexOf(li), target: rows.indexOf(li),
      startY: event.clientY, y: event.clientY, scrollStart: scrollY, pointerId: event.pointerId,
      mids: rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 + scrollY; }),
      timer: win.setInterval(() => {
        const d = scrollDelta(drag.y, win.innerHeight);
        if (d) { win.scrollBy(0, d); dragFrame(); }
      }, 16),
    };
    handle.setPointerCapture?.(event.pointerId);
    li.classList.add('dragging');
    event.preventDefault();
    dragFrame();
  });

  root.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    dragFrame();
  });

  function endDrag(event, commit) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const d = drag;
    drag = null;
    win.clearInterval(d.timer);
    if (commit && d.target !== d.from) {
      run(() => {
        const index = state.session.moveNoteTo(owner(), d.id, d.target);
        state.focus = { id: d.id, dir: 'up' };
        announce(t('move.moved', { title: noteTitle(d.id), place: index + 1, total: state.session.notes.length }));
      });
    } else {
      render();
    }
  }
  root.addEventListener('pointerup', (event) => endDrag(event, true));
  root.addEventListener('pointercancel', (event) => endDrag(event, false));

  render();
  return { state, render };
}
