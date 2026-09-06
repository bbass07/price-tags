// ui.js — screen wiring. Keeps no state of its own beyond the print queue.

import { Store, formatPrice } from './store.js';
import { Printer } from './printer.js';
import { renderLabel, canvasToBitmap } from './render.js';
import { isSupported } from './ble.js';
import { printLabels } from './job.js';

const $ = (id) => document.getElementById(id);
const store = new Store();
const printer = new Printer();
const queue = new Map();       // labelId -> quantity
let editingId = null;

// ── chrome ────────────────────────────────────────────────────────────────

function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('toast--bad', bad);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, bad ? 5000 : 2600);
}

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t.dataset.view === name);
  $('viewTitle').textContent = { print: 'Print', labels: 'Labels', setup: 'Setup' }[name];
  $('printBar').hidden = name !== 'print' || queue.size === 0;
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}
$('printerChip').addEventListener('click', () => showView('setup'));

// ── printer ───────────────────────────────────────────────────────────────

const logLines = [];
function plog(msg) {
  logLines.push(`${new Date().toLocaleTimeString()}  ${msg}`);
  if (logLines.length > 200) logLines.shift();
  $('printerLog').textContent = logLines.join('\n');
  // Mirror to the dev server when one is running, so the terminal can read it.
  if (location.hostname === 'localhost') {
    fetch('/log', { method: 'POST', body: msg }).catch(() => {});
  }
}
printer.addEventListener('log', (e) => plog(e.detail));

function paintPrinterState() {
  const on = printer.connected;
  $('printerChip').className = `chip ${on ? 'chip--ok' : 'chip--bad'}`;
  $('printerChipText').textContent = on ? (printer.name || 'Printer') : 'No printer';
  $('btnConnect').hidden = on;
  $('btnDisconnect').hidden = !on;
  if (!on) {
    $('printerState').textContent = 'Not connected.';
    return;
  }
  const info = printer.info;
  const bits = [`Connected to ${printer.name || 'printer'}.`];
  if (info?.firmware) bits.push(`Firmware ${info.firmware}.`);
  const problems = info?.status?.problems || [];
  bits.push(problems.length ? `Needs attention: ${problems.join(', ')}.` : 'Ready.');
  $('printerState').textContent = bits.join(' ');
}

printer.addEventListener('connected', paintPrinterState);
printer.addEventListener('disconnected', () => { toast('Printer disconnected', true); paintPrinterState(); });

/**
 * Turn whatever the Bluetooth stack threw into something a human can act on.
 * Chrome and Bluefy both report failures as bare DOMExceptions, sometimes with
 * an empty message, so the error *name* is usually the only real signal.
 */
function explainConnectError(err) {
  const name = err && err.name ? err.name : 'Error';
  const detail = (err && err.message ? String(err.message) : '').trim();
  switch (name) {
    case 'NotFoundError':
      return detail.includes('chooser')
        ? { fatal: false, text: 'You closed the device list without picking anything.' }
        : { fatal: true, text: 'No printer appeared in the list. Make sure it is switched on and not already connected to the Katasymbol app on your phone — a printer can only talk to one thing at a time. Ticking "Show every Bluetooth device" also helps if it is advertising under a different name.' };
    case 'SecurityError':
      return { fatal: true, text: 'The browser blocked Bluetooth on this page. It has to be loaded over https:// or from localhost.' };
    case 'NotAllowedError':
      return { fatal: true, text: 'Bluetooth permission was refused. On a Mac, check System Settings → Privacy & Security → Bluetooth and make sure your browser is switched on there, then quit the browser fully and reopen it.' };
    case 'NetworkError':
      return { fatal: true, text: 'The printer was found but dropped the connection. Turn it off and on and try again.' };
    case 'NotSupportedError':
      return { fatal: true, text: 'This browser cannot do Bluetooth. Use Chrome on a computer, or the Bluefy app on iPhone.' };
    default:
      return { fatal: true, text: detail || `Bluetooth failed with "${name}" and gave no reason. The diagnostics below have the details.` };
  }
}

function showPrinterError(text) {
  const el = $('printerError');
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = text;
  $('diagBox').open = true;
}

$('btnConnect').addEventListener('click', async () => {
  const btn = $('btnConnect');
  btn.disabled = true;
  showPrinterError('');
  plog(`connect requested — ${navigator.bluetooth ? 'Web Bluetooth present' : 'NO Web Bluetooth in this browser'}, secure context: ${window.isSecureContext}`);
  try {
    await printer.connect({ showAll: $('showAllDevices').checked });
    plog('reading printer identity…');
    const info = await printer.identify();
    plog(`status: ${JSON.stringify(info.status?.raw)} problems: ${info.status?.problems?.join(', ') || 'none'}`);
    toast('Printer connected');
  } catch (err) {
    const { fatal, text } = explainConnectError(err);
    plog(`connect failed [${err && err.name}] ${err && err.message ? err.message : '(no message)'}`);
    if (fatal) { showPrinterError(text); toast('Could not connect — see Setup', true); }
    else { plog(text); }
  } finally {
    btn.disabled = false;
    paintPrinterState();
  }
});

$('btnCopyLog').addEventListener('click', async () => {
  const text = [
    `browser: ${navigator.userAgent}`,
    `page: ${location.href}`,
    `web bluetooth: ${!!navigator.bluetooth}   secure context: ${window.isSecureContext}`,
    '',
    ...logLines,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('Diagnostics copied');
  } catch {
    // Clipboard is blocked in some in-app browsers; fall back to selecting it.
    const pre = $('printerLog');
    pre.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selected — long-press to copy');
  }
});

$('btnDisconnect').addEventListener('click', () => printer.disconnect());

if (!isSupported()) {
  const w = $('bleWarning');
  w.hidden = false;
  w.classList.add('banner--bad');
  w.innerHTML = /iPhone|iPad|Mac/.test(navigator.platform) && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)
    ? 'Safari cannot use Bluetooth at all. On iPhone, open this page in the free <b>Bluefy</b> app; on a Mac, use <b>Chrome</b>.'
    : 'This browser has no Bluetooth support. Use <b>Chrome</b> on a computer, or <b>Bluefy</b> on iPhone. Firefox and Safari will not work.';
  $('btnConnect').disabled = true;
}

// ── locations ─────────────────────────────────────────────────────────────

function paintLocations() {
  const bar = $('locBar');
  bar.innerHTML = '';
  if (store.locations.length === 0) {
    bar.innerHTML = '<p class="muted">Add a location on the Setup tab to set your booth number.</p>';
  }
  for (const loc of store.locations) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'locbar__btn' + (store.activeLocation?.id === loc.id ? ' is-active' : '');
    b.innerHTML = `${escapeHtml(loc.name)}<small>Booth ${escapeHtml(loc.booth)}</small>`;
    b.addEventListener('click', () => { store.setActiveLocation(loc.id); paintLocations(); paintQueueBar(); });
    bar.appendChild(b);
  }

  const list = $('locList');
  list.innerHTML = '';
  for (const loc of store.locations) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `<div class="item__main"><div class="item__name">${escapeHtml(loc.name)}</div>
      <div class="item__sub">Booth ${escapeHtml(loc.booth)}</div></div>`;
    const del = document.createElement('button');
    del.className = 'btn btn--danger';
    del.type = 'button';
    del.textContent = 'Remove';
    del.addEventListener('click', () => {
      if (confirm(`Remove "${loc.name}"?`)) { store.removeLocation(loc.id); paintLocations(); }
    });
    li.appendChild(del);
    list.appendChild(li);
  }
}

$('addLoc').addEventListener('click', () => {
  const name = $('newLocName').value.trim();
  const booth = $('newLocBooth').value.trim();
  if (!name || !booth) return toast('Give the location a name and a booth number', true);
  store.addLocation({ name, booth });
  $('newLocName').value = '';
  $('newLocBooth').value = '';
  paintLocations();
});

// ── label library ─────────────────────────────────────────────────────────

function labelRow(label, { withStepper }) {
  const li = document.createElement('li');
  const qty = queue.get(label.id) || 0;
  li.className = 'item' + (qty > 0 ? ' is-queued' : '');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'item__main';
  main.innerHTML = `<div class="item__name">${escapeHtml(label.name)}</div>` +
    (label.note ? `<div class="item__sub">${escapeHtml(label.note)}</div>` : '');
  li.appendChild(main);

  const price = document.createElement('div');
  price.className = 'item__price';
  price.textContent = formatPrice(label.price);
  li.appendChild(price);

  if (withStepper) {
    main.addEventListener('click', () => bump(label.id, +1));
    const st = document.createElement('div');
    st.className = 'stepper';
    const minus = document.createElement('button');
    minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'one fewer');
    const count = document.createElement('span');
    count.textContent = String(qty);
    const plus = document.createElement('button');
    plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'one more');
    minus.addEventListener('click', () => bump(label.id, -1));
    plus.addEventListener('click', () => bump(label.id, +1));
    st.append(minus, count, plus);
    li.appendChild(st);
  } else {
    main.addEventListener('click', () => openEditor(label.id));
  }
  return li;
}

function bump(id, delta) {
  const next = Math.max(0, (queue.get(id) || 0) + delta);
  if (next === 0) queue.delete(id); else queue.set(id, next);
  paintPrintList();
  paintQueueBar();
}

function paintPrintList() {
  const rows = store.search($('printSearch').value);
  const list = $('printList');
  list.innerHTML = '';
  for (const l of rows) list.appendChild(labelRow(l, { withStepper: true }));
  $('printEmpty').hidden = store.labels.length !== 0;
}

function paintLabelList() {
  const rows = store.search($('labelSearch').value);
  const list = $('labelList');
  list.innerHTML = '';
  for (const l of rows) list.appendChild(labelRow(l, { withStepper: false }));
  $('labelEmpty').hidden = store.labels.length !== 0;
}

$('printSearch').addEventListener('input', paintPrintList);
$('labelSearch').addEventListener('input', paintLabelList);
$('clearQueue').addEventListener('click', () => { queue.clear(); paintPrintList(); paintQueueBar(); });

// ── editor ────────────────────────────────────────────────────────────────

function openEditor(id) {
  editingId = id;
  const label = id ? store.labels.find((l) => l.id === id) : null;
  $('editorTitle').textContent = label ? 'Edit label' : 'New label';
  $('fName').value = label?.name || '';
  $('fPrice').value = label?.price || '';
  $('fNote').value = label?.note || '';
  $('fDelete').hidden = !label;
  paintPreview();
  $('editor').showModal();
  if (!label) setTimeout(() => $('fName').focus(), 50);
}

function paintPreview() {
  const { labelWidthMm, labelHeightMm } = store.settings;
  const canvas = $('previewCanvas');
  canvas.style.width = `${labelWidthMm}mm`;
  canvas.style.height = `${labelHeightMm}mm`;
  renderLabel(canvas, {
    booth: store.activeLocation?.booth || '',
    name: $('fName').value || 'Item name',
    price: formatPrice($('fPrice').value) || '$0.00',
    note: $('fNote').value,
  }, { widthMm: labelWidthMm, heightMm: labelHeightMm });
}

for (const f of ['fName', 'fPrice', 'fNote']) $(f).addEventListener('input', paintPreview);

$('newLabel').addEventListener('click', () => openEditor(null));

$('editorForm').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value !== 'save') return;
  const name = $('fName').value.trim();
  if (!name) { e.preventDefault(); return toast('Give the label a name', true); }
  const patch = { name, price: $('fPrice').value.trim(), note: $('fNote').value.trim() };
  if (editingId) store.updateLabel(editingId, patch); else store.addLabel(patch);
  refreshLists();
  toast(editingId ? 'Label updated' : 'Label saved');
});

$('fDelete').addEventListener('click', () => {
  if (!editingId) return;
  const label = store.labels.find((l) => l.id === editingId);
  if (!confirm(`Delete "${label?.name}"?`)) return;
  store.removeLabel(editingId);
  queue.delete(editingId);
  $('editor').close();
  refreshLists();
  toast('Label deleted');
});

// ── settings & backup ─────────────────────────────────────────────────────

$('labelW').addEventListener('change', (e) => { store.updateSettings({ labelWidthMm: Number(e.target.value) }); paintPreview(); });
$('labelH').addEventListener('change', (e) => { store.updateSettings({ labelHeightMm: Number(e.target.value) }); paintPreview(); });
$('density').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('densityValue').textContent = String(v);
  store.updateSettings({ density: v });
});

$('btnExport').addEventListener('click', () => {
  const blob = new Blob([store.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `price-tags-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('btnImport').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const mode = store.labels.length && confirm('Replace your current labels?\n\nOK = replace, Cancel = merge in') ? 'replace' : 'merge';
    store.importJSON(await file.text(), mode);
    refreshLists();
    toast('Backup imported');
  } catch (err) {
    toast(err.message, true);
  }
  e.target.value = '';
});

// ── printing ──────────────────────────────────────────────────────────────

function paintQueueBar() {
  const total = [...queue.values()].reduce((a, b) => a + b, 0);
  $('queueCount').textContent = String(total);
  $('queueLoc').textContent = store.activeLocation ? `Booth ${store.activeLocation.booth}` : 'no location';
  $('printBar').hidden = total === 0 || $('view-print').hidden;
}

$('btnPrint').addEventListener('click', async () => {
  const loc = store.activeLocation;
  if (!loc) return toast('Pick a location first', true);
  if (!printer.connected) { showView('setup'); return toast('Connect the printer first', true); }

  const jobs = [];
  for (const [id, qty] of queue) {
    const label = store.labels.find((l) => l.id === id);
    if (label) jobs.push({ label: { ...label, priceDisplay: formatPrice(label.price) }, qty });
  }
  if (!jobs.length) return;

  const btn = $('btnPrint');
  btn.disabled = true;
  try {
    await printLabels(printer, jobs, {
      booth: loc.booth,
      settings: store.settings,
      onProgress: (done, total) => { btn.textContent = `Printing ${done}/${total}`; },
      log: plog,
    });
    toast('Printed');
    queue.clear();
    paintPrintList();
    paintQueueBar();
  } catch (err) {
    plog(`print failed: ${err.message}`);
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Print';
  }
});

// ── boot ──────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refreshLists() {
  paintPrintList();
  paintLabelList();
  paintQueueBar();
}

function boot() {
  $('labelW').value = store.settings.labelWidthMm;
  $('labelH').value = store.settings.labelHeightMm;
  $('density').value = store.settings.density;
  $('densityValue').textContent = String(store.settings.density);
  paintLocations();
  refreshLists();
  paintPrinterState();
  showView('print');
}

boot();

// Offline support. Harmless where the browser has no service workers.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
}

// Exposed for console poking during development.
window.app = { store, printer, queue, renderLabel, canvasToBitmap };
