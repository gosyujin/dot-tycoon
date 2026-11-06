import { describe, expect, it } from 'vitest';
import { hexToRgb, colorDistance } from '../src/color';
import { expressionFromBlendshapes, extractFeatures, modeColor, trimmedMean } from '../src/features';
import { COLORS, makeFace } from './synthetic';

const near = (hex: string, rgb: readonly number[], tol = 12): boolean => colorDistance(hexToRgb(hex), rgb as [number, number, number]) <= tol;

describe('trimmedMean / modeColor', () => {
  it('外れ値（ハイライト）に引っ張られない', () => {
    const colors = [...Array(20).fill([100, 100, 100]), [255, 255, 255], [0, 0, 0]] as [number, number, number][];
    expect(trimmedMean(colors, 0.15)).toEqual([100, 100, 100]);
  });
  it('サンプルが少なければ null', () => {
    expect(trimmedMean([[1, 2, 3]], 0.1, 5)).toBeNull();
    expect(modeColor([], 1)).toBeNull();
  });
  it('最頻の色を返す', () => {
    const c = modeColor([...Array(10).fill([200, 30, 30]), ...Array(3).fill([10, 10, 10])] as [number, number, number][]);
    expect(c && colorDistance(c, [200, 30, 30])).toBeLessThan(5);
  });
});

describe('expressionFromBlendshapes', () => {
  it('何もなければ 無表情・ひらいた目', () => {
    const r = expressionFromBlendshapes({});
    expect(r.eyes).toBe('open');
    expect(r.mouth).toBe('neutral');
  });
  it('笑顔の強さで 口が smile → grin（歯が見えるのは口が少し開いているときだけ）', () => {
    expect(expressionFromBlendshapes({ mouthSmileLeft: 0.4, mouthSmileRight: 0.4 }).mouth).toBe('smile');
    expect(expressionFromBlendshapes({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.12 }).mouth).toBe('grin');
    // 口を閉じた強い笑顔は grin ではなく smile
    expect(expressionFromBlendshapes({ mouthSmileLeft: 0.8, mouthSmileRight: 0.8, jawOpen: 0.02 }).mouth).toBe('smile');
  });
  it('口が大きく開いていれば open（笑顔より優先）', () => {
    expect(expressionFromBlendshapes({ jawOpen: 0.6, mouthSmileLeft: 0.9, mouthSmileRight: 0.9 }).mouth).toBe('open');
  });
  it('笑顔＋目を細めると にっこり目、まばたきなら とじ目', () => {
    expect(expressionFromBlendshapes({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7, eyeSquintLeft: 0.5, eyeSquintRight: 0.5 }).eyes).toBe('happy');
    expect(expressionFromBlendshapes({ eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }).eyes).toBe('closed');
    expect(expressionFromBlendshapes({ eyeWideLeft: 0.6, eyeWideRight: 0.6 }).eyes).toBe('wide');
  });
});

describe('extractFeatures（合成の顔）', () => {
  it('肌・髪・服・背景の色を読み取る', () => {
    const { features: f, debug } = extractFeatures(makeFace({ hair: 'short' }));
    expect(near(f.skinColor, COLORS.skin)).toBe(true);
    expect(near(f.hairColor, COLORS.hair)).toBe(true);
    expect(near(f.clothesColor, COLORS.clothes)).toBe(true);
    expect(near(f.bgColor, COLORS.bg)).toBe(true);
    expect(debug.fallbacks).toEqual([]);
  });

  it('髪の長さ: 短い / 長い / なし', () => {
    expect(extractFeatures(makeFace({ hair: 'short' })).features.hairLength).toBe('short');
    expect(extractFeatures(makeFace({ hair: 'long' })).features.hairLength).toBe('long');
    expect(extractFeatures(makeFace({ hair: 'none' })).features.hairLength).toBe('bald');
  });

  it('前髪: なし / ぱっつん / 片側', () => {
    expect(extractFeatures(makeFace({ fringeCover: 0 })).features.fringe).toBe('none');
    expect(extractFeatures(makeFace({ fringeCover: 1 })).features.fringe).toBe('full');
    expect(extractFeatures(makeFace({ fringeCover: 1, fringeLeftOnly: true })).features.fringe).toBe('left');
  });

  it('頭頂の髪が高いとボリューム大', () => {
    expect(extractFeatures(makeFace({ topHeight: 0.15 })).features.hairVolume).toBe(0);
    expect(extractFeatures(makeFace({ topHeight: 0.9 })).features.hairVolume).toBe(1);
  });

  it('目のまわりが「その他」クラスならサングラス', () => {
    const f = extractFeatures(makeFace({ sunglasses: true })).features;
    expect(f.glasses).toBe('sun');
    expect(extractFeatures(makeFace({})).features.glasses).toBe('none');
  });

  it('表情は blendshapes から決まる', () => {
    const f = extractFeatures(makeFace({ blendshapes: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, jawOpen: 0.1 } })).features;
    expect(f.mouth).toBe('grin');
  });

  it('服が見えない（髪色からの補完）とき、fallbacks に記録される', () => {
    const input = makeFace({});
    // 服クラスを背景に変える
    for (let i = 0; i < input.mask.data.length; i++) if (input.mask.data[i] === 4) (input.mask.data as Uint8Array)[i] = 0;
    const { debug, features } = extractFeatures(input);
    expect(debug.fallbacks).toContain('clothes');
    expect(features.clothesColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});
