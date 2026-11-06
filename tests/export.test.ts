import { describe, expect, it } from 'vitest';
import { gridToGifBytes, gridToSvg } from '../src/export';
import { renderSprite, SIZE } from '../src/render';
import { DEFAULT_FEATURES } from '../src/types';

describe('gridToSvg', () => {
  const grid = renderSprite({ ...DEFAULT_FEATURES, bgMode: 'hair' });

  it('viewBox はドット数、crispEdges、rect は行内で同色を結合する', () => {
    const svg = gridToSvg(grid);
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    // 1行目は全面が同じ背景色 → 幅16の rect が1つ
    expect(svg).toMatch(/<rect x="0" y="0" width="16" height="1" fill="#[0-9a-f]{6}"\/>/);
    expect((svg.match(/<rect /g) ?? []).length).toBeLessThan(SIZE * SIZE);
  });

  it('透明セルは出力しない', () => {
    const svg = gridToSvg(renderSprite({ ...DEFAULT_FEATURES, bgMode: 'transparent' }));
    expect(svg).not.toMatch(/<rect x="0" y="0" width="16"/);
  });

  it('scale を指定すると width/height が付く', () => {
    expect(gridToSvg(grid, { scale: 8 })).toContain('width="128" height="128"');
  });

  it('SVG をピクセルに戻すと元の Grid と一致する', () => {
    const svg = gridToSvg(grid);
    const px: (string | null)[] = new Array(SIZE * SIZE).fill(null);
    for (const m of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"/g)) {
      for (let i = 0; i < Number(m[3]); i++) px[Number(m[2]) * SIZE + Number(m[1]) + i] = m[4];
    }
    expect(px).toEqual(grid.px);
  });
});

describe('gridToGifBytes', () => {
  it('GIF89a のヘッダとサイズを持つ', () => {
    const grid = renderSprite({ ...DEFAULT_FEATURES, bgMode: 'transparent' });
    const bytes = gridToGifBytes(grid, 4);
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(bytes[6] | (bytes[7] << 8)).toBe(64); // 幅
    expect(bytes[8] | (bytes[9] << 8)).toBe(64); // 高さ
    expect(bytes[bytes.length - 1]).toBe(0x3b); // trailer
  });
});
