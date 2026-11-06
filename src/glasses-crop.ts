import type { Pt } from './features';

/**
 * メガネ分類器に渡すクロップ。両目の外側の端の間の距離(span)を基準に、
 * 目元を中心とする正方形を切り出して 224×224 にする。
 * mult: 一辺 = span × mult、dy: 中心を span × dy だけ下へずらす
 */
export const EYE_CROPS = {
  eyes15: { mult: 1.5, dy: 0.05 },
  eyes20: { mult: 2.0, dy: 0.1 },
  face24: { mult: 2.4, dy: 0.35 },
} as const;
export type CropName = keyof typeof EYE_CROPS;

export const CROP_SIZE = 224;

export function cropEyes(
  src: HTMLCanvasElement,
  landmarks: Pt[],
  rightOuter: number,
  leftOuter: number,
): Record<CropName, HTMLCanvasElement> {
  const W = src.width;
  const H = src.height;
  const r = { x: landmarks[rightOuter].x * W, y: landmarks[rightOuter].y * H };
  const l = { x: landmarks[leftOuter].x * W, y: landmarks[leftOuter].y * H };
  const cx = (r.x + l.x) / 2;
  const cy = (r.y + l.y) / 2;
  const span = Math.hypot(l.x - r.x, l.y - r.y);
  const out = {} as Record<CropName, HTMLCanvasElement>;
  for (const [name, { mult, dy }] of Object.entries(EYE_CROPS) as [CropName, (typeof EYE_CROPS)[CropName]][]) {
    const side = span * mult;
    const c = document.createElement('canvas');
    c.width = c.height = CROP_SIZE;
    const x = c.getContext('2d')!;
    x.fillStyle = '#808080';
    x.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
    x.drawImage(src, cx - side / 2, cy - side / 2 + dy * span, side, side, 0, 0, CROP_SIZE, CROP_SIZE);
    out[name] = c;
  }
  return out;
}
