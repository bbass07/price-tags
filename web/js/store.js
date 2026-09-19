// store.js — the label library and locations, persisted locally.
//
// Everything is kept in localStorage and written through on every change, so a
// crash or a closed tab never loses work. This is the user's real data: the
// export/import helpers exist so it can be backed up off the device.

const KEY = 'labelprinter.v1';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function blank() {
  return {
    version: 1,
    locations: [],
    activeLocationId: null,
    labels: [],
    // Anything that is fixed for this printer lives as a constant in code, not
    // here — see DEAD_SETTINGS below for what used to be in this object and why.
    settings: { printerNickname: "Jana's Tag Printer" },
  };
}

// Settings older versions wrote and this one no longer has. Label size is not a
// setting (the stock is always 30 x 15 mm); autoFullscreen / fullscreenBroken
// belonged to the Display card, and no iOS browser can put a page fullscreen;
// density was the Darkness slider and is a constant in job.js now. Dropping
// them here keeps a stale value from coming back out of an old backup.
const DEAD_SETTINGS = ['labelWidthMm', 'labelHeightMm', 'autoFullscreen', 'fullscreenBroken', 'density'];

/** Merge saved settings over the defaults, dropping fields we no longer use. */
function cleanSettings(saved = {}) {
  const rest = { ...saved };
  for (const key of DEAD_SETTINGS) delete rest[key];
  return { ...blank().settings, ...rest };
}

/** True if `saved` carries any setting this version has dropped. */
function hasDeadSettings(saved = {}) {
  return DEAD_SETTINGS.some((key) => key in saved);
}

/**
 * Drop fields older versions wrote and this one no longer has.
 *
 * `note` was the label's optional second line; a tag is now always exactly
 * booth / name / price, so the field is removed from the saved record rather
 * than left behind as dead weight in every export.
 *
 * Returns true if anything was actually removed, so the caller can write the
 * cleaned library back to disk instead of waiting for the next edit.
 */
function cleanLabels(labels = []) {
  let changed = false;
  for (const label of labels) {
    if ('note' in label) { delete label.note; changed = true; }
  }
  return changed;
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.data = this.load();
    // Write the migration through immediately — a library that is only read,
    // never edited, should still end up clean in the next export.
    if (this.migrated) this.save();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const parsed = JSON.parse(raw);
      const data = { ...blank(), ...parsed, settings: cleanSettings(parsed.settings) };
      this.migrated = cleanLabels(data.labels) || hasDeadSettings(parsed.settings);
      return data;
    } catch {
      return blank();
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'Could not save — device storage is full.' }));
    }
    this.dispatchEvent(new Event('change'));
  }

  // ---- locations ---------------------------------------------------------

  get locations() { return this.data.locations; }

  get activeLocation() {
    return this.data.locations.find((l) => l.id === this.data.activeLocationId) || this.data.locations[0] || null;
  }

  setActiveLocation(id) {
    this.data.activeLocationId = id;
    this.save();
  }

  /**
   * A location with a blank `booth` prints a two-line tag — name and price
   * only. That is the farmers' market, where no booth number exists to print.
   */
  addLocation({ name, booth }) {
    const loc = { id: uid(), name: name.trim(), booth: String(booth ?? '').trim() };
    this.data.locations.push(loc);
    if (!this.data.activeLocationId) this.data.activeLocationId = loc.id;
    this.save();
    return loc;
  }

  updateLocation(id, patch) {
    const loc = this.data.locations.find((l) => l.id === id);
    if (!loc) return;
    Object.assign(loc, patch);
    this.save();
  }

  removeLocation(id) {
    this.data.locations = this.data.locations.filter((l) => l.id !== id);
    if (this.data.activeLocationId === id) {
      this.data.activeLocationId = this.data.locations[0]?.id || null;
    }
    this.save();
  }

  // ---- labels ------------------------------------------------------------

  get labels() { return this.data.labels; }

  addLabel({ name, price }) {
    const label = { id: uid(), name: name.trim(), price: String(price).trim(), updatedAt: Date.now() };
    this.data.labels.unshift(label);
    this.save();
    return label;
  }

  updateLabel(id, patch) {
    const label = this.data.labels.find((l) => l.id === id);
    if (!label) return;
    Object.assign(label, patch, { updatedAt: Date.now() });
    this.save();
  }

  removeLabel(id) {
    this.data.labels = this.data.labels.filter((l) => l.id !== id);
    this.save();
  }

  /**
   * Add a location once per device, the way `seedLabels` adds labels: named by
   * `id`, never added twice, and skipped entirely if a location of that name
   * already exists, so a removed one stays removed.
   */
  seedLocation(id, { name, booth = '' }) {
    if (this.data.seededLocations?.includes(id)) return false;
    this.data.seededLocations = [...(this.data.seededLocations || []), id];
    const taken = this.data.locations.some((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!taken) this.data.locations.push({ id: uid(), name: name.trim(), booth: String(booth).trim() });
    if (!this.data.activeLocationId) this.data.activeLocationId = this.data.locations[0]?.id || null;
    this.save();
    return !taken;
  }

  /**
   * Load a prepared label list once per device. `id` names the list; once it
   * has been loaded it is never loaded again, so edits made afterwards stick.
   * A library with at most one label (the owner's test tag) is replaced; a
   * bigger one is real work and only gains the names it does not have yet.
   */
  seedLabels(id, labels) {
    // Seeded once ever, not once per list: a device that already has a library
    // gets later changes through `reviseLabels`, which renames what is there
    // instead of pouring a second copy of the catalogue over the top.
    if (this.data.seededCatalog) return false;
    const now = Date.now();
    const fresh = labels.map((l) => ({ id: uid(), name: l.name, price: l.price, updatedAt: now }));
    if (this.data.labels.length <= 1) {
      this.data.labels = fresh;
    } else {
      const have = new Set(this.data.labels.map((l) => l.name.trim().toLowerCase()));
      this.data.labels.push(...fresh.filter((l) => !have.has(l.name.toLowerCase())));
    }
    this.data.seededCatalog = id;
    this.save();
    return true;
  }

  /**
   * Change labels the catalogue already put here: `renames` is old name -> new
   * name, `removes` is a list of names to drop, `adds` is labels to append if
   * that name is not in the library already. Matching is by exact name, so
   * anything the owner has renamed or re-priced by hand is left alone. Applied
   * once per `id`.
   */
  reviseLabels(id, { renames = {}, removes = [], adds = [] }) {
    if (this.data.revisions?.includes(id)) return null;
    const gone = new Set(removes);
    const before = this.data.labels.length;
    this.data.labels = this.data.labels.filter((l) => !gone.has(l.name));
    let renamed = 0;
    for (const label of this.data.labels) {
      const to = renames[label.name];
      // Never rename onto a name that is already in the library — that would
      // leave two rows reading the same thing.
      if (!to || this.data.labels.some((l) => l !== label && l.name === to)) continue;
      label.name = to;
      renamed += 1;
    }
    const have = new Set(this.data.labels.map((l) => l.name));
    const fresh = adds.filter((l) => !have.has(l.name));
    const now = Date.now();
    this.data.labels.push(...fresh.map((l) => ({ id: uid(), name: l.name, price: l.price, updatedAt: now })));
    this.data.revisions = [...(this.data.revisions || []), id];
    this.save();
    return { removed: before - (this.data.labels.length - fresh.length), renamed, added: fresh.length };
  }

  /**
   * Add any of `labels` whose name is not here already, leaving everything
   * else alone. The repair for a phone that missed an update: it can only add,
   * so a hand-edited price or name is never touched.
   */
  addMissingLabels(labels) {
    const have = new Set(this.data.labels.map((l) => l.name.trim().toLowerCase()));
    const missing = labels.filter((l) => !have.has(l.name.trim().toLowerCase()));
    const now = Date.now();
    this.data.labels.push(...missing.map((l) => ({ id: uid(), name: l.name, price: l.price, updatedAt: now })));
    if (missing.length) this.save();
    return missing.map((l) => l.name);
  }

  /** Case-insensitive search across name and price. */
  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.data.labels;
    return this.data.labels.filter((l) =>
      `${l.name} ${l.price}`.toLowerCase().includes(q));
  }

  // ---- settings ----------------------------------------------------------

  get settings() { return this.data.settings; }

  updateSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
  }

  // ---- backup ------------------------------------------------------------

  exportJSON() {
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * Merge a backup into the current library.
   * `mode` is 'replace' to overwrite everything, or 'merge' to add anything
   * whose id is not already present.
   */
  importJSON(text, mode = 'replace') {
    const incoming = JSON.parse(text);
    if (!incoming || !Array.isArray(incoming.labels)) throw new Error('That file is not a label backup.');
    if (mode === 'replace') {
      this.data = { ...blank(), ...incoming, settings: cleanSettings(incoming.settings) };
      cleanLabels(this.data.labels);
    } else {
      const haveLabels = new Set(this.data.labels.map((l) => l.id));
      const haveLocs = new Set(this.data.locations.map((l) => l.id));
      for (const l of incoming.labels) if (!haveLabels.has(l.id)) this.data.labels.push(l);
      cleanLabels(this.data.labels);
      for (const l of incoming.locations || []) if (!haveLocs.has(l.id)) this.data.locations.push(l);
    }
    if (!this.data.activeLocationId) this.data.activeLocationId = this.data.locations[0]?.id || null;
    this.save();
  }
}

/** "12.5" -> "$12.50"; anything non-numeric is left exactly as typed. */
export function formatPrice(price) {
  const s = String(price).trim();
  if (!s) return '';
  const numeric = s.replace(/[$,\s]/g, '');
  if (/^\d+(\.\d{1,2})?$/.test(numeric)) {
    return '$' + Number(numeric).toFixed(2);
  }
  return s;
}
