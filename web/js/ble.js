// ble.js — Web Bluetooth transport for the Supvan/Katasymbol T50M Pro.
//
// Works in Chrome/Edge on desktop and Android, and in the BLE Link browser on
// iOS. It does NOT work in Safari — Apple does not implement Web Bluetooth.

import { makeCmd, makeCmdStartTrans, isAckFor, MAGIC1, MAGIC2 } from './frames.js';

export const SERVICE_UUID = '0000e0ff-3c17-d293-8e48-14fe2e4da212';
export const CHAR_NOTIFY = '0000ffe1-0000-1000-8000-00805f9b34fb';
export const CHAR_WRITE  = '0000ffe9-0000-1000-8000-00805f9b34fb';
export const CHAR_NOTIFY2 = '0000ffea-0000-1000-8000-00805f9b34fb';

// The vendor app writes in 128-byte ATT fragments with a short gap between them.
const FRAGMENT = 128;
const FRAGMENT_GAP_MS = 10;
const DATA_FRAME = 512;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class PrinterLink extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.writeChar = null;
    this.rx = new Uint8Array(0);       // notification reassembly buffer
    this.waiters = [];                 // [{cmd, resolve, reject, timer}]
  }

  get connected() {
    return !!(this.device && this.device.gatt && this.device.gatt.connected);
  }

  log(msg) {
    this.dispatchEvent(new CustomEvent('log', { detail: msg }));
  }

  /** Show the browser's device picker and connect. Must be called from a click. */
  async connect({ showAll = false } = {}) {
    if (!isSupported()) {
      throw new Error(
        'This browser has no Bluetooth support. On iPhone, open this page in the BLE Link app.'
      );
    }
    // Catches the most common cause of a silent failure: the radio is simply
    // switched off. Not every browser implements this, so a throw here is not
    // itself a reason to stop.
    try {
      if ((await navigator.bluetooth.getAvailability()) === false) {
        const e = new Error('Bluetooth is switched off on this device. Turn it on in Settings and try again.');
        e.name = 'BluetoothOffError';
        throw e;
      }
    } catch (e) {
      if (e.name === 'BluetoothOffError') throw e;
    }
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : {
          // The printer advertises no service UUIDs, so we match on its name.
          filters: [{ namePrefix: 'T0' }, { namePrefix: 'T5' }, { namePrefix: 'G1' }],
          optionalServices: [SERVICE_UUID],
        };

    this.device = await navigator.bluetooth.requestDevice(options);
    this.device.addEventListener('gattserverdisconnected', () => {
      this.writeChar = null;
      this.failAllWaiters(new Error('printer disconnected'));
      this.dispatchEvent(new Event('disconnected'));
    });
    await this.openGatt();
    return this.device.name || 'printer';
  }

  async openGatt() {
    this.log('connecting…');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.writeChar = await service.getCharacteristic(CHAR_WRITE);

    const onNotify = (e) => this.onData(new Uint8Array(e.target.value.buffer));
    for (const uuid of [CHAR_NOTIFY, CHAR_NOTIFY2]) {
      try {
        const ch = await service.getCharacteristic(uuid);
        await ch.startNotifications();
        ch.addEventListener('characteristicvaluechanged', onNotify);
      } catch {
        /* FFEA is optional on some units */
      }
    }
    this.log('connected');
    this.dispatchEvent(new Event('connected'));
  }

  async disconnect() {
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
  }

  // ---- receive -----------------------------------------------------------

  onData(chunk) {
    const merged = new Uint8Array(this.rx.length + chunk.length);
    merged.set(this.rx);
    merged.set(chunk, this.rx.length);
    this.rx = merged;
    this.drainFrames();
  }

  /** Pull complete `7E 5A <len16> …` frames out of the receive buffer. */
  drainFrames() {
    for (;;) {
      // resynchronise on the magic bytes if noise got in
      let start = 0;
      while (start + 1 < this.rx.length && !(this.rx[start] === MAGIC1 && this.rx[start + 1] === MAGIC2)) start++;
      if (start > 0) this.rx = this.rx.slice(start);
      if (this.rx.length < 4) return;

      const payloadLen = this.rx[2] | (this.rx[3] << 8);
      const total = 4 + payloadLen;
      if (total < 8 || total > 4096) { this.rx = this.rx.slice(2); continue; }
      if (this.rx.length < total) return;

      const frame = this.rx.slice(0, total);
      this.rx = this.rx.slice(total);
      this.deliver(frame);
    }
  }

  deliver(frame) {
    const i = this.waiters.findIndex((w) => isAckFor(frame, w.cmd));
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(frame);
    } else {
      this.dispatchEvent(new CustomEvent('unsolicited', { detail: frame }));
    }
  }

  failAllWaiters(err) {
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  waitFor(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { cmd, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`printer did not answer command 0x${cmd.toString(16)}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  // ---- transmit ----------------------------------------------------------

  /** Write raw bytes as 128-byte ATT fragments, pacing between them. */
  async writeRaw(bytes) {
    if (!this.writeChar) throw new Error('not connected to the printer');
    for (let off = 0; off < bytes.length; off += FRAGMENT) {
      const part = bytes.slice(off, off + FRAGMENT);
      await this.writeChar.writeValueWithResponse(part);
      if (off + FRAGMENT < bytes.length) await sleep(FRAGMENT_GAP_MS);
    }
  }

  /** Send a command and wait for the printer to echo it back. */
  async command(cmd, param = 0, { timeout = 4000 } = {}) {
    const pending = this.waitFor(cmd, timeout);
    await this.writeRaw(makeCmd(cmd, param));
    return pending;
  }

  /** Send a start-transfer command (block size + count) and wait for the ack. */
  async commandStartTrans(cmd, blockSize, blockCount, { timeout = 4000 } = {}) {
    const pending = this.waitFor(cmd, timeout);
    await this.writeRaw(makeCmdStartTrans(cmd, blockSize, blockCount));
    return pending;
  }

}
