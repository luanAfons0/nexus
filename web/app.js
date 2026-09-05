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

function initShell() {
  document.getElementById('base-url').textContent = location.origin + BASE;
  const links = Array.from(document.querySelectorAll('#subnav a'));
  const sections = links.map((link) => document.querySelector(link.getAttribute('href')));
  function markActive() {
    let current = 0;
    sections.forEach((section, index) => {
      if (section && section.getBoundingClientRect().top <= 80) current = index;
    });
    links.forEach((link, index) => link.classList.toggle('on', index === current));
  }
  window.addEventListener('scroll', markActive, { passive: true });
  markActive();
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
      el('button', { class: 'btn sm', type: 'button', 'data-action': 'update', 'data-name': row.name, disabled: '', text: 'Update' }),
      el('button', { class: 'btn sm', type: 'button', 'data-action': 'remove', 'data-name': row.name, disabled: '', text: 'Remove' }),
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
