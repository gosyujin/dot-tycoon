import { describe, expect, it } from 'vitest';
import { dotScore, glassesScore, GLASSES_MODEL } from '../src/glasses-model';

describe('glasses-model', () => {
  it('重みは埋め込みと同じ 1024 次元で、しきい値は有限の数', () => {
    expect(GLASSES_MODEL.w).toHaveLength(1024);
    expect(Number.isFinite(GLASSES_MODEL.threshold)).toBe(true);
    expect(Number.isFinite(GLASSES_MODEL.bias)).toBe(true);
    expect(GLASSES_MODEL.w.every(Number.isFinite)).toBe(true);
  });

  it('dotScore は内積 + バイアス', () => {
    expect(dotScore([1, 2, 3], [0.5, -1, 2], 0.25)).toBeCloseTo(0.5 - 2 + 6 + 0.25);
  });

  it('元画像と反転画像のスコアの平均を返す', () => {
    const w = new Array<number>(GLASSES_MODEL.w.length).fill(0);
    const a = new Array<number>(w.length).fill(0);
    const b = new Array<number>(w.length).fill(0);
    // 同じ重みで a と b を採点した平均になっていること
    for (let j = 0; j < w.length; j++) (a[j] = Math.sin(j)), (b[j] = Math.cos(j));
    const expected = (dotScore(a) + dotScore(b)) / 2;
    expect(glassesScore(a, b)).toBeCloseTo(expected, 10);
  });
});
