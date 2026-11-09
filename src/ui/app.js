// Gränssnitt för individuell prioritering (prototyp enligt OQ-46).
// Presentationen använder Session och motorn men innehåller ingen sorteringslogik (NFR-10).
// Allt hålls i minnet, inget sparas mellan besök (OQ-26, OQ-47).

import { Session, SessionError, LIMITS, COLORS, MODE } from '../session/session.js';
import { sv, t as translate, errorText } from '../i18n/sv.js';
import { placeLabel, resultText } from './format.js';

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

export function mount(root, {
  dict = sv,
  clipboard = globalThis.navigator?.clipboard,
  seed,                      // fast seed för reproducerbar ordning i testbygge (TF-8, OQ-21)
  minAnswerInterval = 350,   // ms, skyddar mot dubbelklick och tangentspam (NFR-9)
  now = () => Date.now(),
} = {}) {
  const t = (key, params) => translate(key, params, dict);
  const doc = root.ownerDocument;

  const state = {
    session: null,
    view: 'free',        // 'free' (fritt läge) | 'sort' (sorteringsläge), OQ-35
    editingId: null,
    draft: { title: '', description: '', category: '', color: '' },
    startDraft: { boardName: '', alias: '' },
    error: '',
    notice: '',
    confirm: null,       // { message, onYes }
    copyFallback: '',
    lastAnswerAt: -Infinity,
  };

  const owner = () => state.session.ownerId;

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

  // ---------- Vyer ----------

  function renderStart() {
    return `
      <main class="start">
        <h1>${esc(t('app.title'))}</h1>
        <p>${esc(t('app.tagline'))}</p>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
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
      </main>`;
  }

  function header(s) {
    const showToggle = s.mode === MODE.RUNNING || s.mode === MODE.PAUSED;
    return `
      <header class="top">
        <div>
          <h1>${esc(s.boardName)}</h1>
          <p class="mode">${esc(t('mode.label'))}: <strong>${esc(t(`mode.${s.mode}`))}</strong></p>
        </div>
        ${showToggle ? `
        <nav class="toggle" aria-label="${esc(t('mode.label'))}">
          <button data-action="view" data-view="free" aria-pressed="${state.view === 'free'}">${esc(t('view.free'))}</button>
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

  function renderFree() {
    const s = state.session;
    const canEditList = s.mode !== MODE.FINISHED;
    const items = s.notes.map((n) => {
      const body = state.editingId === n.id ? noteForm(s) : noteBody(n);
      const actions = canEditList && state.editingId !== n.id ? `
        <div class="row small">
          <button data-action="edit" data-id="${n.id}">${esc(t('note.edit'))}</button>
          ${s.mode === MODE.PREPARED ? `<button data-action="duplicate" data-id="${n.id}">${esc(t('note.duplicate'))}</button>` : ''}
          <button data-action="remove" data-id="${n.id}">${esc(t('note.remove'))}</button>
        </div>` : '';
      return `<li class="note${n.color ? ` note-${esc(n.color)}` : ''}">${body}${actions}</li>`;
    }).join('');
    return `
      ${state.editingId == null ? noteForm(s) : ''}
      <p class="count">${esc(t('note.count', { count: s.notes.length, max: LIMITS.MAX_NOTES }))}</p>
      ${s.notes.length ? `<ul class="notes">${items}</ul>` : `<p class="hint">${esc(t('note.empty'))}</p>`}
      ${s.mode === MODE.PREPARED ? `
        <div class="row">
          <button data-action="start" class="primary"${s.notes.length < LIMITS.MIN_NOTES ? ' disabled' : ''}>${esc(t('sort.start'))}</button>
        </div>
        ${s.notes.length < LIMITS.MIN_NOTES ? `<p class="hint">${esc(t('sort.needTwo'))}</p>` : ''}` : ''}`;
  }

  function renderSort() {
    const s = state.session;
    const { decided, total } = s.progress();
    const pair = s.currentPair();
    const controls = `
      <div class="row small">
        <button data-action="undo"${decided === 0 ? ' disabled' : ''}>${esc(t('sort.undo'))}</button>
        ${s.mode === MODE.PAUSED
          ? `<button data-action="resume">${esc(t('sort.resume'))}</button>`
          : `<button data-action="pause">${esc(t('sort.pause'))}</button>`}
        <button data-action="finish-early">${esc(t('sort.finishEarly'))}</button>
      </div>`;
    const progress = `
      <div class="progress">
        <progress max="${total}" value="${decided}" aria-label="${esc(t('sort.done', { decided, total }))}"></progress>
        <span>${esc(t('sort.done', { decided, total }))}</span>
      </div>`;
    if (s.mode === MODE.PAUSED) {
      return `${progress}<p class="paused" role="status">${esc(t('sort.pausedInfo'))}</p>${controls}`;
    }
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

  function renderResult() {
    const s = state.session;
    const auto = new Map(s.autoRanking().map((r) => [r.id, r]));
    const order = s.displayedOrder();
    const manual = s.manualOrder != null;
    const prelim = s.preliminary();
    const cycles = s.cycles();
    const rows = order.map((id, i) => {
      const r = auto.get(id);
      const n = s.notes.find((x) => x.id === id);
      const place = manual ? String(i + 1) : placeLabel(r, t);
      return `
        <li class="rank-row${n.color ? ` note-${esc(n.color)}` : ''}">
          <span class="place" aria-label="${esc(t('result.place'))}">${esc(place)}</span>
          <div class="rank-body">${noteBody(n)}</div>
          <span class="pts">${r.points} ${esc(t('result.points'))}</span>
          <span class="move">
            <button data-action="move" data-dir="up" data-id="${id}" aria-label="${esc(t('result.up'))}: ${esc(n.title)}"${i === 0 ? ' disabled' : ''}>▲</button>
            <button data-action="move" data-dir="down" data-id="${id}" aria-label="${esc(t('result.down'))}: ${esc(n.title)}"${i === order.length - 1 ? ' disabled' : ''}>▼</button>
          </span>
        </li>`;
    }).join('');
    const stats = s.stats().map((r) => `
      <tr><th scope="row">${esc(noteTitle(r.id))}</th><td>${r.wins}</td><td>${r.losses}</td><td>${r.equals}</td></tr>`).join('');
    const list = s.comparisonList().map((h) => `
      <li>${esc(noteTitle(h.left))} – ${esc(noteTitle(h.right))}: ${esc(t('result.votes', h.counts))}</li>`).join('');
    return `
      <h2>${esc(t('result.title'))}${manual ? ` – ${esc(t('result.manualOrder'))}` : ` – ${esc(t('result.autoOrder'))}`}</h2>
      ${prelim ? `<p class="prelim" role="status"><strong>${esc(t('result.preliminary', prelim))}</strong></p>` : ''}
      ${cycles.map((g) => `<p class="warning" role="alert">${esc(t('result.cycleWarning', { notes: g.map(noteTitle).join(', ') }))}</p>`).join('')}
      ${manual ? `<p class="hint">${esc(t('result.manualActive'))}</p>` : ''}
      <ol class="ranking">${rows}</ol>
      <div class="row">
        ${manual ? `<button data-action="reset-order">${esc(t('result.reset'))}</button>` : ''}
        <button data-action="copy" class="primary">${esc(t('result.copy'))}</button>
        <button data-action="new-session">${esc(t('result.newSession'))}</button>
      </div>
      ${state.notice ? `<p role="status">${esc(state.notice)}</p>` : ''}
      ${state.copyFallback ? `<textarea readonly rows="6" class="copybox">${esc(state.copyFallback)}</textarea>` : ''}
      <h3>${esc(t('result.statistics'))}</h3>
      <table class="stats"><thead><tr><th scope="col"></th><th scope="col">${esc(t('result.wins'))}</th><th scope="col">${esc(t('result.losses'))}</th><th scope="col">${esc(t('result.equals'))}</th></tr></thead><tbody>${stats}</tbody></table>
      <h3>${esc(t('result.comparisons'))}</h3>
      <ul class="comparisons">${list}</ul>`;
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
      root.innerHTML = renderStart();
      return;
    }
    let content;
    if (s.mode === MODE.FINISHED) content = renderResult();
    else if (state.view === 'sort' && s.mode !== MODE.PREPARED) content = renderSort();
    else content = renderFree();
    root.innerHTML = `
      ${header(s)}
      <main>
        ${state.error ? `<p class="error" role="alert">${esc(state.error)}</p>` : ''}
        ${content}
        ${state.notice && s.mode === MODE.RUNNING ? `<p class="notice" role="status">${esc(state.notice)}</p>` : ''}
      </main>
      ${renderConfirm()}`;
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
      const started = s.mode !== MODE.PREPARED;
      state.confirm = {
        message: started && affected > 0
          ? t('confirm.remove', { count: affected })
          : t('confirm.removeSimple', { title: noteTitle(id) }),
        onYes: () => s.removeNote(owner(), id),
      };
    },
    start: () => { state.session.start(owner()); state.view = 'sort'; },
    answer: (el) => answer(el.dataset.choice),
    undo: () => state.session.undo(),
    pause: () => state.session.pause(owner()),
    resume: () => state.session.resume(owner()),
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
    move: (el) => state.session.moveNote(owner(), el.dataset.id, el.dataset.dir),
    'reset-order': () => state.session.resetManualOrder(owner()),
    'new-session': () => {
      state.session = null; state.view = 'free'; state.editingId = null;
      state.draft = emptyDraft(); state.copyFallback = '';
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

  function emptyDraft() {
    return { title: '', description: '', category: '', color: '' };
  }

  async function copyResult() {
    const text = resultText(state.session, t);
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
        state.session = new Session({
          boardName: data.boardName, ownerName: data.alias, individual: true, seed,
        });
        state.view = 'free';
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

  render();
  return { state, render };
}
