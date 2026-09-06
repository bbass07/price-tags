// bitmap.js — turn a 1bpp label bitmap into the printer's buffer format.
// Ported from reference/supvan-cups/crates/supvan-proto/src/{bitmap,buffer}.rs

export const DOTS_PER_MM = 8;
export const PRINTHEAD_WIDTH_MM = 48;
export const PRINTHEAD_WIDTH_DOTS = PRINTHEAD_WIDTH_MM * DOTS_PER_MM; // 384
export const PRINT_BUF_SIZE = 4096;
export const PRINT_BUF_HEADER = 14;
export const MAX_BUF_DATA = 4074;
export const DEFAULT_MARGIN_DOTS = 8;
const CHECKSUM_STRIDE = 256;
const MARGIN_MAX_DOTS = 900;
const MAX_DENSITY = 15;

/**
 * Rotate a row-major MSB-first bitmap -90° into the printer's column-major
 * LSB-first layout, centred across the full printhead in one pass.
 *
 * The head is also mirrored: a dot on the LEFT of the image must be placed at
 * the HIGHEST dot index of the printhead line, or everything prints backwards.
 * The reference driver does this inside its dither stage
 * (`dither.rs::Ditherer::line`, `mx = width - 1 - x`), which is easy to miss
 * because it looks like part of the halftoning rather than part of the
 * geometry. It isn't — it applies whatever way the raster was produced.
 *
 * Each output "column" is one printhead line, `bytesPerLine` bytes wide.
 * Returns { data, cols, bytesPerLine }.
 */
export function toPrintheadCanvas(bitmap, canvasWidthDots = PRINTHEAD_WIDTH_DOTS) {
  const { data: src, width, height, bytesPerRow } = bitmap;
  const bytesPerLine = canvasWidthDots >> 3;
  const usableDots = bytesPerLine * 8;
  const out = new Uint8Array(height * bytesPerLine);

  // A page wider than the head is cropped symmetrically, not squeezed.
  const offset = Math.floor((usableDots - width) / 2);

  for (let y = 0; y < height; y++) {
    const rowBase = y * bytesPerRow;
    const colBase = y * bytesPerLine;
    for (let x = 0; x < width; x++) {
      const dot = (width - 1 - x) + offset;
      if (dot < 0 || dot >= usableDots) continue;
      if (src[rowBase + (x >> 3)] & (0x80 >> (x & 7))) {
        out[colBase + (dot >> 3)] |= 1 << (dot & 7);
      }
    }
  }
  return { data: out, cols: height, bytesPerLine };
}

/**
 * PAGE_REG_BITS — two bytes of per-buffer flags.
 *   byte 0: bit1 pageStart, bit2 pageEnd, bit3 printEnd, bits4-6 cut, bit7 savePaper
 *   byte 1: bits0-1 firstCut, bits2-5 density, bits6-7 material
 */
function pageRegBits({ pageStart, pageEnd, printEnd, density, mat = 1 }) {
  let b0 = 0;
  if (pageStart) b0 |= 0x02;
  if (pageEnd) b0 |= 0x04;
  if (printEnd) b0 |= 0x08;
  b0 &= 0x0f;
  const b1 = ((density & 0x0f) << 2) | ((mat & 0x03) << 6);
  return [b0, b1];
}

/**
 * Build one 4096-byte print buffer.
 *   [0..2]   checksum LE
 *   [2..4]   PAGE_REG_BITS
 *   [4..6]   column count LE
 *   [6]      bytes per line
 *   [8..10]  top margin LE (dots)
 *   [10..12] bottom margin LE (dots)
 *   [12]     red trim
 *   [14..]   image data
 */
function buildPrintBuffer({ imageData, bytesPerLine, colsInBuf, pageStart, pageEnd, printEnd, marginTop, marginBottom, density }) {
  const buf = new Uint8Array(PRINT_BUF_SIZE);
  const bits = pageRegBits({ pageStart, pageEnd, printEnd, density: density.black });
  buf[2] = bits[0];
  buf[3] = bits[1];
  buf[4] = colsInBuf & 0xff;
  buf[5] = (colsInBuf >> 8) & 0xff;
  buf[6] = bytesPerLine;

  const mt = Math.min(Math.max(marginTop, 1), MARGIN_MAX_DOTS);
  const mb = Math.min(Math.max(marginBottom, 1), MARGIN_MAX_DOTS);
  buf[8] = mt & 0xff; buf[9] = (mt >> 8) & 0xff;
  buf[10] = mb & 0xff; buf[11] = (mb >> 8) & 0xff;
  buf[12] = Math.min(density.red, MAX_DENSITY);

  const len = Math.min(imageData.length, PRINT_BUF_SIZE - PRINT_BUF_HEADER);
  buf.set(imageData.subarray(0, len), PRINT_BUF_HEADER);

  // Checksum: sum of the header fields, plus the byte before every 256-byte
  // boundary inside the used region — the firmware re-reads it as it streams.
  let chk = 0;
  for (let i = 2; i < 14; i++) chk += buf[i];
  const dataEnd = colsInBuf * bytesPerLine + PRINT_BUF_HEADER;
  const strides = Math.floor(dataEnd / CHECKSUM_STRIDE);
  for (let i = 1; i <= strides; i++) {
    const idx = i * CHECKSUM_STRIDE - 1;
    if (idx < buf.length) chk += buf[idx];
  }
  chk &= 0xffff;
  buf[0] = chk & 0xff;
  buf[1] = (chk >> 8) & 0xff;
  return buf;
}

/**
 * Tile a printhead canvas into print buffers along the feed direction.
 * `marginTop`/`marginBottom` columns are trimmed from the image and declared
 * to the firmware as blank feed instead.
 */
export function splitIntoBuffers(canvas, { marginTop = DEFAULT_MARGIN_DOTS, marginBottom = DEFAULT_MARGIN_DOTS, density = { black: 4, red: 4 } } = {}) {
  const { data, cols: totalCols, bytesPerLine } = canvas;
  const printableCols = Math.max(0, totalCols - marginTop - marginBottom);
  const maxCols = Math.floor(MAX_BUF_DATA / bytesPerLine);

  const chunks = [];
  for (let start = 0; start < printableCols; start += maxCols) {
    chunks.push({ start, count: Math.min(maxCols, printableCols - start) });
  }
  if (chunks.length === 0) chunks.push({ start: 0, count: 0 });

  const last = chunks.length - 1;
  return chunks.map((c, i) => {
    const from = (marginTop + c.start) * bytesPerLine;
    const to = Math.min(from + c.count * bytesPerLine, data.length);
    return buildPrintBuffer({
      imageData: data.subarray(from, to),
      bytesPerLine,
      colsInBuf: c.count,
      pageStart: i === 0,
      pageEnd: i === last,
      printEnd: i === last,
      marginTop,
      marginBottom,
      density,
    });
  });
}

/** Print speed from the average compressed bytes per buffer (T50PlusPrint). */
export function calcSpeed(avgCompressed) {
  if (avgCompressed > 3000) return 10;
  if (avgCompressed > 2800) return 15;
  if (avgCompressed > 2500) return 20;
  if (avgCompressed > 2000) return 25;
  if (avgCompressed > 1500) return 40;
  if (avgCompressed > 1000) return 45;
  if (avgCompressed > 500) return 55;
  return 60;
}

// ── bulk transfer framing ──────────────────────────────────────────────────

export const DATA_PAYLOAD_SIZE = 500;
const DATA_MAGIC1 = 0xaa, DATA_MAGIC2 = 0xbb;
const DATA_FRAME_PAYLOAD_LEN = 508;

/** Wrap compressed bytes into the 512-byte transfer frames the printer reads. */
export function buildDataFrames(compressed) {
  const total = Math.ceil(compressed.length / DATA_PAYLOAD_SIZE);
  const frames = [];
  for (let i = 0; i < total; i++) {
    const chunk = compressed.subarray(i * DATA_PAYLOAD_SIZE, Math.min((i + 1) * DATA_PAYLOAD_SIZE, compressed.length));

    // 506-byte packet: AA BB, checksum, index, count, 500 bytes of payload.
    const pkt = new Uint8Array(506);
    pkt[0] = DATA_MAGIC1;
    pkt[1] = DATA_MAGIC2;
    pkt[4] = i & 0xff;
    pkt[5] = total & 0xff;
    pkt.set(chunk, 6);
    let chk = 0;
    for (let j = 4; j < 506; j++) chk += pkt[j];
    chk &= 0xffff;
    pkt[2] = chk & 0xff;
    pkt[3] = (chk >> 8) & 0xff;

    // 512-byte frame: 7E 5A <508> 10 02 <packet>
    const frame = new Uint8Array(512);
    frame[0] = 0x7e;
    frame[1] = 0x5a;
    frame[2] = DATA_FRAME_PAYLOAD_LEN & 0xff;
    frame[3] = (DATA_FRAME_PAYLOAD_LEN >> 8) & 0xff;
    frame[4] = 0x10;
    frame[5] = 0x02;
    frame.set(pkt, 6);
    frames.push(frame);
  }
  return frames;
}
