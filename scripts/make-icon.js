// Builds the app icon (pixel-art Clawd) from the cell grid below:
//   build/icon.ico – multi-size icon used by electron-builder for the exe and
//                    installer, and at runtime for the tray and window icons
//   build/icon.png – 256px raster of the same art (README / release page)
//   build/icon.svg – vector version, for reference
// Each ICO frame is drawn at an integer number of pixels per cell, so the art
// stays crisp at every size instead of being resampled from one big bitmap.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const BODY = '#F15B45';
const EYE = '#0E0D0D';

// '#' body, 'o' eye (body cell with a dark square on it), '.' transparent
const SPRITE = [
  '..########..',
  '..#o####o#..',
  '############',
  '############',
  '..########..',
  '..########..',
  '..#.#..#.#..',
  '..#.#..#.#..',
];
const COLS = SPRITE[0].length;
const ROWS = SPRITE.length;

// Sizes Windows asks for at 100/125/150/200% DPI, plus the large ones.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Largest whole-pixel cell that fits; leave a small margin at big sizes.
function cellFor(size) {
  const fill = size >= 128 ? 0.94 : 1;
  return Math.max(1, Math.floor((size * fill) / COLS));
}

function rect(x, y, w, h, fill) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
}

function svgFor(size) {
  const cell = cellFor(size);
  const ox = Math.floor((size - COLS * cell) / 2);
  const oy = Math.floor((size - ROWS * cell) / 2);
  const rects = [];
  SPRITE.forEach((row, r) => {
    let c = 0;
    while (c < COLS) {
      if (row[c] === '.') { c++; continue; }
      let end = c;
      while (end < COLS && row[end] !== '.') end++;
      rects.push(rect(ox + c * cell, oy + r * cell, (end - c) * cell, cell, BODY));
      c = end;
    }
    for (let i = 0; i < COLS; i++) {
      if (row[i] === 'o') rects.push(rect(ox + i * cell, oy + r * cell, cell, cell, EYE));
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">\n  ${rects.join('\n  ')}\n</svg>\n`;
}

function render(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
}

// Classic ICO frame: BITMAPINFOHEADER + bottom-up 32-bit BGRA pixels + 1-bit
// AND mask. Understood by every Windows API and tool, unlike PNG-compressed
// frames which some (e.g. GDI+) only accept at 256px.
function dibFrame(rendered) {
  const { width: w, height: h } = rendered;
  const rgba = rendered.pixels;
  const maskStride = Math.ceil(w / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(w, 4); // biWidth
  header.writeInt32LE(h * 2, 8); // biHeight: colour + mask
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression: BI_RGB
  header.writeUInt32LE(w * h * 4 + maskStride * h, 20); // biSizeImage
  const xor = Buffer.alloc(w * h * 4);
  const and = Buffer.alloc(maskStride * h);
  for (let y = 0; y < h; y++) {
    const srcRow = h - 1 - y; // bottom-up
    for (let x = 0; x < w; x++) {
      const s = (srcRow * w + x) * 4;
      const d = (y * w + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
      if (rgba[s + 3] === 0) and[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, xor, and]);
}

function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + 16 * frames.length;
  const entries = frames.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}

function main() {
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const frames = SIZES.map((size) => {
    const rendered = render(svgFor(size), size);
    // PNG compression is only conventional (and universally supported) for the 256px frame.
    return { size, data: size >= 256 ? rendered.asPng() : dibFrame(rendered) };
  });
  const write = (name, data) => {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, data);
    console.log(`wrote ${p}`);
  };
  write('icon.ico', ico(frames));
  write('icon.png', render(svgFor(256), 256).asPng());
  write('icon.svg', svgFor(256));
}

if (require.main === module) main();

module.exports = { svgFor, render, SIZES };
