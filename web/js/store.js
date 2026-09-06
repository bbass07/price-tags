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
    settings: { labelWidthMm: 40, labelHeightMm: 30, density: 6, printerNickname: "Jana's Tag Printer", autoFullscreen: true },
  };
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.data = this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const parsed = JSON.parse(raw);
      return { ...blank(), ...parsed, settings: { ...blank().settings, ...(parsed.settings || {}) } };
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

  addLocation({ name, booth }) {
    const loc = { id: uid(), name: name.trim(), booth: String(booth).trim() };
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

  addLabel({ name, price, note = '' }) {
    const label = { id: uid(), name: name.trim(), price: String(price).trim(), note: note.trim(), updatedAt: Date.now() };
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

  /** Case-insensitive search across name, price and note. */
  search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return this.data.labels;
    return this.data.labels.filter((l) =>
      `${l.name} ${l.price} ${l.note}`.toLowerCase().includes(q));
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
      this.data = { ...blank(), ...incoming, settings: { ...blank().settings, ...(incoming.settings || {}) } };
    } else {
      const haveLabels = new Set(this.data.labels.map((l) => l.id));
      const haveLocs = new Set(this.data.locations.map((l) => l.id));
      for (const l of incoming.labels) if (!haveLabels.has(l.id)) this.data.labels.push(l);
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
