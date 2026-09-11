// render.js — draw a price tag onto a canvas at printer resolution, then
// reduce it to the 1-bit-per-pixel raster the printhead wants.
//
// The T50M Pro is 8 dots/mm, so the 30 x 15 mm label is exactly 240 x 120 dots.
//
// This is the only stock the owner uses, so the size is a constant rather than
// a setting — one less thing to get wrong at a booth.

export const DOTS_PER_MM = 8;

export const LABEL_WIDTH_MM = 30;
export const LABEL_HEIGHT_MM = 15;

/** Feed-direction columns the firmware advances blank; keep artwork out of them. */
export const FEED_MARGIN_DOTS = 8;

export function labelDots(widthMm = LABEL_WIDTH_MM, heightMm = LABEL_HEIGHT_MM) {
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
 * Where the three lines of a tag sit, in printer dots.
 *
 * Every tag is booth / item name / price, in that order, always — three plain
 * black lines of equal height, so the tag never changes shape on you. The
 * booth line keeps its strip of height whether or not there is a booth to put
 * in it.
 *
 * The geometry is worked out once here and used twice: `renderLabel` paints
 * from it, and the editor sizes its on-screen form from it so what you type is
 * laid out exactly where it will print.
 *
 * `ctx` is any 2D context; it is only measured against, never drawn to.
 */
export function labelLayout(ctx, { booth = '', name = '', price = '' } = {}, opts = {}) {
  const { width, height } = labelDots();

  // The printer trims `insetDots` columns off each end of the feed direction
  // and feeds them blank instead, so nothing may be drawn there.
  const inset = opts.insetDots ?? FEED_MARGIN_DOTS;
  const top = inset;
  const bottom = height - inset;
  const usableH = bottom - top;

  // On a 15 mm tall label there is barely 13 mm of printable feed once the
  // blank margins are taken out, so the padding is tight and every line is
  // measured off `usableH` rather than the full height.
  const pad = Math.max(4, Math.round(width * 0.03));
  const gap = Math.round(pad / 2);

  // Three identical rows. Short text fills its row, so in practice all three
  // lines come out the same size; only a long name shrinks to fit its width.
  const rowH = Math.floor((usableH - gap * 2) / 3);
  const rowW = width - pad * 2;
  const row = (i) => ({ x: pad, y: top + i * (rowH + gap), w: rowW, h: rowH });

  const boothBlock = {
    box: row(0),
    weight: '700',
    text: booth ? `BOOTH ${booth}` : '',
  };
  boothBlock.fit = fitText(ctx, boothBlock.text, boothBlock.box, {
    weight: '700', max: rowH, min: 9, maxLines: 1,
  });

  const nameBlock = {
    box: row(1),
    weight: '700',
    text: String(name),
  };
  nameBlock.fit = fitText(ctx, nameBlock.text, nameBlock.box, {
    weight: '700', max: rowH, min: 8, maxLines: 1,
  });

  const priceBlock = {
    box: row(2),
    weight: '700',
    text: String(price),
  };
  priceBlock.fit = fitText(ctx, priceBlock.text, priceBlock.box, {
    weight: '700', max: rowH, min: 10, maxLines: 1,
  });

  return {
    width, height, fontStack: FONT_STACK,
    booth: boothBlock, name: nameBlock, price: priceBlock,
  };
}

/**
 * Paint one price tag. `label` is {name, price}; `booth` is the string that
 * goes on the top line and is the only thing that differs between locations.
 */
export function renderLabel(canvas, { booth, name, price }, opts = {}) {
  const { width, height } = labelDots();
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  const L = labelLayout(ctx, { booth, name, price }, opts);

  ctx.fillStyle = '#000';
  for (const block of [L.booth, L.name, L.price]) {
    if (!block.text || block.box.h <= 8) continue;
    ctx.font = `${block.weight} ${block.fit.size}px ${FONT_STACK}`;
    drawLines(ctx, block.fit.lines, block.fit.size, block.fit.lineHeight, block.box);
  }

  return L;
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
