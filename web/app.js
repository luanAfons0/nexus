/* Nexus Web UI. Vanilla JavaScript, no build step, no network fetch beyond
   the same-origin API under the Run Token. Every action is a CLI subprocess
   on the server; the page shows the exact command and output. */
'use strict';

// --- shell -----------------------------------------------------------------

// Base URL with the Run Token: everything before and including "/t/TOKEN/".
const BASE = location.pathname.replace(/^(\/t\/[0-9a-f]{32}\/).*$/, '$1');
const API = location.origin + BASE + 'api/';

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== null && value !== undefined) node.setAttribute(key, value);
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function replaceChildren(node, children) {
  node.replaceChildren(...children.filter((child) => child !== null && child !== undefined));
}

// --- routes ----------------------------------------------------------------

// Two routes, one section each, on the hash: a path route would force the
// server to serve index.html outside the four-file static allowlist. Both
// sections stay in the DOM and are toggled, so the editor text, the Skills
// filter, the banners, and the unsaved-version panel survive a route change.
// The Last command panel is outside both: it belongs to the run, not a page.
const ROUTES = ['skills', 'global'];
const DEFAULT_ROUTE = 'skills';

const routeState = { current: null, restoring: false };

function routeFromHash() {
  const name = location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}

function routeHash(route) {
  return '#/' + route;
}

// The editor is never destroyed by a route change, but leaving with unsaved
// text hides it behind a page, so ask first with the same dirty check that
// guards beforeunload.
function confirmLeaveEditor() {
  if (!editorDirty()) return true;
  return confirm('Leave Global Instructions with unsaved edits? Your text stays in the editor until you reload the page.');
}

function renderRoute(route) {
  routeState.current = route;
  for (const name of ROUTES) {
    document.getElementById(name).hidden = name !== route;
  }
  for (const button of document.querySelectorAll('#subnav button[data-route]')) {
    const on = button.dataset.route === route;
    button.classList.toggle('on', on);
    if (on) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function goToRoute(route) {
  if (routeState.current === route) return;
  location.hash = routeHash(route);
}

function onHashChange() {
  // The hash we put back after a refusal fires this too; ignore that one.
  if (routeState.restoring) {
    routeState.restoring = false;
    return;
  }
  const next = routeFromHash();
  if (next === routeState.current) return;
  if (routeState.current === 'global' && !confirmLeaveEditor()) {
    routeState.restoring = true;
    location.hash = routeHash('global');
    return;
  }
  renderRoute(next);
}

function initShell() {
  document.getElementById('base-url').textContent = location.origin + BASE;
  const route = routeFromHash();
  // An absent, empty, or unknown hash resolves to Skills, and the URL says
  // so without adding a history entry.
  if (location.hash !== routeHash(route)) {
    history.replaceState(null, '', location.pathname + location.search + routeHash(route));
  }
  renderRoute(route);
  document.getElementById('subnav').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-route]');
    if (button) goToRoute(button.dataset.route);
  });
  window.addEventListener('hashchange', onHashChange);
}

initShell();

// --- api client, banners, toasts, Last command panel ----------------------

// Every call returns the envelope {command, exit, stdout, stderr, json?}
// and shows it in the Last command panel. An HTTP error (403, 404, 409,
// 415) throws an Error with .status and .text; a failed fetch shows the
// connection-lost banner and rethrows.
async function api(name, options) {
  const { method = 'GET', body } = options || {};
  const init = { method, headers: {}, cache: 'no-store' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(API + name, init);
  } catch (error) {
    connectionLost();
    throw error;
  }
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status);
    error.status = response.status;
    error.text = await response.text();
    throw error;
  }
  const envelope = await response.json();
  showLastCommand(envelope);
  return envelope;
}

// One banner per id in the banners strip; a new banner with the same id
// replaces the old one. kind: info, warn, err, ok.
function banner(id, kind, children) {
  const strip = document.getElementById('banners');
  const node = el('div', { class: 'notice ' + kind, 'data-id': id }, [el('div', null, children)]);
  const old = strip.querySelector('[data-id="' + id + '"]');
  if (old) old.replaceWith(node); else strip.append(node);
  return node;
}

function clearBanner(id) {
  const old = document.querySelector('#banners [data-id="' + id + '"]');
  if (old) old.remove();
}

function connectionLost() {
  banner('connection', 'err', [
    el('strong', { text: 'Connection lost.' }), ' Rerun ',
    el('code', { text: 'nexus ui' }), ', then ', el('code', { text: 'nexus list' }), ' to check.',
  ]);
}

function toast(children, milliseconds) {
  const node = el('div', { class: 'toast' }, children);
  document.getElementById('toasts').append(node);
  setTimeout(() => node.remove(), milliseconds || 6000);
  return node;
}

// "nexus update docx" from the argv the server ran; the CLI path is shown
// by its base name, and an argument with white space is quoted.
function commandLabel(argv) {
  return argv.map((argument, index) => {
    if (index === 0) return argument.split('/').pop();
    return /\s/.test(argument) ? "'" + argument.replace(/'/g, "'\\''") + "'" : argument;
  }).join(' ');
}

function showLastCommand(envelope) {
  const body = document.getElementById('last-command-body');
  body.classList.remove('empty');
  const stamp = new Date();
  const lines = [];
  if (envelope.stdout) lines.push(document.createTextNode(envelope.stdout.replace(/\n$/, '') + '\n'));
  if (envelope.stderr) lines.push(el('span', { class: 'err', text: envelope.stderr.replace(/\n$/, '') + '\n' }));
  if (lines.length === 0) lines.push(el('span', { class: 'muted', text: '(no output)' }));
  replaceChildren(body, [
    el('div', { class: 'out-hd' }, [
      el('span', { class: 'mono cmd', text: '$ ' + commandLabel(envelope.command) }),
      el('span', { class: 'exit ' + (envelope.exit === 0 ? 'ok' : 'bad'), text: 'exit ' + envelope.exit }),
      el('span', { text: stamp.toLocaleString() }),
    ]),
    el('pre', { class: 'log mono' }, lines),
  ]);
}

// --- skills table -----------------------------------------------------------

const skillsState = { rows: [], busy: false };

function localDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function skillActions(row) {
  if (row.kind === 'installed') {
    return el('div', { class: 'actions' }, [
      el('button', { class: 'btn sm', type: 'button', 'data-action': 'update', 'data-name': row.name, text: 'Update' }),
      el('button', { class: 'btn sm', type: 'button', 'data-action': 'remove', 'data-name': row.name, text: 'Remove' }),
    ]);
  }
  if (row.kind === 'custom') {
    return el('span', { class: 'hint' }, [
      'Custom Skill: ', el('code', { text: 'git pull' }), ' in ', el('code', { text: '~/.custom-skills' }), ', then link',
    ]);
  }
  return el('span', { class: 'hint', text: 'Control Skill: never updated or removed' });
}

function skillRow(row) {
  const dash = el('span', { class: 'muted', text: '–' });
  return el('tr', { 'data-name': row.name }, [
    el('td', { class: 'mono', text: row.name }),
    el('td', null, [el('span', { class: 'kind ' + row.kind, text: row.kind })]),
    el('td', null, [row.source ? document.createTextNode(row.source) : dash.cloneNode(true)]),
    el('td', { class: 'mono muted', title: row.hash || null }, [row.hash ? document.createTextNode(row.hash.slice(0, 8)) : dash.cloneNode(true)]),
    el('td', { class: 'muted', title: row.updatedAt || null }, [row.updatedAt ? document.createTextNode(localDate(row.updatedAt)) : dash.cloneNode(true)]),
    el('td', { class: 'right' }, [skillActions(row)]),
  ]);
}

function renderSkills(rows) {
  const body = document.getElementById('skills-body');
  body.classList.remove('empty');
  replaceChildren(body, [
    el('table', null, [
      el('thead', null, [el('tr', null, [
        el('th', { class: 'name', text: 'Name' }), el('th', { text: 'Kind' }), el('th', { text: 'Source' }),
        el('th', { text: 'Hash' }), el('th', { text: 'Updated' }), el('th', { class: 'right', text: 'Actions' }),
      ])]),
      el('tbody', null, rows.map(skillRow)),
    ]),
  ]);
  applySkillsFilter();
}

function applySkillsFilter() {
  const needle = document.getElementById('skills-filter').value.trim().toLowerCase();
  const rows = Array.from(document.querySelectorAll('#skills-body tbody tr'));
  let shown = 0;
  for (const row of rows) {
    const match = needle === '' || row.dataset.name.toLowerCase().includes(needle);
    row.classList.toggle('hidden', !match);
    if (match) shown += 1;
  }
  const count = document.getElementById('skills-count');
  const total = skillsState.rows.length;
  count.textContent = needle === '' ? total + ' skills' : shown + ' of ' + total + ' skills';
}

function showLockBanner(envelope) {
  const line = (envelope.stderr || '').split('\n').find((text) => text.includes('lock is absent'));
  if (!line) {
    clearBanner('lock');
    return;
  }
  banner('lock', 'info', [
    el('strong', { text: 'No Nexus Lock.' }), ' ', el('span', { class: 'mono', text: line }),
    ' Only Custom and Control Skills are listed. Run ', el('code', { text: '/nexus-setup' }), ' once, then link.',
  ]);
}

async function loadSkills() {
  let envelope;
  try {
    envelope = await api('list');
  } catch (error) {
    return;
  }
  if (envelope.exit !== 0 || !envelope.json) {
    banner('skills-error', 'err', [
      el('strong', { text: 'nexus list failed.' }), ' ', el('span', { class: 'mono', text: (envelope.stderr || '').trim() }),
    ]);
    return;
  }
  clearBanner('skills-error');
  showLockBanner(envelope);
  skillsState.rows = envelope.json.skills;
  renderSkills(skillsState.rows);
}

document.getElementById('skills-filter').addEventListener('input', applySkillsFilter);
loadSkills();

// --- global instructions editor -------------------------------------------

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SOFT_WRAP_KEY = 'nexus.softWrap';

// What the page read at open. The save ticket sends content with sha256 and
// compares the textarea against loaded for the dirty state.
const editorState = { owner: null, present: false, sha256: EMPTY_SHA256, loaded: '', tab: 'edit' };

const editor = {};

function readSoftWrap() {
  try {
    return localStorage.getItem(SOFT_WRAP_KEY) !== 'off';
  } catch (error) {
    return true;
  }
}

function writeSoftWrap(on) {
  try {
    localStorage.setItem(SOFT_WRAP_KEY, on ? 'on' : 'off');
  } catch (error) {
    // Storage may be blocked; the toggle still applies for this page.
  }
}

// Home directory derived from the Owner path, and "~/..." for display.
function homeFromOwner(owner) {
  const suffix = '/.custom-skills/GLOBAL.md';
  return owner.endsWith(suffix) ? owner.slice(0, -suffix.length) : null;
}

function shortPath(path, home) {
  return home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

function instructionPaths(home) {
  return [
    { agent: 'claude', path: home + '/.claude/CLAUDE.md' },
    { agent: 'codex', path: home + '/.codex/AGENTS.md' },
  ];
}

function stateBadge(agent, state) {
  return el('span', { class: 'badge ' + (state === 'no home' ? 'nohome' : state), title: agent + ' Instruction Path' }, [
    el('i'), agent + ': ' + state,
  ]);
}

function foreignHint(agent, path, home, owner) {
  return el('div', { class: 'hint' }, [
    agent + ' Instruction Path ', el('code', { text: shortPath(path, home) }),
    ' is a Foreign Entry. Run ',
    el('code', { text: 'mv ' + shortPath(path, home) + ' ' + shortPath(owner, home) }),
    ', then link. The entry is preserved until you move it.',
  ]);
}

function buildEditor() {
  const body = document.getElementById('global-body');
  body.classList.remove('empty');
  body.classList.remove('card');

  editor.tabEdit = el('button', { class: 'tab on', type: 'button', text: 'Edit', onclick: () => showTab('edit') });
  editor.tabPreview = el('button', { class: 'tab', type: 'button', text: 'Preview', onclick: () => showTab('preview') });
  editor.wrapToggle = el('span', { class: 'toggle', role: 'switch', tabindex: '0', onclick: toggleSoftWrap,
    onkeydown: (event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggleSoftWrap(); } } },
    ['Soft wrap', el('b', null, [el('span')])]);
  editor.lineCount = el('span', { class: 'hint' });
  editor.previewNote = el('span', { class: 'hint', text: 'Rendered offline with the vendored Markdown renderer', hidden: '' });
  editor.tools = el('div', { class: 'ed-tools' }, [editor.wrapToggle, editor.lineCount, editor.previewNote]);

  editor.gutter = el('div', { class: 'gutter' });
  editor.textarea = el('textarea', {
    class: 'text', spellcheck: 'false', autocomplete: 'off', wrap: 'soft',
    placeholder: 'Write the rules every agent loads at the start of every session.',
    oninput: syncGutter, onkeydown: editorKeydown,
  });
  editor.editBody = el('div', { class: 'ed-body' }, [editor.gutter, editor.textarea]);
  editor.prose = el('div', { class: 'prose', hidden: '' });

  editor.cancel = el('button', { class: 'btn', type: 'button', id: 'cancel-button', text: 'Cancel' });
  editor.save = el('button', { class: 'btn pri', type: 'button', id: 'save-button', text: 'Save changes', disabled: '' });

  const box = el('div', { class: 'editor' }, [
    el('div', { class: 'ed-top' }, [el('div', { class: 'tabs' }, [editor.tabEdit, editor.tabPreview]), editor.tools]),
    editor.editBody,
    editor.prose,
    el('div', { class: 'ed-foot' }, [
      el('span', { class: 'hint' }, [
        'Save replaces the whole file. Nexus never runs Git; commit in ',
        el('code', { text: '~/.custom-skills' }), ' yourself. ',
        el('span', { class: 'kbd', text: 'Ctrl' }), ' ', el('span', { class: 'kbd', text: 'S' }),
      ]),
      el('div', { class: 'r' }, [editor.cancel, editor.save]),
    ]),
  ]);
  editor.hints = el('div', { class: 'ed-hints' });
  replaceChildren(body, [editor.hints, box]);
  applySoftWrap(readSoftWrap());
  syncGutter();
}

function applySoftWrap(on) {
  editor.wrapToggle.classList.toggle('on', on);
  editor.wrapToggle.setAttribute('aria-checked', on ? 'true' : 'false');
  editor.textarea.classList.toggle('nowrap', !on);
  editor.textarea.setAttribute('wrap', on ? 'soft' : 'off');
}

function toggleSoftWrap() {
  const on = !editor.wrapToggle.classList.contains('on');
  applySoftWrap(on);
  writeSoftWrap(on);
}

function syncGutter() {
  const count = editor.textarea.value.split('\n').length;
  const numbers = [];
  for (let line = 1; line <= count; line += 1) numbers.push(el('div', { text: String(line) }));
  replaceChildren(editor.gutter, numbers);
  const lines = editor.textarea.value === '' ? 0 : count;
  editor.lineCount.textContent = lines + (lines === 1 ? ' line' : ' lines');
  // Grow the textarea to its content so the editor body scrolls both
  // columns together.
  editor.textarea.style.height = 'auto';
  editor.textarea.style.height = editor.textarea.scrollHeight + 'px';
}

// Tab inserts two spaces at the caret so focus never leaves the editor.
function editorKeydown(event) {
  if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  const area = editor.textarea;
  const start = area.selectionStart;
  const end = area.selectionEnd;
  area.setRangeText('  ', start, end, 'end');
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

function showTab(name) {
  editorState.tab = name;
  const preview = name === 'preview';
  editor.tabEdit.classList.toggle('on', !preview);
  editor.tabPreview.classList.toggle('on', preview);
  editor.editBody.hidden = preview;
  editor.prose.hidden = !preview;
  editor.wrapToggle.hidden = preview;
  editor.lineCount.hidden = preview;
  editor.previewNote.hidden = !preview;
  if (preview) renderPreview();
  else editor.textarea.focus();
}

function renderPreview() {
  const source = editor.textarea.value;
  if (source.trim() === '') {
    replaceChildren(editor.prose, [el('p', { class: 'muted', text: 'Nothing to preview.' })]);
    return;
  }
  if (typeof marked === 'undefined' || typeof marked.parse !== 'function') {
    replaceChildren(editor.prose, [el('p', { class: 'muted', text: 'The vendored Markdown renderer did not load.' })]);
    return;
  }
  editor.prose.innerHTML = marked.parse(source);
}

function renderGlobalHeader(info) {
  const home = homeFromOwner(info.owner);
  const tools = document.getElementById('global-tools');
  const badges = [el('span', { class: 'hint mono', title: info.owner, text: shortPath(info.owner, home) })];
  const hints = [];
  if (home) {
    for (const entry of instructionPaths(home)) {
      const state = info[entry.agent];
      badges.push(stateBadge(entry.agent, state));
      if (state === 'foreign') hints.push(foreignHint(entry.agent, entry.path, home, info.owner));
    }
  }
  replaceChildren(tools, badges);
  replaceChildren(editor.hints, hints);
}

function renderGlobal(info) {
  editorState.owner = info.owner;
  editorState.present = info.present === true;
  editorState.sha256 = editorState.present ? info.sha256 : EMPTY_SHA256;
  editorState.loaded = editorState.present ? info.content : '';
  renderGlobalHeader(info);
  editor.textarea.value = editorState.loaded;
  syncGutter();
  if (editorState.tab === 'preview') renderPreview();
  if (editorState.present) {
    clearBanner('global-absent');
  } else {
    banner('global-absent', 'warn', [
      el('strong', { text: 'Global Instructions absent.' }), ' Owner ',
      el('code', { text: shortPath(info.owner, homeFromOwner(info.owner)) }),
      ' does not exist. The first save creates the file and runs link, so both Instruction Paths become Managed Links. Link notices show in Last command.',
    ]);
  }
}

async function loadGlobal() {
  if (!editor.textarea) buildEditor();
  let envelope;
  try {
    envelope = await api('global');
  } catch (error) {
    return null;
  }
  if (envelope.exit !== 0 || !envelope.json) {
    banner('global-error', 'err', [
      el('strong', { text: 'Global Instructions could not be read.' }), ' ',
      el('code', { text: commandLabel(envelope.command) }), ' exited ' + envelope.exit + '.',
      el('pre', { class: 'log mono', text: (envelope.stderr || envelope.stdout || '').trim() }),
    ]);
    return envelope;
  }
  clearBanner('global-error');
  renderGlobal(envelope.json);
  return envelope;
}

loadGlobal();

// --- save global instructions ----------------------------------------------

const saveState = { busy: false, unsaved: null };

function editorDirty() {
  return editor.textarea && editor.textarea.value !== editorState.loaded;
}

function abbreviatedHash(hash) {
  return el('code', { class: 'mono', title: hash, text: hash.slice(0, 4) + '…' + hash.slice(-4) });
}

// The read-only panel that keeps the user's text after a conflict. Nothing
// on the page can write it to disk: the user copies it and edits again.
function showUnsavedPanel(text) {
  removeUnsavedPanel();
  const pre = el('pre', { class: 'log mono muted', text });
  const copy = el('button', { class: 'btn sm', type: 'button', text: 'Copy', onclick: async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    } catch (error) {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copy.textContent = 'Selected';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  } });
  saveState.unsaved = el('div', { class: 'card', id: 'unsaved-panel' }, [
    el('div', { class: 'out-hd' }, [
      el('span', { class: 'cmd', text: 'Your unsaved version' }),
      el('span', { text: 'kept until you reload the page' }),
      el('div', { class: 'grow' }),
      copy,
    ]),
    pre,
  ]);
  document.getElementById('global').append(saveState.unsaved);
}

function removeUnsavedPanel() {
  if (saveState.unsaved) saveState.unsaved.remove();
  saveState.unsaved = null;
}

function showConflict(stderr, text) {
  const match = /expected sha256 ([0-9a-f]{64}), actual ([0-9a-f]{64})/.exec(stderr);
  const expected = match ? abbreviatedHash(match[1]) : el('code', { text: '?' });
  const found = match ? abbreviatedHash(match[2]) : el('code', { text: '?' });
  banner('global-conflict', 'err', [
    el('strong', { text: 'Not saved. GLOBAL.md changed on disk since you opened it.' }), el('br'),
    'Nexus refused the write with ', el('code', { text: '--if-match' }), '. Expected sha256 ', expected,
    ', found ', found, '. The editor now shows the current file. Your unsaved text is kept below.',
  ]);
  showUnsavedPanel(text);
}

function setSaving(busy) {
  saveState.busy = busy;
  editor.save.disabled = busy;
  editor.cancel.disabled = busy;
  replaceChildren(editor.save, busy ? [el('span', { class: 'spin' }), 'Saving'] : ['Save changes']);
}

async function saveGlobal() {
  if (saveState.busy || !editor.textarea || editor.save.disabled) return;
  const content = editor.textarea.value;
  const ifMatch = editorState.sha256;
  setSaving(true);
  let envelope;
  try {
    envelope = await api('global', { method: 'PUT', body: { content, ifMatch } });
  } catch (error) {
    setSaving(false);
    if (error.status) {
      banner('global-save-error', 'err', [
        el('strong', { text: 'Not saved.' }), ' The server answered HTTP ' + error.status + ' (' + error.text + ').',
      ]);
    }
    return;
  }
  setSaving(false);
  if (envelope.exit === 0) {
    clearBanner('global-conflict');
    clearBanner('global-save-error');
    removeUnsavedPanel();
    toast(['Saved. Commit in ', el('code', { text: '~/.custom-skills' }), '.']);
    await loadGlobal();
    return;
  }
  const stderr = envelope.stderr || '';
  if (stderr.includes('global instructions changed since they were read')) {
    clearBanner('global-save-error');
    showConflict(stderr, content);
    await loadGlobal();
    return;
  }
  clearBanner('global-conflict');
  banner('global-save-error', 'err', [
    el('strong', { text: 'Not saved.' }), ' ', el('code', { text: commandLabel(envelope.command) }),
    ' exited ' + envelope.exit + '.',
    el('pre', { class: 'log mono', text: (stderr || envelope.stdout || '').trim() }),
  ]);
}

function cancelEdit() {
  if (saveState.busy || !editor.textarea) return;
  if (editorDirty() && !confirm('Discard your unsaved edits and restore the file as it was loaded?')) return;
  editor.textarea.value = editorState.loaded;
  editor.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  if (editorState.tab === 'preview') renderPreview();
}

function initSave() {
  const wire = () => {
    if (!editor.save) return false;
    editor.save.disabled = false;
    editor.save.addEventListener('click', saveGlobal);
    editor.cancel.addEventListener('click', cancelEdit);
    return true;
  };
  // The editor is built by loadGlobal(); wire once it exists.
  if (!wire()) {
    const timer = setInterval(() => { if (wire()) clearInterval(timer); }, 50);
  }
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      saveGlobal();
    }
  });
  window.addEventListener('beforeunload', (event) => {
    if (!editorDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

initSave();

// --- update and remove ------------------------------------------------------

// One mutation at a time on the page as on the server: while a command
// runs, every mutation button is disabled and the row shows a spinner.
const mutationState = { running: null };

function setMutationButtons(enabled) {
  for (const button of document.querySelectorAll('#skills-body button[data-action]')) {
    button.disabled = !enabled;
  }
  const save = document.getElementById('save-button');
  if (save && !enabled) save.disabled = true;
}

function showRowSpinner(name, label) {
  const row = document.querySelector('#skills-body tr[data-name="' + CSS.escape(name) + '"]');
  if (!row) return;
  const button = row.querySelector('button[data-action="' + label.toLowerCase() + '"]');
  if (button) replaceChildren(button, [el('span', { class: 'spin' }), label === 'update' ? 'Updating' : 'Removing']);
}

async function refreshAll() {
  await loadSkills();
  await loadGlobal();
}

// Run update or remove for one Installed Skill through the CLI, then
// refetch list and global so the page never shows stale state.
async function runMutation(action, name) {
  if (mutationState.running) return;
  mutationState.running = action + ' ' + name;
  setMutationButtons(false);
  showRowSpinner(name, action);
  clearBanner('mutation');
  try {
    const envelope = await api(action, { method: 'POST', body: { name } });
    if (envelope.exit !== 0) {
      banner('mutation', 'err', [
        el('strong', { text: 'nexus ' + action + ' ' + name + ' failed (exit ' + envelope.exit + ').' }),
        ' The exact output is in Last command.',
      ]);
    } else {
      toast([action === 'update' ? 'Updated ' : 'Removed ', el('code', { text: name }), '.']);
    }
  } catch (error) {
    if (error.status === 409) {
      banner('mutation', 'warn', [el('strong', { text: 'Another command is still running.' }), ' Wait for it, then try again.']);
    } else if (error.status) {
      banner('mutation', 'err', [el('strong', { text: 'Request refused: HTTP ' + error.status + ' ' + (error.text || '') })]);
    }
  } finally {
    mutationState.running = null;
  }
  await refreshAll();
  setMutationButtons(true);
}

function openRemoveDialog(name) {
  const input = el('input', { class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: name });
  const confirmButton = el('button', { class: 'btn dng', type: 'button', disabled: '', text: 'Remove ' + name });
  const dialog = el('dialog', { class: 'modal' }, [
    el('div', { class: 'modal-hd', text: 'Remove Installed Skill' }),
    el('div', { class: 'modal-body' }, [
      el('div', null, [
        'This runs ', el('code', { text: 'nexus remove ' + name }), '. Upstream ',
        el('code', { text: 'npx skills remove' }),
        ' deletes the skill under the Canonical Root, then Nexus publishes the lock and links. Foreign Entries and other skills are left alone.',
      ]),
      el('div', { class: 'hint' }, ['Type ', el('span', { class: 'mono strong', text: name }), ' to confirm.']),
      input,
    ]),
    el('div', { class: 'modal-ft' }, [
      el('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: () => dialog.close() }),
      confirmButton,
    ]),
  ]);
  input.addEventListener('input', () => { confirmButton.disabled = input.value !== name; });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && input.value === name) confirmButton.click();
  });
  confirmButton.addEventListener('click', () => {
    if (input.value !== name) return;
    dialog.close();
    runMutation('remove', name);
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}

document.getElementById('skills-body').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const { action, name } = button.dataset;
  if (action === 'update') runMutation('update', name);
  else if (action === 'remove') openRemoveDialog(name);
});
