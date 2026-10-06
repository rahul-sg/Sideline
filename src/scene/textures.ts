import * as THREE from 'three';
import { FIELD_LEN, FIELD_W } from '../lib/playMath';

const PX = 32; // canvas pixels per yard for markings
const BORDER = 2; // 6-ft solid white border around the field
const HASH_IN = 70.75 / 3; // hash marks 70'9" from each sideline

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

/** Grass tile: 10 x 10 yards with one light and one dark mowing stripe. */
export function turfTexture(striped: boolean, anisotropy: number) {
  const N = 1024;
  const [c, g] = canvas(N, N);
  const img = g.createImageData(N, N);
  const rnd = seeded(7);
  const light = [52, 104, 44];
  const dark = [42, 88, 36];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const base = striped && x >= N / 2 ? dark : striped ? light : dark;
      const n = (rnd() - 0.5) * 22 + Math.sin((x + rnd() * 3) * 1.7) * 3;
      const i = (y * N + x) * 4;
      img.data[i] = base[0] + n * 0.6;
      img.data[i + 1] = base[1] + n;
      img.data[i + 2] = base[2] + n * 0.5;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Blades: short streaks give the surface grain at low camera angles.
  for (let k = 0; k < 26000; k++) {
    const x = rnd() * N;
    const y = rnd() * N;
    const l = 2 + rnd() * 5;
    g.strokeStyle = rnd() > 0.5 ? 'rgba(150,200,110,0.10)' : 'rgba(20,50,20,0.14)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 2, y + l);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  return t;
}

export interface EndZoneStyle {
  fill: string;
  text: string;
  stroke: string;
  label: string;
}

/** Field markings drawn to scale on a transparent canvas covering the field plus border. */
export function markingsTexture(endZones: [EndZoneStyle, EndZoneStyle], anisotropy: number) {
  const W = Math.round((FIELD_LEN + BORDER * 2) * PX);
  const H = Math.round((FIELD_W + BORDER * 2) * PX);
  const [c, g] = canvas(W, H);
  // Field coords → canvas: x right, y up (canvas top = far sideline).
  const X = (x: number) => (x + BORDER) * PX;
  const Y = (y: number) => (FIELD_W + BORDER - y) * PX;
  const white = 'rgba(248,248,244,0.96)';

  // End zones
  endZones.forEach((ez, side) => {
    const x0 = side === 0 ? 0 : FIELD_LEN - 10;
    g.fillStyle = ez.fill;
    g.fillRect(X(x0), Y(FIELD_W), 10 * PX, FIELD_W * PX);
    g.save();
    g.translate(X(x0 + 5), Y(FIELD_W / 2));
    g.rotate(side === 0 ? -Math.PI / 2 : Math.PI / 2);
    const size = 5.2 * PX;
    g.font = `800 ${size}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const label = ez.label.toUpperCase();
    // Keep the wordmark inside the end zone width with some margin.
    const maxW = (FIELD_W - 8) * PX;
    const w = g.measureText(label).width;
    if (w > maxW) g.scale(maxW / w, 1);
    g.lineJoin = 'round';
    g.lineWidth = 0.55 * PX;
    g.strokeStyle = ez.stroke;
    g.strokeText(label, 0, 0);
    g.fillStyle = ez.text;
    g.fillText(label, 0, 0);
    g.restore();
  });

  // Solid border
  g.fillStyle = white;
  g.fillRect(0, 0, W, BORDER * PX);
  g.fillRect(0, H - BORDER * PX, W, BORDER * PX);
  g.fillRect(0, 0, BORDER * PX, H);
  g.fillRect(W - BORDER * PX, 0, BORDER * PX, H);

  const vline = (x: number, y0: number, y1: number, w: number) => g.fillRect(X(x) - (w * PX) / 2, Y(y1), w * PX, (y1 - y0) * PX);
  g.fillStyle = white;

  // Goal lines (8 in) and yard lines every 5 (4 in)
  vline(10, 0, FIELD_W, 8 / 36);
  vline(110, 0, FIELD_W, 8 / 36);
  for (let x = 15; x <= 105; x += 5) vline(x, 0, FIELD_W, 4 / 36);

  // One-yard ticks at the sidelines, the hashes and the 9-yard marks
  for (let x = 11; x <= 109; x++) {
    if (x % 5 === 0) continue;
    const w = 4 / 36;
    vline(x, 0.11, 0.78, w);
    vline(x, FIELD_W - 0.78, FIELD_W - 0.11, w);
    vline(x, HASH_IN - 0.33, HASH_IN + 0.33, w);
    vline(x, FIELD_W - HASH_IN - 0.33, FIELD_W - HASH_IN + 0.33, w);
  }
  // Two-point tries are snapped from the 2
  vline(12, FIELD_W / 2 - 0.5, FIELD_W / 2 + 0.5, 4 / 36);
  vline(108, FIELD_W / 2 - 0.5, FIELD_W / 2 + 0.5, 4 / 36);

  // Numbers: 6 ft tall, tops 9 yards from the sideline, split by the yard line.
  const numH = 2 * PX;
  g.font = `700 ${numH * 1.18}px "Barlow Condensed", "Arial Narrow", sans-serif`;
  g.textBaseline = 'alphabetic';
  for (let yl = 10; yl <= 90; yl += 10) {
    const x = yl + 10;
    const label = String(yl <= 50 ? yl : 100 - yl);
    const [d1, d2] = label.split('');
    for (const far of [false, true]) {
      g.save();
      const topY = far ? FIELD_W - 9 : 9;
      g.translate(X(x), Y(topY));
      if (far) g.rotate(Math.PI);
      // After rotation, the number's top edge is at local y=0 and it extends to +numH.
      g.fillStyle = white;
      g.textAlign = 'right';
      g.fillText(d1, -0.42 * PX, numH * 1.0);
      g.textAlign = 'left';
      g.fillText(d2, 0.42 * PX, numH * 1.0);
      // Arrow toward the nearer goal line
      if (yl !== 50) {
        const dir = (yl < 50 ? -1 : 1) * (far ? -1 : 1);
        const ax = dir * (g.measureText(d1).width + 0.85 * PX);
        g.beginPath();
        g.moveTo(ax + dir * 0.55 * PX, numH * 0.32);
        g.lineTo(ax, numH * 0.18);
        g.lineTo(ax, numH * 0.46);
        g.closePath();
        g.fill();
      }
      g.restore();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return { texture: t, width: FIELD_LEN + BORDER * 2, depth: FIELD_W + BORDER * 2 };
}

/** Seated crowd seen from a distance: rows of heads and shirts in mostly home colors. */
export function crowdTexture(home: string[], away: string[], seed = 3) {
  const W = 1024;
  const H = 512;
  const [c, g] = canvas(W, H);
  const rnd = seeded(seed);
  g.fillStyle = '#07090d';
  g.fillRect(0, 0, W, H);
  const neutrals = ['#d9d4cc', '#2a2d33', '#575c66', '#8a8f99', '#b5482f', '#1f3b70', '#e8e2d4'];
  const skins = ['#e0b394', '#c58c66', '#8d5a3b', '#5c3a26', '#f0c9a8'];
  const rowH = 9;
  for (let r = 0; r < H / rowH; r++) {
    // Seat-row step shadow
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, r * rowH + rowH - 2, W, 2);
    for (let x = 0; x < W; x += 6 + rnd() * 2) {
      if (rnd() < 0.06) continue; // empty seat
      const p = rnd();
      const shirt = p < 0.45 ? home[Math.floor(rnd() * home.length)] : p < 0.55 ? away[Math.floor(rnd() * away.length)] : neutrals[Math.floor(rnd() * neutrals.length)];
      const y = r * rowH + 1 + rnd() * 1.5;
      g.fillStyle = shirt;
      g.fillRect(x, y + 3.2, 5, 4.5);
      g.fillStyle = skins[Math.floor(rnd() * skins.length)];
      g.beginPath();
      g.arc(x + 2.5, y + 2, 1.7, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Jersey number decal. */
export function numberTexture(num: number | null, color: string, outline: string) {
  const [c, g] = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  if (num != null) {
    g.font = '800 200px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 14;
    g.strokeStyle = outline;
    g.strokeText(String(num), 128, 140);
    g.fillStyle = color;
    g.fillText(String(num), 128, 140);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Scrolling LED ribbon board text. */
export function ribbonTexture(text: string, fg: string, bg: string) {
  const [c, g] = canvas(2048, 64);
  g.fillStyle = bg;
  g.fillRect(0, 0, 2048, 64);
  g.font = '700 44px "Barlow Condensed", "Arial Narrow", sans-serif';
  g.fillStyle = fg;
  g.textBaseline = 'middle';
  const unit = `${text}   •   `;
  const w = g.measureText(unit).width;
  for (let x = 0; x < 2048; x += w) g.fillText(unit, x, 34);
  // LED dot mask
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 2048, 1);
  for (let x = 0; x < 2048; x += 4) g.fillRect(x, 0, 1, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
