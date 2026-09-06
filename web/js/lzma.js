// lzma.js — LZMA1 "alone" compression for the printer, loaded on demand.
//
// The T50M Pro's firmware decodes LZMA1 with an 8 KB dictionary, lc=3, lp=0,
// pb=2. web/vendor/lzma.js is LZMA-JS with its mode-1 dictionary patched from
// 64 KB down to 8 KB so the encoder never emits a match the printer cannot
// resolve — see the note in that file.
//
// The library is ~110 KB, so it is only fetched the first time something is
// printed. Nothing else in the app pays for it.

let loading = null;

function loadLibrary() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (globalThis.LZMA) return resolve(globalThis.LZMA);
    const s = document.createElement('script');
    s.src = new URL('../vendor/lzma.js', import.meta.url).href;
    s.onload = () => (globalThis.LZMA ? resolve(globalThis.LZMA) : reject(new Error('LZMA failed to load')));
    s.onerror = () => reject(new Error('Could not load the compression library'));
    document.head.appendChild(s);
  });
  return loading;
}

/** Compression mode 1 — the patched 8 KB-dictionary profile. */
const PRINTER_MODE = 1;

/**
 * Compress `bytes` into the LZMA1-alone stream the printer expects.
 *
 * Header written by the encoder:
 *   [0]     properties = lc + lp*9 + pb*45 = 0x5D
 *   [1..5]  dictionary size, LE  (must read 8192)
 *   [5..13] uncompressed size, LE
 */
export async function compressForPrinter(bytes) {
  const LZMA = await loadLibrary();
  const signed = await new Promise((resolve, reject) => {
    LZMA.compress(bytes, PRINTER_MODE, (result, err) => (err ? reject(err) : resolve(result)));
  });

  // LZMA-JS hands back signed bytes; normalise to a Uint8Array.
  const out = new Uint8Array(signed.length);
  for (let i = 0; i < signed.length; i++) out[i] = signed[i] & 0xff;

  if (out.length < 13) throw new Error('compression produced no output');
  if (out[0] !== 0x5d) throw new Error(`unexpected LZMA properties byte 0x${out[0].toString(16)}`);

  const dict = out[1] | (out[2] << 8) | (out[3] << 16) | (out[4] << 24);
  if (dict !== 8192) {
    throw new Error(`LZMA dictionary is ${dict} bytes, printer needs 8192 — vendor/lzma.js patch is missing`);
  }

  // Declare the exact uncompressed size; the firmware relies on it rather than
  // the end-of-stream marker.
  const n = BigInt(bytes.length);
  for (let i = 0; i < 8; i++) out[5 + i] = Number((n >> BigInt(8 * i)) & 0xffn);

  return out;
}
