import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveBackground, renderSprite, gridAt, SIZE, type Grid } from '../src/render';
import { DEFAULT_FEATURES, type Features } from '../src/types';

/** reference/*.svg（1行1rect形式）を Grid に読み戻す */
function loadReference(name: string): Grid {
  const svg = readFileSync(new URL(`../reference/${name}.svg`, import.meta.url), 'utf8');
  const px: (string | null)[] = new Array(SIZE * SIZE).fill(null);
  for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < w; i++) px[y * SIZE + x + i] = m[4];
  }
  return { size: SIZE, px };
}

/** 色ではなく「背景かどうか」だけを見たシルエット */
function silhouette(g: Grid, bg: string | null): string[] {
  const rows: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    let r = '';
    for (let x = 0; x < SIZE; x++) r += gridAt(g, x, y) === bg ? '.' : '#';
    rows.push(r);
  }
  return rows;
}

function diffCount(a: string[], b: string[]): number {
  let n = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (a[y][x] !== b[y][x]) n++;
  return n;
}

const base: Features = { ...DEFAULT_FEATURES, bgMode: 'hair' };

describe('renderSprite', () => {
  it('16x16 で、背景色が全面に敷かれる', () => {
    const g = renderSprite(base);
    expect(g.size).toBe(16);
    expect(g.px).toHaveLength(256);
    expect(gridAt(g, 0, 0)).toBe(resolveBackground(base));
  });

  it('透明背景では背景セルが null になる', () => {
    const g = renderSprite({ ...base, bgMode: 'transparent' });
    expect(gridAt(g, 0, 0)).toBeNull();
    expect(gridAt(g, 15, 0)).toBeNull();
    expect(gridAt(g, 8, 10)).not.toBeNull();
  });

  it('目は x=6,9 / 口は x=7,8 の位置（リファレンス準拠）', () => {
    const f = { ...base, eyes: 'open', mouth: 'neutral', glasses: 'none' } as const;
    const g = renderSprite(f);
    expect(gridAt(g, 6, 7)).toBe(f.eyeColor);
    expect(gridAt(g, 9, 8)).toBe(f.eyeColor);
    expect(gridAt(g, 7, 10)).toBe(f.lipColor);
    expect(gridAt(g, 8, 10)).toBe(f.lipColor);
  });

  it('メガネは目の周りを囲み、目はレンズの中に残る', () => {
    const f = { ...base, glasses: 'square', glassesColor: '#112233' } as const;
    const g = renderSprite(f);
    expect(gridAt(g, 5, 6)).toBe('#112233');
    expect(gridAt(g, 6, 9)).toBe('#112233');
    expect(gridAt(g, 6, 7)).toBe(f.eyeColor);
    expect(gridAt(g, 4, 7)).toBe('#112233'); // つる
    const round = renderSprite({ ...f, glasses: 'round' });
    expect(gridAt(round, 5, 6)).not.toBe('#112233'); // 丸型は角が欠ける
  });

  it('サングラスは目を隠す', () => {
    const g = renderSprite({ ...base, glasses: 'sun', glassesColor: '#222222' });
    expect(gridAt(g, 6, 7)).not.toBe(base.eyeColor);
  });

  it('髪の長さで、顔の横の髪が伸びる', () => {
    const short = renderSprite({ ...base, hairLength: 'short' });
    const long = renderSprite({ ...base, hairLength: 'long' });
    expect(gridAt(short, 3, 11)).not.toBe(base.hairColor);
    expect(gridAt(long, 3, 11)).not.toBeNull();
    expect(silhouette(long, resolveBackground(base)).join('')).not.toBe(
      silhouette(short, resolveBackground(base)).join(''),
    );
  });

  it('坊主は髪色ではなく肌色の頭になる', () => {
    const g = renderSprite({ ...base, hairLength: 'bald' });
    expect(gridAt(g, 4, 3)).toBe(base.skinColor);
  });

  // リファレンス3体の「形」を再現できるか（色は無視。差分セル数で緩く比較）
  const refs: [string, Partial<Features>, number][] = [
    ['jemi', { hairLength: 'short', fringe: 'part', eyes: 'happy', mouth: 'neutral' }, 14],
    ['rim', { hairLength: 'long', fringe: 'part', eyes: 'closed', mouth: 'neutral' }, 22],
    ['erma', { hairLength: 'short', fringe: 'left', eyes: 'open', mouth: 'neutral' }, 22],
  ];
  // reference/ は公開リポジトリには含めない(手元にあるときだけ検証する)
  const hasRefs = existsSync(new URL('../reference/jemi.svg', import.meta.url));
  for (const [name, patch, tolerance] of refs) {
    it.skipIf(!hasRefs)(`リファレンス ${name} に近い形を作れる（差分 ${tolerance} セル以内）`, () => {
      const ref = loadReference(name);
      const refBg = gridAt(ref, 0, 0);
      const g = renderSprite({ ...base, ...patch });
      const d = diffCount(silhouette(ref, refBg), silhouette(g, resolveBackground(base)));
      expect(d).toBeLessThanOrEqual(tolerance);
    });
  }
});
