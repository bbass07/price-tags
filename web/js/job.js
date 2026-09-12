// job.js — the print pipeline: label → raster → print buffers → LZMA → printer.
//
// Mirrors reference/supvan-cups: KsJob::transfer_page for the raster side and
// Printer::print_compressed for the command ordering.

import { renderLabel, canvasToBitmap } from './render.js';
import { toPrintheadCanvas, splitIntoBuffers, buildDataFrames, calcSpeed, PRINT_BUF_SIZE } from './bitmap.js';
import { compressForPrinter } from './lzma.js';
import { CMD, parseStatus, statusProblems } from './frames.js';

const SPP_BLOCK_SIZE = 512;

// Darkness, 1-15. Fixed at 8: it was a Setup slider, but 8 prints cleanly on
// the 30 x 15 mm stock and nobody ever needed to move it, so the setting went.
const DENSITY = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll INQUIRY_STA until `test` passes, or give up. */
async function pollStatus(link, test, { attempts, interval, what }) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const frame = await link.command(CMD.INQUIRY_STA, 0);
    last = parseStatus(frame);
    if (last) {
      const problems = statusProblems(last);
      if (problems.length) throw new Error(`Printer: ${problems.join(', ')}`);
      if (test(last)) return last;
    }
    await sleep(interval);
  }
  throw new Error(`Printer never became ${what}.`);
}

/** Turn one label into the compressed byte stream the printer wants. */
export async function rasterise(label, { booth }) {
  const canvas = document.createElement('canvas');
  renderLabel(canvas, {
    booth,
    name: label.name,
    price: label.priceText,
  });

  const bitmap = canvasToBitmap(canvas);
  const head = toPrintheadCanvas(bitmap);
  const density = { black: DENSITY, red: DENSITY };
  const buffers = splitIntoBuffers(head, { density });

  // One LZMA stream over every buffer, exactly as the vendor sends it.
  const concat = new Uint8Array(buffers.length * PRINT_BUF_SIZE);
  buffers.forEach((b, i) => concat.set(b, i * PRINT_BUF_SIZE));
  const compressed = await compressForPrinter(concat);

  return { compressed, speed: calcSpeed(Math.floor(compressed.length / buffers.length)) };
}

/** Send one already-compressed page and wait for the paper to stop moving. */
async function printPage(printer, compressed, speed, log) {
  const link = printer.link;

  await printer.checkDevice();
  await pollStatus(link, (s) => !s.deviceBusy && !s.printing, { attempts: 60, interval: 100, what: 'ready' });

  log(`START_PRINT (${compressed.length} bytes, speed ${speed})`);
  await link.command(CMD.START_PRINT, 0);
  await pollStatus(link, (s) => s.printing, { attempts: 60, interval: 100, what: 'active' });
  await pollStatus(link, (s) => !s.bufFull, { attempts: 200, interval: 20, what: 'ready for data' });

  const frames = buildDataFrames(compressed);
  await link.commandStartTrans(CMD.NEXT_ZIPPEDBULK, SPP_BLOCK_SIZE, frames.length);
  for (const frame of frames) await link.writeRaw(frame);
  await sleep(20);

  // BUF_FULL closes the transfer: length in the block-size field, speed in the
  // block-count field. A missing ack here is not fatal — the completion poll
  // below is the real answer.
  try {
    await link.commandStartTrans(CMD.BUF_FULL, compressed.length, speed, { timeout: 3000 });
  } catch (e) {
    log(`BUF_FULL not acked (${e.message}) — waiting for the print to finish anyway`);
  }

  for (let i = 0; i < 300; i++) {
    await sleep(100);
    const s = parseStatus(await link.command(CMD.INQUIRY_STA, 0));
    if (s && !s.printing && !s.deviceBusy) return;
  }
  throw new Error('The printer did not report finishing.');
}

/**
 * Print a queue of labels.
 * `jobs` is [{ label, qty }]; every label gets `booth` stamped at the top.
 */
export async function printLabels(printer, jobs, { booth, onProgress, log = () => {} }) {
  const total = jobs.reduce((n, j) => n + j.qty, 0);
  let done = 0;

  for (const { label, qty } of jobs) {
    log(`rasterising "${label.name}"`);
    const { compressed, speed } = await rasterise(
      { name: label.name, priceText: label.priceDisplay ?? label.price },
      { booth }
    );
    for (let copy = 0; copy < qty; copy++) {
      await printPage(printer, compressed, speed, log);
      done += 1;
      if (onProgress) onProgress(done, total);
      if (done < total) await sleep(250);   // let the mechanism settle between labels
    }
  }
  log(`printed ${done} label${done === 1 ? '' : 's'}`);
}
