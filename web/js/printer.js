// printer.js — high-level printer operations built on the BLE link.

import { PrinterLink } from './ble.js';
import { CMD, parseStatus, statusProblems, readAscii } from './frames.js';

export class Printer extends EventTarget {
  constructor() {
    super();
    this.link = new PrinterLink();
    this.link.addEventListener('connected', () => this.dispatchEvent(new Event('connected')));
    this.link.addEventListener('disconnected', () => this.dispatchEvent(new Event('disconnected')));
    this.link.addEventListener('log', (e) => this.log(e.detail));
    this.info = null;
  }

  get connected() { return this.link.connected; }
  get name() { return (this.link.device && this.link.device.name) || null; }

  log(msg) { this.dispatchEvent(new CustomEvent('log', { detail: String(msg) })); }

  async connect(opts) {
    const name = await this.link.connect(opts);
    this.log(`paired with ${name}`);
    return name;
  }

  disconnect() { return this.link.disconnect(); }

  /** Liveness check. Throws if the printer does not answer. */
  async checkDevice() {
    await this.link.command(CMD.CHECK_DEVICE, 0);
    return true;
  }

  /** Current status registers, decoded. */
  async status() {
    const frame = await this.link.command(CMD.INQUIRY_STA, 0);
    const s = parseStatus(frame);
    if (s) s.problems = statusProblems(s);
    return s;
  }

  /** Printer's own name string (Bluetooth transport carries it at offset 22). */
  async deviceName() {
    try {
      const frame = await this.link.command(CMD.RD_DEV_NAME, 0);
      return readAscii(frame, 22) || null;
    } catch { return null; }
  }

  async firmwareVersion() {
    try {
      const frame = await this.link.command(CMD.READ_FWVER, 0);
      return readAscii(frame, 22) || null;
    } catch { return null; }
  }

  /**
   * Loaded label roll info. The response carries the material record;
   * we surface the label size, which tells us what we are allowed to print.
   */
  async material() {
    const frame = await this.link.command(CMD.RETURN_MAT, 0, { timeout: 6000 });
    return {
      raw: frame,
      serial: readAscii(frame, 40, 20) || null,
      length: frame.length,
    };
  }

  /** Everything worth showing on a diagnostics screen, gathered in one go. */
  async identify() {
    await this.checkDevice();
    const status = await this.status();
    const name = await this.deviceName();
    const firmware = await this.firmwareVersion();
    this.info = { name: name || this.name, firmware, status };
    return this.info;
  }
}
