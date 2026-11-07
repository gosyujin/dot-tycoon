import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../src/features';
import { ovalSkinFraction, synthesizeMask } from '../src/illustration';
import { SEG } from '../src/landmarks';
import { colorDistance, hexToRgb } from '../src/color';
import { COLORS, H, W, makeFace } from './synthetic';

// 合成の「イラスト」（べた塗りの顔・髪・服）で、色分けマスクが顔・髪・背景を分けられるか
describe('illustration mask', () => {
  const face = makeFace({ hair: 'long' });
  const { mask } = synthesizeMask(face.image, face.landmarks);
  const at = (x: number, y: number): number => mask.data[Math.round(y) * mask.width + Math.round(x)];

  it('顔の中は顔、画像の隅は背景', () => {
    expect(at(200, 260)).toBe(SEG.FACE_SKIN);
    expect(at(5, 5)).toBe(SEG.BACKGROUND);
    expect(at(W - 5, 5)).toBe(SEG.BACKGROUND);
  });

  it('頭のてっぺんと顔の横は髪', () => {
    expect(at(200, 128)).toBe(SEG.HAIR);
    expect(at(112, 300)).toBe(SEG.HAIR);
  });

  it('色分けしたマスクで、肌・髪・服の色と髪の長さを読み取れる', () => {
    const f = extractFeatures({ ...face, mask }).features;
    const near = (hex: string, rgb: readonly number[]): number => colorDistance(hexToRgb(hex), [rgb[0], rgb[1], rgb[2]]);
    expect(near(f.skinColor, COLORS.skin)).toBeLessThan(40);
    expect(near(f.hairColor, COLORS.hair)).toBeLessThan(40);
    expect(f.hairLength === 'medium' || f.hairLength === 'long').toBe(true);
  });

  it('セグメンテーションが顔を肌と認識していれば、肌の割合が高い', () => {
    expect(ovalSkinFraction(face.mask, face.landmarks)).toBeGreaterThan(0.8);
  });

  it('セグメンテーションが背景としか認識していなければ、肌の割合は低い（イラスト扱いになる）', () => {
    const blank = { data: new Uint8Array(W * H), width: W, height: H };
    expect(ovalSkinFraction(blank, face.landmarks)).toBeLessThan(0.1);
  });
});
