import { darken, lighten, mix, pastel, saturate } from './color';
import type { Features, Fringe, GlassesStyle } from './types';

export const SIZE = 16;

/** 16×16 のドット絵。px は行優先、null は透明 */
export interface Grid {
  size: number;
  px: (string | null)[];
}

export const gridAt = (g: Grid, x: number, y: number): string | null => g.px[y * g.size + x];

/** 背景色を決める（null = 透明） */
export function resolveBackground(f: Features): string | null {
  switch (f.bgMode) {
    case 'transparent':
      return null;
    case 'hair':
      return mix(f.hairColor, '#ffffff', 0.82);
    default:
      return pastel(f.bgColor);
  }
}

type Span = readonly [y: number, x0: number, x1: number];

// 頭頂部のシルエット（リファレンスの erma / jemi / rim と同じ 16×16 の配置）
const CAP: Record<0 | 1 | 2, Span[]> = {
  0: [[2, 5, 10], [3, 4, 11], [4, 3, 12], [5, 3, 12]],
  1: [[1, 6, 9], [2, 4, 11], [3, 3, 12], [4, 3, 12], [5, 3, 12]],
  2: [[1, 5, 10], [2, 3, 12], [3, 2, 13], [4, 2, 13], [5, 2, 13]],
};

const SIDE_END = { bald: 0, buzz: 5, short: 7, medium: 10, long: 13 } as const;

/** 顔の横の髪（もみあげ〜サイドの髪）が終わる行 */
function sideEnd(f: Features): number {
  const base = SIDE_END[f.hairLength];
  // ボリュームが大きいと少し下まで広がる
  return base > 5 && f.hairVolume === 2 ? Math.min(14, base + 1) : base;
}

export function renderSprite(f: Features): Grid {
  const px: (string | null)[] = new Array(SIZE * SIZE).fill(null);
  const set = (x: number, y: number, c: string | null): void => {
    if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) px[y * SIZE + x] = c;
  };
  const row = (y: number, x0: number, x1: number, c: string | null): void => {
    for (let x = x0; x <= x1; x++) set(x, y, c);
  };
  const rect = (x: number, y: number, w: number, h: number, c: string | null): void => {
    for (let j = 0; j < h; j++) row(y + j, x, x + w - 1, c);
  };

  // ドット絵向けに少しだけ色を整える
  const skin = f.skinColor;
  const neck = darken(skin, 0.07);
  const hair = saturate(f.hairColor, 1.08);
  const clothes = saturate(f.clothesColor, 1.1);
  const bald = f.hairLength === 'bald';
  const buzz = f.hairLength === 'buzz';

  // 1. 背景
  const bg = resolveBackground(f);
  if (bg) rect(0, 0, SIZE, SIZE, bg);

  // 2. 肩（服）と首
  row(13, 4, 11, clothes);
  row(14, 2, 13, clothes);
  row(15, 2, 13, clothes);
  row(12, 7, 8, neck);

  // 3. 髪のかたまり（頭頂部＋顔の横）。坊主は肌色の頭
  const headColor = bald ? skin : hair;
  if (buzz) {
    for (const [y, a, b] of CAP[0]) if (y <= 4) row(y, a, b, headColor);
  } else {
    for (const [y, a, b] of CAP[bald ? 0 : f.hairVolume]) row(y, a, b, headColor);
  }
  if (!bald) {
    const end = sideEnd(f);
    const wide = f.hairVolume === 2 || (f.hairLength === 'long' && f.hairVolume === 1);
    for (let y = 5; y <= end; y++) {
      set(3, y, hair);
      set(12, y, hair);
      if (wide && y >= 6) {
        set(2, y, hair);
        set(13, y, hair);
      }
    }
  }

  // 4. 顔（肌）。おでこは前髪の種類に応じて出す
  rect(4, 6, 8, 5, skin);
  row(11, 5, 10, skin);
  const fringe: Fringe = buzz || bald ? 'none' : f.fringe;
  if (fringe === 'none') row(5, 4, 11, skin);
  else if (fringe === 'part') row(5, 7, 8, skin);
  else if (fringe === 'left') row(5, 9, 11, skin);
  else if (fringe === 'right') row(5, 4, 6, skin);
  // full: おでこは髪のまま
  if (fringe === 'full') row(6, 4, 11, hair);
  if (bald) {
    // 頭のツヤ
    set(6, 3, lighten(skin, 0.55));
    set(7, 3, lighten(skin, 0.55));
  }
  if (bald || buzz) {
    // 耳
    set(3, 7, skin);
    set(3, 8, skin);
    set(12, 7, skin);
    set(12, 8, skin);
  }

  // 5. 目・チーク・口
  drawEyes(set, f);
  if (f.blush && f.glasses === 'none') {
    const blush = mix(skin, '#ff6f8f', 0.55);
    set(5, 9, blush);
    set(10, 9, blush);
  }
  drawMouth(set, f);

  // 6. メガネ
  drawGlasses(set, f.glasses, f.glassesColor);

  return { size: SIZE, px };
}

type Setter = (x: number, y: number, c: string | null) => void;

function drawEyes(set: Setter, f: Features): void {
  if (f.glasses === 'sun') return; // サングラスは目を隠す
  const c = f.eyeColor;
  const g = f.glasses !== 'none';
  switch (f.eyes) {
    case 'wide':
      if (g) {
        for (const x of [6, 9]) {
          set(x, 7, c);
          set(x, 8, c);
        }
      } else {
        for (const x of [5, 9]) {
          set(x, 7, '#ffffff');
          set(x + 1, 7, c);
          set(x, 8, c);
          set(x + 1, 8, c);
        }
      }
      break;
    case 'closed':
      if (g) {
        set(6, 8, c);
        set(9, 8, c);
      } else {
        set(5, 8, c);
        set(6, 8, c);
        set(9, 8, c);
        set(10, 8, c);
      }
      break;
    case 'happy':
      if (g) {
        set(6, 8, c);
        set(9, 8, c);
      } else {
        set(6, 7, c);
        set(5, 8, c);
        set(9, 7, c);
        set(10, 8, c);
      }
      break;
    default:
      for (const x of [6, 9]) {
        set(x, 7, c);
        set(x, 8, c);
      }
  }
}

function drawMouth(set: Setter, f: Features): void {
  const c = f.lipColor;
  switch (f.mouth) {
    case 'smile':
      set(6, 10, c);
      set(9, 10, c);
      set(7, 11, c);
      set(8, 11, c);
      break;
    case 'grin':
      set(6, 10, c);
      set(9, 10, c);
      set(7, 10, '#ffffff');
      set(8, 10, '#ffffff');
      set(7, 11, c);
      set(8, 11, c);
      break;
    case 'open':
      set(7, 10, c);
      set(8, 10, c);
      set(7, 11, darken(c, 0.45));
      set(8, 11, darken(c, 0.45));
      break;
    default:
      set(7, 10, c);
      set(8, 10, c);
  }
}

function drawGlasses(set: Setter, style: GlassesStyle, color: string): void {
  if (style === 'none') return;
  if (style === 'sun') {
    for (let x = 5; x <= 10; x++) {
      set(x, 6, color);
      set(x, 7, darken(color, 0.25));
      set(x, 8, darken(color, 0.25));
    }
    set(5, 7, lighten(color, 0.45)); // レンズの反射
    set(8, 7, lighten(color, 0.45));
    set(4, 7, color);
    set(11, 7, color);
    return;
  }
  const round = style === 'round';
  // 左右のレンズ。目の中心は (6, 7-8) と (9, 7-8)
  for (const x0 of [5, 8]) {
    for (let y = 6; y <= 9; y++) {
      for (let x = x0; x <= x0 + 2; x++) {
        const interior = x === x0 + 1 && (y === 7 || y === 8);
        if (interior) continue;
        const corner = (x === x0 || x === x0 + 2) && (y === 6 || y === 9);
        if (round && corner) continue;
        set(x, y, color);
      }
    }
  }
  // テンプル（つる）
  set(4, 7, color);
  set(11, 7, color);
}
