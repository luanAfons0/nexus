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
