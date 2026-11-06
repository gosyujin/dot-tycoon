import { describe, expect, it } from 'vitest';
import { auc, fitRidge, score, thresholdAtSpecificity } from '../src/train/ridge';

// 2 次元の 2 クラス（x0 が効く）+ ノイズ次元
function makeData(n: number, seed = 1): { X: Float32Array[]; y: number[] } {
  let s = seed;
  const rnd = (): number => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5;
  const X: Float32Array[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const label = i % 2 ? 1 : -1;
    X.push(Float32Array.from([label * 1.0 + rnd() * 0.8, rnd(), rnd(), rnd()]));
    y.push(label);
  }
  return { X, y };
}

describe('ridge', () => {
  it('分離できるデータを学習できる', () => {
    const tr = makeData(80, 1);
    const te = makeData(80, 99);
    const m = fitRidge(tr.X, tr.y, 0.1);
    const scores = te.X.map((x) => score(m, x));
    expect(auc(scores, te.y)).toBeGreaterThan(0.97);
    expect(scores.filter((v, i) => (v > 0 ? 1 : -1) === te.y[i]).length / te.y.length).toBeGreaterThan(0.9);
  });

  it('重みは効いている次元（x0）が最大', () => {
    const tr = makeData(100, 3);
    const m = fitRidge(tr.X, tr.y, 0.1);
    const abs = m.w.map(Math.abs);
    expect(abs.indexOf(Math.max(...abs))).toBe(0);
  });

  it('auc: 完全分離=1、逆=0、同点=0.5', () => {
    expect(auc([1, 2, 3, 4], [-1, -1, 1, 1])).toBe(1);
    expect(auc([4, 3, 2, 1], [-1, -1, 1, 1])).toBe(0);
    expect(auc([1, 1, 1, 1], [-1, -1, 1, 1])).toBeCloseTo(0.5);
  });

  it('特異度を指定したしきい値と再現率', () => {
    const scores = [...Array.from({ length: 20 }, (_, i) => i / 20), 0.9, 0.95, 1.1, 1.2];
    const labels = [...Array(20).fill(-1), 1, 1, 1, 1];
    const t = thresholdAtSpecificity(scores, labels, 0.95);
    expect(t.recall).toBeGreaterThanOrEqual(0.5);
  });
});
