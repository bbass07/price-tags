// ui.js — screen wiring. Keeps no state of its own beyond the print queue.

import { Store, formatPrice } from './store.js';
import { Printer } from './printer.js';
import { labelLayout, labelDots, renderLabel, canvasToBitmap } from './render.js';
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

// Printing is two steps — pick the booth, then pick the labels — so `pick` is
// a screen of its own that still belongs to the Print tab.
const VIEW_TAB = { print: 'print', pick: 'print', labels: 'labels', setup: 'setup' };
let view = 'print';

function showView(name) {
  view = name;
  setPrinterPop(false);
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${name}`;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t.dataset.view === VIEW_TAB[name]);
  $('viewTitle').textContent = name === 'pick'
    ? (store.activeLocation?.name || 'Print')
    : { print: 'Print', labels: 'Labels', setup: 'Setup' }[name];
  $('btnBack').hidden = name !== 'pick';
  paintQueueBar();
}

for (const tab of document.querySelectorAll('.tab')) {
  // Tapping Print always returns to the booth menu, which is the way back out
  // of a half-built queue without hunting for a back arrow.
  tab.addEventListener('click', () => showView(tab.dataset.view));
}
$('printerChip').addEventListener('click', (e) => { e.stopPropagation(); togglePrinterPop(); });
$('btnBack').addEventListener('click', () => showView('print'));

// ── printer ───────────────────────────────────────────────────────────────

// The chip's panel. Opening it is how you connect from wherever you are; the
// Setup card stays the full version, one tap further in.
function setPrinterPop(open) {
  $('printerPop').hidden = !open;
  $('printerChip').setAttribute('aria-expanded', String(open));
  if (open) {
    $('popShowAll').checked = $('showAllDevices').checked;
    showConnectError('');
  }
}
const togglePrinterPop = () => setPrinterPop($('printerPop').hidden);

// Anything else on the page dismisses it, the way a menu should.
document.addEventListener('click', (e) => {
  if (!$('printerPop').hidden && !$('printerPop').contains(e.target)) setPrinterPop(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPrinterPop(false); });

$('popShowAll').addEventListener('change', (e) => { $('showAllDevices').checked = e.target.checked; });
$('showAllDevices').addEventListener('change', (e) => { $('popShowAll').checked = e.target.checked; });
$('popSetup').addEventListener('click', () => { setPrinterPop(false); showView('setup'); });


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

/** What to call the printer on screen: the user's nickname, else its real name. */
function printerLabel() {
  return (store.settings.printerNickname || '').trim() || printer.name || 'Printer';
}

function printerStateText() {
  if (!printer.connected) return 'Not connected.';
  const info = printer.info;
  // Show the hardware name alongside, so the Bluetooth chooser still makes sense.
  const hardware = printer.name && printer.name !== printerLabel() ? ` (${printer.name})` : '';
  const bits = [`Connected to ${printerLabel()}${hardware}.`];
  if (info?.firmware) bits.push(`Firmware ${info.firmware}.`);
  const problems = info?.status?.problems || [];
  bits.push(problems.length ? `Needs attention: ${problems.join(', ')}.` : 'Ready.');
  return bits.join(' ');
}

function paintPrinterState() {
  const on = printer.connected;
  $('printerChip').className = `chip ${on ? 'chip--ok' : 'chip--bad'}`;
  $('printerChipText').textContent = on ? printerLabel() : 'No printer';
  const text = printerStateText();
  $('printerState').textContent = text;
  $('popState').textContent = text;
  $('btnConnect').hidden = on;
  $('popConnect').hidden = on;
  $('btnDisconnect').hidden = !on;
  $('popDisconnect').hidden = !on;
}

printer.addEventListener('connected', paintPrinterState);
printer.addEventListener('disconnected', () => { toast('Printer disconnected', true); paintPrinterState(); });

/**
 * Turn whatever the Bluetooth stack threw into something a human can act on.
 * Chrome and the iPhone BLE browsers all report failures as bare DOMExceptions, sometimes with
 * an empty message, so the error *name* is usually the only real signal.
 */
function explainConnectError(err) {
  const name = err && err.name ? err.name : 'Error';
  const detail = (err && err.message ? String(err.message) : '').trim();
  switch (name) {
    case 'BluetoothOffError':
      return { fatal: true, text: detail };
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
      return { fatal: true, text: 'This browser cannot do Bluetooth. Use Chrome on a computer, or the BLE Link app on iPhone.' };
    default:
      return { fatal: true, text: detail || `Bluetooth failed with "${name}" and gave no reason. The diagnostics below have the details.` };
  }
}

/** Put a connect failure on both the Setup card and the chip's panel. */
function showConnectError(text) {
  for (const id of ['printerError', 'popError']) {
    const el = $(id);
    el.hidden = !text;
    el.textContent = text || '';
  }
  if (text) $('diagBox').open = true;
}

/**
 * Connect, driven from either the Setup card or the chip's panel.
 *
 * Web Bluetooth only opens its device chooser during a real tap, so this must
 * be called straight from the click handler — never behind a timer.
 */
async function runConnect(btn) {
  btn.disabled = true;
  showConnectError('');
  plog(`connect requested — ${navigator.bluetooth ? 'Web Bluetooth present' : 'NO Web Bluetooth in this browser'}, secure context: ${window.isSecureContext}`);
  try {
    await printer.connect({ showAll: $('showAllDevices').checked });
    plog('reading printer identity…');
    const info = await printer.identify();
    plog(`status: ${JSON.stringify(info.status?.raw)} problems: ${info.status?.problems?.join(', ') || 'none'}`);
    toast('Printer connected');
    setPrinterPop(false);   // it did its job; get out of the way
  } catch (err) {
    const { fatal, text } = explainConnectError(err);
    plog(`connect failed [${err && err.name}] ${err && err.message ? err.message : '(no message)'}`);
    // The reason shows in the panel if that is what you are looking at, so the
    // toast no longer sends you to Setup to read it.
    if (fatal) { showConnectError(text); toast('Could not connect', true); }
    else { plog(text); }
  } finally {
    btn.disabled = false;
    paintPrinterState();
  }
}

$('btnConnect').addEventListener('click', () => runConnect($('btnConnect')));
$('popConnect').addEventListener('click', () => runConnect($('popConnect')));

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
$('popDisconnect').addEventListener('click', () => { printer.disconnect(); setPrinterPop(false); });

if (!isSupported()) {
  const w = $('bleWarning');
  w.hidden = false;
  w.classList.add('banner--bad');
  w.innerHTML = /iPhone|iPad|Mac/.test(navigator.platform) && /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)
    ? 'Safari cannot use Bluetooth at all. On iPhone, open this page in the free <b>BLE Link</b> app; on a Mac, use <b>Chrome</b>.'
    : 'This browser has no Bluetooth support. Use <b>Chrome</b> on a computer, or <b>BLE Link</b> on iPhone. Firefox and Safari will not work.';
  $('btnConnect').disabled = true;
  $('popConnect').disabled = true;
  // The panel has no room for the full explanation; it points at the one place
  // that does rather than saying nothing.
  $('popSetup').textContent = 'Why it cannot connect';
}

// ── locations ─────────────────────────────────────────────────────────────

function paintLocations() {
  const cards = $('locCards');
  cards.innerHTML = '';
  // With nothing to choose between, an empty grid would just strand the
  // explanation at the bottom of a tall screen.
  const empty = store.locations.length === 0;
  cards.hidden = empty;
  $('locEmpty').hidden = !empty;
  for (const loc of store.locations) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'loccard';
    b.innerHTML = `<span class="loccard__name">${escapeHtml(loc.name)}</span>` +
      `<span class="loccard__booth">Booth ${escapeHtml(loc.booth)}</span>`;
    b.addEventListener('click', () => openLocation(loc.id));
    cards.appendChild(b);
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

/**
 * Step into the product list for one location.
 *
 * The queue is a count of labels for a booth, so switching booths starts a new
 * one — carrying quantities across would quietly print the wrong booth number.
 */
function openLocation(id) {
  if (store.activeLocation?.id !== id && queue.size) queue.clear();
  store.setActiveLocation(id);
  const loc = store.activeLocation;
  $('printSearch').value = '';
  paintPrintList();
  showView('pick');
}

// ── label library ─────────────────────────────────────────────────────────

function labelRow(label, { withStepper }) {
  const li = document.createElement('li');
  const qty = queue.get(label.id) || 0;
  li.className = 'item' + (qty > 0 ? ' is-queued' : '');

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'item__main';
  main.innerHTML = `<div class="item__name">${escapeHtml(label.name)}</div>`;
  li.appendChild(main);

  const price = document.createElement('div');
  price.className = 'item__price';
  price.textContent = formatPrice(label.price);

  if (withStepper) {
    // The stepper eats the width a price column would need, and at a booth the
    // name is what you are hunting for — so the price tucks under it and the
    // name gets the whole row.
    main.classList.add('item__main--stacked');
    main.appendChild(price);
  } else {
    li.appendChild(price);
  }

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
  // Show the tidied price, because the tag has to show what prints — an older
  // label saved as "12.50" prints as "$12.50".
  $('fPrice').value = formatPrice(label?.price || '');
  $('fDelete').hidden = !label;
  layoutTag();
  $('editor').showModal();
  layoutTag();                 // widths are only real once the sheet is shown
  if (!label) setTimeout(() => $('fName').focus(), 50);
}

// ── the tag-shaped editor ─────────────────────────────────────────────────
//
// The three boxes are placed and sized from render.js's own layout, scaled up
// by however many screen pixels one printer dot is worth. That way the form is
// not a lookalike of the print — it is the same geometry, so a name that has to
// shrink to fit on paper shrinks here too, before the label is ever committed.

const measure = document.createElement('canvas').getContext('2d');
const DOTS = labelDots();

/** Put `el` over `box` (in dots) and give it `size`-dot text. */
function placeBlock(el, box, size, lineHeight, dot) {
  el.style.left = `${(box.x / DOTS.width) * 100}%`;
  el.style.top = `${(box.y / DOTS.height) * 100}%`;
  el.style.width = `${(box.w / DOTS.width) * 100}%`;
  el.style.height = `${(box.h / DOTS.height) * 100}%`;
  el.style.fontSize = `${size * dot}px`;
  if (lineHeight) el.style.lineHeight = `${lineHeight * dot}px`;
}

function layoutTag() {
  const tag = $('tag');
  const dot = tag.clientWidth / DOTS.width;
  if (!dot) return;                      // sheet not laid out yet

  const booth = store.activeLocation?.booth || '';
  const nameText = $('fName').value || $('fName').placeholder;
  const priceText = formatPrice($('fPrice').value) || $('fPrice').placeholder;
  const L = labelLayout(measure, { booth, name: nameText, price: priceText });

  const boothSlot = $('tagBoothSlot');
  boothSlot.hidden = !booth;
  $('tagBooth').textContent = L.booth.text;
  placeBlock(boothSlot, L.booth.box, L.booth.fit.size, L.booth.fit.lineHeight, dot);

  const nameSlot = $('tagNameSlot');
  placeBlock(nameSlot, L.name.box, L.name.fit.size, L.name.fit.lineHeight, dot);
  $('fName').style.fontWeight = L.name.weight;
  // The textarea is only as tall as the lines it holds, so the flex slot can
  // centre it the way `drawLines` centres the block on paper. The spare pixel
  // is for the browser's own rounding — without it descenders get clipped.
  $('fName').style.height = `${Math.ceil(L.name.fit.lines.length * L.name.fit.lineHeight * dot) + 2}px`;

  const priceSlot = $('tagPriceSlot');
  placeBlock(priceSlot, L.price.box, L.price.fit.size, L.price.fit.lineHeight, dot);
  $('fPrice').style.fontWeight = L.price.weight;
}

for (const f of ['fName', 'fPrice']) $(f).addEventListener('input', layoutTag);

// Enter in the name box means "done", not a second line — the printer only
// ever gets one name, wrapped to fit.
$('fName').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  $('fPrice').focus();
});

// The price is tidied to "$12.50" as soon as you leave it, so the tag shows
// what will actually print rather than what was typed.
$('fPrice').addEventListener('blur', () => {
  const tidy = formatPrice($('fPrice').value);
  if (tidy && tidy !== $('fPrice').value) $('fPrice').value = tidy;
  layoutTag();
});

new ResizeObserver(layoutTag).observe($('tag'));

// The tag is mostly paper, and paper is a big target. Tapping any blank part
// of it puts the cursor in whichever field is nearest, rather than nothing.
$('tag').addEventListener('mousedown', (e) => {
  if (e.target.closest('.tag__input')) return;
  e.preventDefault();
  const r = $('tag').getBoundingClientRect();
  const priceTop = $('tagPriceSlot').getBoundingClientRect().top;
  $(e.clientY >= priceTop ? 'fPrice' : 'fName').focus();
});

$('newLabel').addEventListener('click', () => openEditor(null));

// Leaving the sheet must always be possible, including with the form empty.
// The Cancel button carries `formnovalidate` for the same reason: without it
// the browser's "this field is required" check blocks the way out.
$('fClose').addEventListener('click', () => $('editor').close('cancel'));
$('editor').addEventListener('click', (e) => {
  // Backdrop taps close the sheet, but the dialog's own padding also reports
  // the dialog as the target — closing on that would throw away typed input
  // from a slightly-off tap near the edge. Check the geometry instead.
  if (e.target !== $('editor')) return;
  const r = $('editor').getBoundingClientRect();
  const outside = e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right;
  if (outside) $('editor').close('cancel');
});

$('editorForm').addEventListener('submit', (e) => {
  if (e.submitter && e.submitter.value !== 'save') return;
  const name = $('fName').value.trim();
  if (!name) { e.preventDefault(); return toast('Give the label a name', true); }
  const patch = { name, price: $('fPrice').value.trim() };
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

$('printerNickname').addEventListener('input', (e) => {
  store.updateSettings({ printerNickname: e.target.value });
  paintPrinterState();
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
  $('printBar').hidden = total === 0 || view !== 'pick';
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

// ── build check ───────────────────────────────────────────────────────────
//
// index.html and this file are separate downloads, so a browser cache can hand
// back a new page with an old script beside it. That is not an old app, it is a
// broken one — buttons wired to markup that is no longer there simply do
// nothing. Both carry the same build string, so the mismatch is detectable:
// when it happens, throw the offline copy away and reload once.

const BUILD = '2026-09-11.10';

function currentBuild() {
  return document.querySelector('meta[name="app-build"]')?.content || '';
}

/** Delete every cache and service worker, then reload from the network. */
async function reinstall() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch { /* nothing here is worth blocking the reload */ }
  // The query string is what actually defeats the browser's own HTTP cache.
  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url.toString());
}

function checkBuild() {
  // A missing stamp counts as a mismatch: it means an index.html from before
  // builds were stamped is being served next to this script.
  if (currentBuild() === BUILD) { sessionStorage.removeItem('buildFix'); return; }
  // Reload once only. If the mismatch survives a clean reinstall it is a
  // deploy problem, and looping would just hide it.
  if (sessionStorage.getItem('buildFix')) {
    toast('This app is half-updated. Close the tab and open it again.', true);
    return;
  }
  sessionStorage.setItem('buildFix', '1');
  reinstall();
}

$('btnReinstall').addEventListener('click', async () => {
  const btn = $('btnReinstall');
  btn.disabled = true;
  btn.textContent = 'Reinstalling…';
  sessionStorage.removeItem('buildFix');
  await reinstall();
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
  $('buildStamp').textContent = BUILD;
  $('printerNickname').value = store.settings.printerNickname || '';
  paintLocations();
  refreshLists();
  paintPrinterState();
  showView('print');
}

boot();
checkBuild();

// Offline support. Harmless where the browser has no service workers.
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
}

// Exposed for console poking during development.
window.app = { store, printer, queue, renderLabel, canvasToBitmap };
