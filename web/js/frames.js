// frames.js — Supvan/Katasymbol T-series command framing.
// Ported from reference/supvan-cups/crates/supvan-proto/src/{cmd,status}.rs
// This is the Bluetooth (SPP-style) framing; BLE reuses it verbatim.

export const MAGIC1 = 0x7e;
export const MAGIC2 = 0x5a;
export const PROTO_ID = 0x10;
export const PROTO_VER = 0x01;
export const MARKER_AA = 0xaa;
const CMD_PAYLOAD_LEN = 0x0c;

export const CMD = {
  BUF_FULL: 0x10,
  INQUIRY_STA: 0x11,
  CHECK_DEVICE: 0x12,
  START_PRINT: 0x13,
  STOP_PRINT: 0x14,
  RD_DEV_NAME: 0x16,
  READ_REV: 0x17,
  PAPER_SKIP: 0x2e,
  RETURN_MAT: 0x30,
  NEXT_ZIPPEDBULK: 0x5c,
  READ_FWVER: 0xc5,
};

/** Build a 16-byte start-transfer command frame. */
export function makeCmdStartTrans(cmd, blockSize = 0, blockCount = 0) {
  const pkt = new Uint8Array(16);
  pkt[0] = MAGIC1;
  pkt[1] = MAGIC2;
  pkt[2] = CMD_PAYLOAD_LEN;
  pkt[4] = PROTO_ID;
  pkt[5] = PROTO_VER;
  pkt[6] = MARKER_AA;
  pkt[7] = cmd;
  pkt[11] = 0x01;
  pkt[12] = blockSize & 0xff;
  pkt[13] = (blockSize >> 8) & 0xff;
  pkt[14] = blockCount & 0xff;
  pkt[15] = (blockCount >> 8) & 0xff;
  // checksum: little-endian sum of bytes [10..16)
  let chk = 0;
  for (let i = 10; i < 16; i++) chk += pkt[i];
  chk &= 0xffff;
  pkt[8] = chk & 0xff;
  pkt[9] = (chk >> 8) & 0xff;
  return pkt;
}

/** A plain command is a start-transfer frame carrying only a parameter. */
export function makeCmd(cmd, param = 0) {
  return makeCmdStartTrans(cmd, param, 0);
}

/**
 * Validate a response frame and return its payload view.
 * Response header: 7E 5A len_lo len_hi 10 03 55 CMD chk_lo chk_hi ...
 */
export function validateResponse(data, expectedCmd) {
  if (data.length < 8) throw new Error(`short response (${data.length} bytes)`);
  if (data[0] !== MAGIC1 || data[1] !== MAGIC2) throw new Error('bad response magic');
  if (data[4] !== PROTO_ID) throw new Error('bad protocol id');
  if (expectedCmd != null && data[7] !== expectedCmd) {
    throw new Error(`response for 0x${data[7].toString(16)}, expected 0x${expectedCmd.toString(16)}`);
  }
  return data;
}

/** Does this notification frame acknowledge `cmd`? (command byte at offset 7) */
export function isAckFor(data, cmd) {
  return data.length >= 8 && data[0] === MAGIC1 && data[1] === MAGIC2 && data[7] === cmd;
}

/**
 * Decode the printer status registers.
 * On Bluetooth these live at frame offsets 14..20 (MSTA lo/hi, FSTA lo/hi).
 */
export function parseStatus(frame) {
  if (frame.length < 18) return null;
  const mstaLo = frame[14], mstaHi = frame[15], fstaLo = frame[16];
  return {
    bufFull:        !!(mstaLo & 0x01),
    labelRwError:   !!(mstaLo & 0x02),
    labelEnd:       !!(mstaLo & 0x04),
    labelModeError: !!(mstaLo & 0x08),
    ribbonRwError:  !!(mstaLo & 0x10),
    ribbonEnd:      !!(mstaLo & 0x20),
    lowBattery:     !!(mstaLo & 0x40),
    deviceBusy:     !!(mstaHi & 0x04),
    headTempHigh:   !!(mstaHi & 0x08),
    coverOpen:      !!(fstaLo & 0x08),
    insertUsb:      !!(fstaLo & 0x10),
    printing:       !!(fstaLo & 0x40),
    raw: [mstaLo, mstaHi, fstaLo, frame[17]],
  };
}

/** Human-readable list of anything wrong, empty when the printer is happy. */
export function statusProblems(s) {
  if (!s) return ['no status'];
  const out = [];
  if (s.coverOpen) out.push('cover is open');
  if (s.labelEnd) out.push('out of labels');
  if (s.labelRwError) out.push('cannot read the label roll tag');
  if (s.labelModeError) out.push('wrong label type loaded');
  if (s.ribbonEnd) out.push('ribbon finished');
  if (s.lowBattery) out.push('battery low');
  if (s.headTempHigh) out.push('printhead too hot — let it cool');
  return out;
}

/** ASCII string payload starting at `offset`, stopping at NUL or non-printables. */
export function readAscii(frame, offset, max = 32) {
  let s = '';
  for (let i = offset; i < Math.min(frame.length, offset + max); i++) {
    const c = frame[i];
    if (c === 0 || c < 0x20 || c > 0x7e) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
