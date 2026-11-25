// The shape of the opened widget, shared by the page (which draws it) and the
// main process (which hit-tests the cursor against it).
//
// The widget is a lamp in a corner of the screen. On hover a quarter-disc tray
// opens out of it, like a wifi glyph turned to fit the corner, carrying four
// tiles: the usage tile (three gauges sweeping up the rim into their legend),
// the sessions card nested inside the gauges, the status pill beside the lamp,
// and the lamp itself.
//
// Everything here is in design units (one CSS px at 100% size) for a lamp in
// the bottom-right corner: x runs right and y runs down from the tray's
// top-left, and the lamp's centre is at (D, D). The page mirrors it for the
// other three corners.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ClawdGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LAMP_R = 22; // the lamp, opened
  const DOT_R = 18; // the lamp at rest
  const GAP = 6; // between tiles, and from a tile to the tray's edge
  const CARD_H = 121; // the sessions card: three two-line rows
  const TEXT_INSET = 12; // from a tile's edge to the text inside it
  const LEGEND_FIRST = 18; // from the legend block's lower edge to its first row's centre
  const LEGEND_PITCH = 21;
  const ARC_END = 112; // the gauges stop on a vertical this far from the lamp's centre
  const LEGEND_GAP = 10; // from there to the legend's text
  const BAND_PAD = 15; // from the outer and inner gauges' centre lines to the tile's edges
  const ARC_FOOT = 8; // the gauges start this far past the lamp's centre line
  const TILE_R = 16; // corner radius of the usage tile
  const CARD_R = 12; // and of the card nested in it
  const FILLET = CARD_R + GAP; // so the tile's inside corner is concentric with the card's
  const MARGIN = 6; // from the tray to the window's two near edges
  const SLACK = 3; // and to its two far ones

  // Heights are measured up from the lamp's centre.
  const foot = LAMP_R + GAP; // 28: the lamp's centre to the tray's near edges
  const cardBottom = foot;
  const cardTop = cardBottom + CARD_H;
  const legendBottom = cardTop + GAP;
  // a legend row per gauge, the inner gauge's lowest; each gauge ends level
  // with its row, so its radius follows from the row's height
  const rowHeights = [0, 1, 2].map((i) => legendBottom + LEGEND_FIRST + i * LEGEND_PITCH);
  const radii = rowHeights.map((h) => Math.hypot(ARC_END, h));
  const Ri = Math.round(radii[0] - BAND_PAD); // usage tile, inner edge
  const Rs = Ri - GAP; // sessions card, curved edge
  const Ro = Math.round(radii[2] + BAND_PAD); // usage tile, outer edge
  const Rt = Ro + GAP; // the tray
  const D = Rt;
  const SIZE = Rt + foot;

  const n = (v) => Number(v.toFixed(2));
  const X = (x) => n(D + x);
  const Y = (y) => n(D - y);

  // the circle that rounds the corner where the legend block meets the band;
  // the card's own corner is the same circle, GAP smaller
  const cy = legendBottom - FILLET;
  const cx = -Math.sqrt((Ri - FILLET) ** 2 - cy ** 2);
  const kTile = Ri / (Ri - FILLET);
  const kCard = Rs / (Ri - FILLET);
  // and the card's corner by the status pill
  const c2y = cardBottom + CARD_R;
  const c2x = -Math.sqrt((Rs - CARD_R) ** 2 - c2y ** 2);
  const k2 = Rs / (Rs - CARD_R);

  const usagePath = [
    `M${GAP} ${Y(-LAMP_R + TILE_R)}`,
    `L${GAP} ${D}`,
    `A${Ro} ${Ro} 0 0 1 ${D} ${GAP}`,
    `L${X(LAMP_R - TILE_R)} ${GAP}`,
    `A${TILE_R} ${TILE_R} 0 0 1 ${X(LAMP_R)} ${GAP + TILE_R}`,
    `L${X(LAMP_R)} ${Y(legendBottom + TILE_R)}`,
    `A${TILE_R} ${TILE_R} 0 0 1 ${X(LAMP_R - TILE_R)} ${Y(legendBottom)}`,
    `L${X(cx)} ${Y(legendBottom)}`,
    `A${FILLET} ${FILLET} 0 0 0 ${X(cx * kTile)} ${Y(cy * kTile)}`,
    `A${Ri} ${Ri} 0 0 0 ${X(-Ri)} ${D}`,
    `L${X(-Ri)} ${Y(-LAMP_R + TILE_R)}`,
    `A${TILE_R} ${TILE_R} 0 0 1 ${X(-Ri - TILE_R)} ${Y(-LAMP_R)}`,
    `L${GAP + TILE_R} ${Y(-LAMP_R)}`,
    `A${TILE_R} ${TILE_R} 0 0 1 ${GAP} ${Y(-LAMP_R + TILE_R)}`,
    'Z',
  ].join(' ');

  const cardPath = [
    `M${X(cx)} ${Y(cardTop)}`,
    `L${X(LAMP_R - CARD_R)} ${Y(cardTop)}`,
    `A${CARD_R} ${CARD_R} 0 0 1 ${X(LAMP_R)} ${Y(cardTop - CARD_R)}`,
    `L${X(LAMP_R)} ${Y(cardBottom + CARD_R)}`,
    `A${CARD_R} ${CARD_R} 0 0 1 ${X(LAMP_R - CARD_R)} ${Y(cardBottom)}`,
    `L${X(c2x)} ${Y(cardBottom)}`,
    `A${CARD_R} ${CARD_R} 0 0 1 ${X(c2x * k2)} ${Y(c2y * k2)}`,
    `A${Rs} ${Rs} 0 0 1 ${X(cx * kCard)} ${Y(cy * kCard)}`,
    `A${CARD_R} ${CARD_R} 0 0 1 ${X(cx)} ${Y(cardTop)}`,
    'Z',
  ].join(' ');

  // outer first: the 5-hour window, the week, the top model's week
  const gauges = [2, 1, 0].map((i) => {
    const r = n(radii[i]);
    return {
      d: `M${X(-r)} ${Y(-ARC_FOOT)} L${X(-r)} ${D} A${r} ${r} 0 0 1 ${X(-ARC_END)} ${Y(rowHeights[i])}`,
      rowY: Y(rowHeights[i]), // the centre of its legend row
    };
  });

  const textEdge = D + LAMP_R - TEXT_INSET; // the lamp-side edge of every text block

  // The leftmost x a line of card text may reach when its far edge (the one
  // further from the lamp) is at height y: the card narrows as it climbs.
  function cardLimit(y) {
    const h = D - y;
    const r = Rs - TEXT_INSET;
    return h >= r ? D : D - Math.sqrt(r * r - h * h);
  }

  // Is a point on the opened tray? u and v are its distances from the lamp's
  // centre, measured into the fan (negative: towards the screen corner).
  function insideTray(u, v, pad) {
    const far = Rt + pad;
    const near = -(foot + pad);
    if (u < near || v < near || u > far || v > far) return false;
    return u <= 0 || v <= 0 || u * u + v * v <= far * far;
  }

  // Which tile of the opened tray is a point on: 'lamp', 'pill', 'card' or
  // 'usage', or null in the gaps between them. u and v as for insideTray. The
  // tiles' rounded corners are taken as square: a pixel or two at a corner
  // makes no difference to what the pointer is over.
  function tileAt(u, v) {
    const d2 = u * u + v * v;
    if (d2 <= LAMP_R * LAMP_R) return 'lamp';
    if (u < -LAMP_R || v < -LAMP_R) return null;
    if (v <= LAMP_R) {
      if (u >= foot && u <= Rs) return 'pill';
    } else if (v >= cardBottom && v <= cardTop) {
      if (d2 <= Rs * Rs) return 'card';
    }
    // the usage tile: the band between its two arcs, the foot that carries
    // the band down past the pill, and the legend block above the card
    if (u > Ro || v > Ro || (u > 0 && v > 0 && d2 > Ro * Ro)) return null;
    if (v >= legendBottom) return 'usage';
    if (u < 0) return null;
    return (v <= 0 ? u >= Ri : d2 >= Ri * Ri) ? 'usage' : null;
  }

  // Is it on the resting lamp, or on the wait pill beside it (reach: how far
  // the pill extends from the lamp's centre, 0 without one)?
  function insideRest(u, v, reach, pad) {
    const r = DOT_R + pad;
    return v >= -r && v <= r && u >= -r && u <= Math.max(r, reach + pad);
  }

  return {
    SIZE, // the tray's side
    D, // the lamp's centre, from the tray's top-left
    LAMP_R,
    DOT_R,
    GAP,
    MARGIN,
    WINDOW: SIZE + MARGIN + SLACK, // the window's side
    LAMP_INSET: MARGIN + foot, // the lamp's centre from the window's two near edges
    trayRadius: Rt,
    usagePath,
    cardPath,
    gauges,
    legend: { left: D - ARC_END + LEGEND_GAP, right: textEdge, rowH: 16 },
    card: { top: D - cardTop, bottom: D - cardBottom, height: CARD_H, textEdge },
    // the middle of each tile's own box: what it swells about under the pointer
    middle: {
      usage: { x: (GAP + D + LAMP_R) / 2, y: (GAP + D + LAMP_R) / 2 },
      card: { x: (D - Rs + D + LAMP_R) / 2, y: (D - cardTop + D - cardBottom) / 2 },
    },
    pill: { left: D - Rs, top: D - LAMP_R, width: Rs - foot, height: 2 * LAMP_R },
    cardLimit,
    insideTray,
    insideRest,
    tileAt,
  };
});
