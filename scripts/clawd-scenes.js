// Regenerates Clawd's pixel art: the widget's pose scenes (renderer/index.html,
// between the clawd-scenes markers) and the overlay's hanging / walking
// sprites (renderer/overlay.html, between the clawd-sprites markers). Run
// `node scripts/clawd-scenes.js` after editing and commit the regenerated HTML.
//
// The base body is the reference drawing exactly: a 12 x 8 pixel grid,
//
//     . . O O O O O O O O . .      row 0   body: 8 x 6, no notch
//     . . O E O O O O E O . .      row 1   eyes: 1 x 1 at columns 3 and 8
//     O O O O O O O O O O O O      row 2   arms: 2 x 2 at rows 2-3
//     O O O O O O O O O O O O      row 3
//     . . O O O O O O O O . .      row 4
//     . . O O O O O O O O . .      row 5
//     . . O . O . . O . O . .      row 6   legs: 1 x 2 at columns 2, 4, 7, 9
//     . . O . O . . O . O . .      row 7
//
// drawn at 8 viewBox units per grid cell in a 100 x 100 box (widget scenes and
// the walk sprite), feet on y=100 and centred on x=52. The hang sprite is the
// same drawing shifted by +10,+20 in a 150 x 120 box, hanging by his left arm.
// Clawd is lit from the right: his left edge, left arm and nearest leg carry a
// darker shade, one grid cell wide.
//
// Every pose is this same drawing: the same body, the same 2 x 2 arms, the same
// eyes, never stretched, tilted or redrawn. A pose only adds what he wears or
// holds, and may lift an arm by two rows (rows 0-1, beside his head) to hold
// something up. Asleep, he sits down on his folded legs: the same drawing two
// rows lower, his body hiding his legs. So swapping one pose for another
// reads as one character changing what he's doing.
const fs = require('fs');
const path = require('path');

const U = 8; // viewBox units per grid cell
const GX = 4; // grid column 0 starts here (12 cells -> x 4..100, centre 52)
const GY = 36; // grid row 0 starts here (8 rows -> y 36..100, feet on 100)
const cx = (col) => GX + col * U;
const cy = (row) => GY + row * U;
const RAISED = -2 * U; // an arm lifted to rows 0-1

const C = {
  body: '#D97757',
  side: '#BF5F42', // the shaded (left) side
  eye: '#141414',
  hat: '#FFC53D',
  hatDark: '#E8A912',
  lampRim: '#C98F12',
  lamp: '#FFF1B8',
  steel: '#9CA3AD',
  steelDark: '#6F7680',
  steelHi: '#C9CFD6',
  wood: '#6B4A2E',
  bulb: '#F2C14E',
  bulbHi: '#FFE28F',
  base: '#9AA0A6',
  baseDark: '#6F767D',
  bubble: '#5B8FD0',
  bubbleHi: '#8DBBEB',
  ink: '#1F2933',
  dial: '#F4F1EA',
  hand: '#C9445B',
  watch: '#3F7ACB',
  watchHi: '#9CCBF7',
  strap: '#2F3A48',
  screen: '#1e63b8',
  laptop: '#3a3e46',
  glassRim: '#d3d8de',
  glassLens: '#bfe0ff',
  glassHandle: '#98A0AA',
  // bedtime
  cap: '#C9445B',
  capTrim: '#F4F1EA',
  teddy: '#A0714F',
  teddyLight: '#D9B38C',
  blanket: '#6B8FD1',
  blanketHi: '#93B3EA',
};

const rect = (x, y, w, h, fill, attrs = '') =>
  `<rect${attrs ? ' ' + attrs : ''} x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;

// A part is a function of the offset; `o` shifts everything for the hang sprite.
function P(o) {
  const R = (x, y, w, h, fill, attrs) => rect(x + o.dx, y + o.dy, w, h, fill, attrs);
  const G = (attrs, inner) => `<g ${attrs}>${inner.join('')}</g>`;
  // ------------------------------------------------------------ base body
  const LEG_COLS = [2, 4, 7, 9];
  const leg = (i, attrs = '') => R(cx(LEG_COLS[i]), cy(6), U, 2 * U, i === 0 ? C.side : C.body, attrs);
  const legs = () => LEG_COLS.map((_, i) => leg(i)).join('');
  // body 8 x 6 with its shaded left column
  const torso = () => R(cx(2), cy(0), 8 * U, 6 * U, C.body) + R(cx(2), cy(0), U, 6 * U, C.side);
  // arms 2 x 2 on rows 2-3 (dy = RAISED lifts one to rows 0-1); the left one
  // sits in shadow
  const armL = (attrs = '', dy = 0) => R(cx(0), cy(2) + dy, 2 * U, 2 * U, C.side, attrs);
  const armR = (attrs = '', dy = 0) => R(cx(10), cy(2) + dy, 2 * U, 2 * U, C.body, attrs);
  // eyes: 1 x 1 at columns 3 and 8 on row 1
  const eyes = () => G('class="eyes"', [R(cx(3), cy(1), U, U, C.eye), R(cx(8), cy(1), U, U, C.eye)]);
  // ------------------------------------------------------------ outfits and props
  // hard hat with a miner's lamp on the front, sitting on the head (y 36)
  const hardhat = (cls = 'hardhat') =>
    G(`class="${cls}"`, [
      R(34, 16, 36, 7, C.hat),
      R(34, 16, 6, 7, C.hatDark),
      R(26, 23, 52, 7, C.hat),
      R(26, 23, 6, 7, C.hatDark),
      R(18, 30, 68, 7, C.hatDark),
      // lamp: rim ring with a bright lens
      R(48, 17, 8, 3, C.lampRim),
      R(45, 20, 14, 9, C.lampRim),
      R(48, 29, 8, 2, C.lampRim),
      R(48, 21, 8, 7, C.lamp),
    ]);
  // the hammer in two frames, swapped rather than swung: raised over his
  // head in his lifted right hand, then brought down beside him, head first
  const hammerUp = (cls = 'ham-up') =>
    G(`class="${cls}"`, [
      armR('', RAISED),
      R(90, 18, 4, 18, C.wood), // handle, up out of the fist
      R(80, 9, 24, 9, C.steel), // head
      R(80, 14, 24, 4, C.steelDark),
      R(82, 10, 4, 3, C.steelHi),
    ]);
  const hammerDown = (cls = 'ham-down') =>
    G(`class="${cls}"`, [
      R(90, 68, 4, 10, C.wood), // handle, down out of the fist
      R(82, 78, 24, 9, C.steel), // head, at the floor
      R(82, 78, 24, 4, C.steelDark),
      R(84, 83, 4, 3, C.steelHi),
      armR(),
    ]);
  // wristwatch strapped round the right arm, at its usual height or lifted
  // beside his face for a look
  const watchArm = (cls, dy = 0) =>
    G(`class="${cls}"`, [
      armR('', dy),
      R(cx(10), cy(2) + 6 + dy, 2 * U, 4, C.strap),
      R(cx(10) + 4, cy(2) + 4 + dy, 8, 8, C.watch),
      R(cx(10) + 5, cy(2) + 5 + dy, 3, 3, C.watchHi),
    ]);
  // magnifying glass held up in the right hand: the handle runs up out of the
  // fist, the lens sits beside his head
  const glass = (cls = 'glass') =>
    G(`class="${cls}"`, [
      armR(),
      R(90, 44, 4, 8, C.glassHandle),
      R(88, 23, 8, 2, C.glassRim),
      R(85, 25, 14, 2, C.glassRim),
      R(82, 27, 20, 12, C.glassRim),
      R(85, 39, 14, 2, C.glassRim),
      R(88, 41, 8, 2, C.glassRim),
      G('opacity="0.55"', [
        R(89, 25, 6, 2, C.glassLens),
        R(87, 27, 10, 2, C.glassLens),
        R(84, 29, 16, 8, C.glassLens),
        R(87, 37, 10, 2, C.glassLens),
        R(89, 39, 6, 2, C.glassLens),
      ]),
      R(86, 29, 3, 3, '#ffffff', 'class="glint"'),
    ]);
  // laptop held up in front of him by its sides, screen out, code on it; his
  // arms grip the lid's edges
  const laptop = () =>
    G('class="laptop"', [
      R(20, 58, 64, 22, C.laptop),
      R(23, 61, 58, 16, C.screen),
      R(27, 64, 16, 2, '#d6ecff'),
      R(27, 68, 26, 2, '#9fd3ff'),
      R(33, 72, 12, 2, '#d6ecff'),
      R(47, 72, 2, 2, '#ffffff', 'class="caret"'),
      R(16, 80, 72, 4, '#4a4f59'),
      R(20, 81, 64, 2, '#6b727e'),
    ]);
  // lightbulb, (dx, dy) shifts it
  const bulb = (dx = 0, dy = 0) =>
    G('class="bulb"', [
      R(58 + dx, 4 + dy, 12, 3, C.bulb),
      R(55 + dx, 7 + dy, 18, 3, C.bulb),
      R(52 + dx, 10 + dy, 24, 12, C.bulb),
      R(55 + dx, 22 + dy, 18, 3, C.bulb),
      R(58 + dx, 25 + dy, 12, 3, C.bulb),
      R(56 + dx, 11 + dy, 4, 7, C.bulbHi, 'class="glint"'),
      R(59 + dx, 28 + dy, 10, 3, C.base),
      R(60 + dx, 31 + dy, 8, 3, C.baseDark),
    ]);
  // blue speech bubble with a question mark, tail down to his head
  const bubble = () =>
    G('class="bubble"', [
      R(62, 4, 24, 3, C.bubble),
      R(59, 7, 30, 3, C.bubble),
      R(57, 10, 34, 9, C.bubble),
      R(59, 19, 30, 3, C.bubble),
      R(62, 22, 24, 3, C.bubble),
      R(64, 25, 6, 3, C.bubble),
      R(62, 28, 4, 3, C.bubble),
      R(60, 10, 3, 5, C.bubbleHi),
      G('class="qmark"', [
        R(70, 8, 7, 2, C.ink),
        R(75, 10, 2, 3, C.ink),
        R(73, 13, 3, 2, C.ink),
        R(73, 17, 2, 2, C.ink),
      ]),
    ]);
  // stopwatch held in front of him, the right fist closed over the side of
  // the case (the arm is drawn after it); the hand ticks round about (76, 70)
  const stopwatch = () =>
    G('class="stopwatch"', [
      R(72, 52, 8, 3, C.steel), // button
      R(74, 55, 4, 3, C.steelDark),
      R(70, 58, 12, 2, C.steel), // case, roughly round
      R(67, 60, 18, 2, C.steel),
      R(65, 62, 22, 2, C.steel),
      R(64, 64, 24, 12, C.steel),
      R(65, 76, 22, 2, C.steel),
      R(67, 78, 18, 2, C.steel),
      R(70, 80, 12, 2, C.steel),
      R(70, 60, 12, 2, C.dial), // dial
      R(67, 62, 18, 2, C.dial),
      R(66, 64, 20, 12, C.dial),
      R(67, 76, 18, 2, C.dial),
      R(70, 78, 12, 2, C.dial),
      R(75, 62, 2, 2, C.ink), // 12, 3, 6, 9
      R(83, 69, 2, 2, C.ink),
      R(75, 76, 2, 2, C.ink),
      R(67, 69, 2, 2, C.ink),
      R(75, 63, 2, 8, C.hand, 'class="sw-hand"'),
      R(75, 69, 2, 2, C.ink),
    ]);
  // ------------------------------------------------------------ bedtime props
  // nightcap on the standing head (head top is y=36): brim, a floppy cone
  // leaning left, pompom
  const nightcapRects = () => [
    [24, 32, 56, 5, C.capTrim],
    [28, 23, 46, 9, C.cap],
    [28, 15, 28, 8, C.cap],
    [26, 9, 14, 6, C.cap],
    [20, 4, 10, 8, C.capTrim],
  ];
  const nightcap = (cls = 'prop cap') => G(`class="${cls}"`, nightcapRects().map((r) => R(...r)));
  // teddy bear, drawn with its top-left at (x, y); 16 wide, 26 tall
  const teddy = (x, y, cls = 'prop teddy') =>
    G(`class="${cls}"`, [
      R(x + 1, y, 4, 4, C.teddy),
      R(x + 11, y, 4, 4, C.teddy),
      R(x + 2, y + 3, 12, 9, C.teddy),
      R(x + 4, y + 6, 2, 2, C.eye),
      R(x + 10, y + 6, 2, 2, C.eye),
      R(x + 6, y + 9, 4, 3, C.teddyLight),
      R(x + 3, y + 12, 10, 10, C.teddy),
      R(x, y + 14, 3, 6, C.teddy),
      R(x + 13, y + 14, 3, 6, C.teddy),
      R(x + 3, y + 22, 4, 4, C.teddy),
      R(x + 9, y + 22, 4, 4, C.teddy),
    ]);
  // folded blanket bundle hanging from the right arm (standing pose)
  const blanketBundle = (cls = 'prop blanket') =>
    G(`class="${cls}"`, [
      R(84, 66, 18, 16, C.blanket),
      R(84, 72, 18, 3, C.blanketHi),
      R(94, 82, 6, 8, C.blanket),
      R(96, 90, 4, 6, C.blanket),
    ]);
  // ------------------------------------------------------------ asleep
  // Asleep he sits down on his folded legs: scenes() draws these with P
  // shifted down by SETTLE, so his body covers his legs. Coordinates here are
  // on his standing drawing; they move down with him. His eyes are shut, his
  // nightcap has flopped over, he hugs the teddy to his chest, and the
  // blanket is over his lap with his arms resting on top of it.
  // closed eyes: each eye squeezed to a line along its bottom edge
  const shutEyes = () => G('class="eyes"', [R(cx(3), cy(1) + 5, U, 3, C.eye), R(cx(8), cy(1) + 5, U, 3, C.eye)]);
  const floppyCap = (cls = 'prop cap') =>
    G(`class="${cls}"`, [
      R(24, 32, 56, 5, C.capTrim), // brim
      R(28, 23, 46, 9, C.cap),
      R(16, 17, 40, 8, C.cap), // the cone, flopped over to his left
      R(8, 19, 10, 10, C.cap),
      R(4, 27, 10, 8, C.capTrim), // pompom, hanging by his ear
    ]);
  const hugTeddy = (cls = 'prop teddy') => teddy(44, 38, cls);
  const lapBlanket = (cls = 'prop blanket') =>
    G(`class="${cls}"`, [
      R(10, 60, 84, 24, C.blanket),
      R(10, 60, 84, 3, C.blanketHi), // turned-down hem
      R(10, 70, 84, 2, C.blanketHi),
    ]);
  return {
    R, G, legs, leg, torso, armL, armR, eyes, hardhat, hammerUp, hammerDown, watchArm, glass, laptop, bulb,
    bubble, stopwatch, nightcap, teddy, blanketBundle, shutEyes, floppyCap, hugTeddy, lapBlanket,
  };
}

// asleep, his folded legs lower him by two rows
const SETTLE = 2 * U;

// ------------------------------------------------------------ widget scenes

function scenes() {
  const p = P({ dx: 0, dy: 0 });
  const svg = (id, extra, inner) =>
    `        <svg id="${id}" class="scene${extra}" viewBox="0 0 100 100" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">\n          ${inner.join('\n          ')}\n        </svg>`;
  const out = [];
  out.push(`        <!-- idle: plain Clawd, bobbing (frozen when no sessions).
             Starts \`on\` so he is visible from the first paint, before app.js runs. -->`);
  out.push(svg('scene-idle', ' on', [p.legs(), p.G('class="bob"', [p.armL(), p.armR(), p.torso(), p.eyes()])]));
  out.push(`\n        <!-- thinking: working, but no tool running yet. A bulb lights up just
             out of reach above his head; he hops for it and it bobs away. -->`);
  out.push(
    svg('scene-think', '', [
      p.G('class="jump"', [p.legs(), p.armL(), p.armR(), p.torso(), p.eyes()]),
      p.bulb(-12, -8),
    ])
  );
  out.push(`\n        <!-- working: hard hat with a lamp, hammering (commands and everything else) -->`);
  out.push(
    svg('scene-work', '', [
      p.legs(),
      p.G('class="bob-work"', [p.armL(), p.torso(), p.eyes(), p.hardhat(), p.hammerUp(), p.hammerDown()]),
    ])
  );
  out.push(`\n        <!-- typing: Edit / Write -->`);
  out.push(
    svg('scene-type', '', [
      p.legs(),
      p.G('class="bob"', [
        p.torso(),
        p.eyes(),
        p.laptop(),
        p.G('class="tap tap-l"', [p.armL()]),
        p.G('class="tap tap-r"', [p.armR()]),
      ]),
    ])
  );
  out.push(`\n        <!-- reading / searching: Read, Grep, Glob, web -->`);
  out.push(svg('scene-read', '', [p.legs(), p.G('class="bob"', [p.armL(), p.torso(), p.eyes(), p.glass()])]));
  out.push(`\n        <!-- permission: waiting on you, checking his watch (id kept from the stop-sign days) -->`);
  out.push(
    svg('scene-stop', '', [
      p.leg(0),
      p.G('class="foot"', [p.leg(1)]),
      p.leg(2),
      p.leg(3),
      p.G('class="bob"', [
        p.armL(),
        p.torso(),
        p.eyes(),
        p.watchArm('watch-down'),
        p.watchArm('watch-up', -16),
      ]),
    ])
  );
  out.push(`\n        <!-- question: Claude is asking you something -->`);
  out.push(
    svg('scene-question', '', [
      p.legs(),
      p.G('class="bob"', [p.armL(), p.armR(), p.torso(), p.eyes()]),
      p.bubble(),
    ])
  );
  out.push(`\n        <!-- background work: Claude is ready, but tasks it started are still running -->`);
  out.push(
    svg('scene-stopwatch', '', [
      p.legs(),
      p.G('class="bob"', [p.armL(), p.torso(), p.eyes(), p.stopwatch(), p.armR()]),
    ])
  );
  // bedtime, part 1: walking (off to fetch his things, then back with them;
  // the props are hidden on the way out)
  out.push(`\n        <!-- bedtime: walking off, then back with nightcap, teddy and blanket -->`);
  out.push(
    svg('scene-bedwalk', '', [
      p.G('class="legsA"', [p.leg(0), p.leg(2)]),
      p.G('class="legsB"', [p.leg(1), p.leg(3)]),
      p.G('class="torso"', [
        p.armL(),
        p.armR(),
        p.torso(),
        p.eyes(),
        p.nightcap(),
        p.teddy(1, 64),
        p.blanketBundle(),
      ]),
    ])
  );
  // bedtime, part 2: sat down on his folded legs (the .settle groups start at
  // standing height and step down), teddy hugged, blanket over his lap
  const s = P({ dx: 0, dy: SETTLE });
  out.push(`\n        <!-- bedtime: asleep, sat down on his folded legs under the blanket -->`);
  out.push(
    svg('scene-sleep', '', [
      p.legs(),
      s.G('class="settle"', [s.torso(), s.shutEyes(), s.floppyCap()]),
      s.hugTeddy(),
      s.lapBlanket(),
      s.G('class="settle"', [s.armL(), s.armR()]),
    ])
  );
  // the props alone, where they sit while he sleeps: shown only while they
  // drop off the screen when he is startled awake
  out.push(`\n        <!-- bedtime: the props falling away when he wakes -->`);
  out.push(
    `        <svg id="scene-props" class="props" viewBox="0 0 100 100" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">\n          ${[
      s.lapBlanket('drop-blanket'),
      s.hugTeddy('drop-teddy'),
      s.floppyCap('drop-cap'),
    ].join('\n          ')}\n        </svg>`
  );
  return out.join('\n');
}

// ------------------------------------------------------------ overlay sprites

function sprites() {
  const h = P({ dx: 10, dy: 20 }); // hang sprite: the widget drawing shifted by +10,+20
  const w = P({ dx: 0, dy: 0 }); // walk sprite: 1:1 with the widget
  const hang = [
    `    <!-- hanging from the cursor by one arm (drag + fall) -->`,
    `    <div id="hang" class="sprite" hidden>`,
    `      <svg viewBox="0 0 150 120" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">`,
    `        <!-- hard hat (working) -->`,
    `        ${h.hardhat('acc acc-hat')}`,
    `        <!-- wristwatch on the free arm (permission) -->`,
    `        ${h.watchArm('acc acc-watch')}`,
    `        <!-- plain free arm otherwise -->`,
    `        ${h.armR('class="plain-arm"')}`,
    `        <!-- body -->`,
    `        ${h.torso()}`,
    `        ${h.eyes()}`,
    `        <!-- hammer raised in the free hand (working) -->`,
    `        ${h.hammerUp('acc acc-pick')}`,
    `        ${h.G('class="legs"', [h.leg(0), h.leg(1), h.leg(2), h.leg(3)])}`,
    `        <!-- left arm lifted over his head, gripping at the cursor point (30,40) -->`,
    `        ${rect(22, 40, 16, 16, C.side)}`,
    `      </svg>`,
    `    </div>`,
  ];
  const walk = [
    `    <!-- upright, walking home -->`,
    `    <div id="walk" class="sprite" hidden>`,
    `      <svg viewBox="0 0 100 100" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">`,
    `        ${w.G('class="legsA"', [w.leg(0), w.leg(2)])}`,
    `        ${w.G('class="legsB"', [w.leg(1), w.leg(3)])}`,
    `        <g class="torso">`,
    `          ${w.armL('class="arm-left"')}`,
    `          ${w.armR('class="arm-right"')}`,
    `          <!-- watch arm (permission) -->`,
    `          ${w.watchArm('acc acc-watch2')}`,
    `          ${w.torso()}`,
    `          ${w.eyes()}`,
    `          <!-- hard hat (working) -->`,
    `          ${w.hardhat('acc acc-hat2')}`,
    `          <!-- hammer raised (working) -->`,
    `          ${w.hammerUp('acc acc-pick2')}`,
    `        </g>`,
    `      </svg>`,
    `    </div>`,
  ];
  return hang.join('\n') + '\n\n' + walk.join('\n');
}

// ------------------------------------------------------------ splice into the HTML

function splice(file, startMark, endMark, body) {
  const p = path.join(__dirname, '..', 'renderer', file);
  const src = fs.readFileSync(p, 'utf8');
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark);
  if (a < 0 || b < 0 || b < a) throw new Error(`${file}: markers not found`);
  const out = src.slice(0, a + startMark.length) + '\n' + body + '\n' + src.slice(b);
  fs.writeFileSync(p, out);
  console.log(`wrote ${file}`);
}

splice('index.html', '<!-- clawd-scenes:start -->', '        <!-- clawd-scenes:end -->', scenes());
splice('overlay.html', '<!-- clawd-sprites:start -->', '    <!-- clawd-sprites:end -->', sprites());
