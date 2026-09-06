// render.js — draw a price tag onto a canvas at printer resolution, then
// reduce it to the 1-bit-per-pixel raster the printhead wants.
//
// The T50M Pro is 8 dots/mm, so a 40 x 30 mm label is exactly 320 x 240 dots.

export const DOTS_PER_MM = 8;

/** Feed-direction columns the firmware advances blank; keep artwork out of them. */
export const FEED_MARGIN_DOTS = 8;

export function labelDots(widthMm, heightMm) {
  return { width: Math.round(widthMm * DOTS_PER_MM), height: Math.round(heightMm * DOTS_PER_MM) };
}

const FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Break `text` into lines that fit `maxWidth` at the current font.
 * Words longer than the line are hard-split rather than overflowing.
 */
function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        if (ctx.measureText(candidate).width > maxWidth && !line) {
          // single word too wide — hard split it
          let chunk = '';
          for (const ch of word) {
            if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.filter((l) => l !== '' || lines.length === 1);
}

/**
 * Largest font size (in dots) at which `text` wraps into a block fitting the box.
 * Returns { size, lines, lineHeight }.
 */
function fitText(ctx, text, box, { weight = '700', max = 64, min = 10, lineGap = 1.12, maxLines = 4 } = {}) {
  let best = { size: min, lines: [text], lineHeight: min * lineGap };
  for (let size = max; size >= min; size -= 1) {
    ctx.font = `${weight} ${size}px ${FONT_STACK}`;
    const lines = wrap(ctx, text, box.w);
    if (lines.length > maxLines) continue;
    const lineHeight = Math.round(size * lineGap);
    if (lines.length * lineHeight <= box.h) {
      best = { size, lines, lineHeight };
      break;
    }
  }
  ctx.font = `${weight} ${best.size}px ${FONT_STACK}`;
  return best;
}

function drawLines(ctx, lines, size, lineHeight, box, align = 'center') {
  ctx.textBaseline = 'top';
  ctx.textAlign = align;
  const x = align === 'center' ? box.x + box.w / 2 : box.x;
  const blockHeight = lines.length * lineHeight;
  let y = Math.round(box.y + (box.h - blockHeight) / 2);
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += lineHeight;
  }
}

/**
 * Paint one price tag. `label` is {name, price, note}; `booth` is the string
 * that goes in the banner at the top and is the only thing that differs
 * between locations.
 */
export function renderLabel(canvas, { booth, name, price, note }, opts = {}) {
  const widthMm = opts.widthMm ?? 40;
  const heightMm = opts.heightMm ?? 30;
  const { width, height } = labelDots(widthMm, heightMm);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  // The printer trims `insetDots` columns off each end of the feed direction
  // and feeds them blank instead, so nothing may be drawn there.
  const inset = opts.insetDots ?? FEED_MARGIN_DOTS;
  const top = inset;
  const bottom = height - inset;
  const usableH = bottom - top;

  const pad = Math.round(width * 0.035);
  const bannerH = Math.round(usableH * 0.24);

  // Booth banner — inverted so it reads from across the aisle.
  if (booth) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, top, width, bannerH);
    ctx.fillStyle = '#fff';
    const box = { x: pad, y: top, w: width - pad * 2, h: bannerH };
    const fit = fitText(ctx, `BOOTH ${booth}`, box, { weight: '700', max: bannerH - 6, min: 12, maxLines: 1 });
    drawLines(ctx, fit.lines, fit.size, fit.lineHeight, box);
  }

  ctx.fillStyle = '#000';

  // Price gets the most ink — it is what a customer looks for.
  const priceH = Math.round(usableH * 0.34);
  const priceBox = { x: pad, y: bottom - pad - priceH, w: width - pad * 2, h: priceH };
  if (price) {
    const fit = fitText(ctx, price, priceBox, { weight: '700', max: priceH, min: 14, maxLines: 1 });
    drawLines(ctx, fit.lines, fit.size, fit.lineHeight, priceBox);
  }

  // Item name fills whatever is left between the banner and the price.
  const nameTop = top + (booth ? bannerH : 0) + pad;
  const nameBox = { x: pad, y: nameTop, w: width - pad * 2, h: priceBox.y - nameTop - Math.round(pad / 2) };
  if (name && nameBox.h > 12) {
    const text = note ? `${name}\n${note}` : name;
    const fit = fitText(ctx, text, nameBox, { weight: '600', max: Math.round(nameBox.h), min: 10, maxLines: 3 });
    drawLines(ctx, fit.lines, fit.size, fit.lineHeight, nameBox);
  }

  return { width, height };
}

/**
 * Reduce the canvas to a row-major, MSB-first 1bpp bitmap — the format
 * `bitmap.js` expects. A set bit means "burn this dot".
 */
export function canvasToBitmap(canvas, threshold = 128) {
  const { width, height } = canvas;
  const { data } = canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height);
  const bytesPerRow = Math.ceil(width / 8);
  const out = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Composite over white, then use luminance.
      const a = data[i + 3] / 255;
      const lum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a + 255 * (1 - a);
      if (lum < threshold) {
        out[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { data: out, width, height, bytesPerRow };
}
