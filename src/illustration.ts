// イラスト用: 人物セグメンテーションは実写で学習されていてイラストにはほぼ効かないので、
// 顔ランドマークで位置を決め、色の近さで「肌・髪・服・背景」に分けた代わりのマスクを作る。
// 出力は selfie_multiclass と同じクラス番号なので、extractFeatures をそのまま使える。
import { FACE_OVAL, LEFT_BROW, RIGHT_BROW, SEG } from './landmarks';
import type { ClassMask, PixelImage, Pt } from './features';

type RGB = [number, number, number];

const dist = (a: RGB, b: RGB): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** 外れ値に強い代表色（中央値 → 近い色だけで取り直す、を数回） */
function robustColor(samples: RGB[], radius = 40, iters = 3): RGB | null {
  if (!samples.length) return null;
  let c: RGB = [median(samples.map((s) => s[0])), median(samples.map((s) => s[1])), median(samples.map((s) => s[2]))];
  for (let i = 0; i < iters; i++) {
    const near = samples.filter((s) => dist(s, c) < radius);
    if (!near.length) break;
    c = [median(near.map((s) => s[0])), median(near.map((s) => s[1])), median(near.map((s) => s[2]))];
  }
  return c;
}

/** 量子化して最頻の色を求め、その近くの平均を返す */
function modeColor(samples: RGB[], step = 24, radius = 36): RGB | null {
  if (!samples.length) return null;
  const bins = new Map<number, number>();
  for (const [r, g, b] of samples) {
    const k = ((r / step) | 0) * 10000 + ((g / step) | 0) * 100 + ((b / step) | 0);
    bins.set(k, (bins.get(k) ?? 0) + 1);
  }
  let best = -1;
  let bestN = 0;
  for (const [k, n] of bins) if (n > bestN) (best = k), (bestN = n);
  const centre: RGB = [(((best / 10000) | 0) + 0.5) * step, ((((best / 100) | 0) % 100) + 0.5) * step, ((best % 100) + 0.5) * step];
  return robustColor(
    samples.filter((s) => dist(s, centre) < radius * 1.5),
    radius,
  );
}

function polyContains(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export interface IllustrationPalette {
  skin: RGB | null;
  hair: RGB | null;
  background: RGB[];
}

/** 画像の四辺の色のうち、広い面積を占めるもの（背景色の候補） */
export function borderColors(image: PixelImage): RGB[] {
  const { width: W, height: H, data } = image;
  const t = Math.max(2, Math.round(Math.min(W, H) * 0.02));
  const bins = new Map<number, { n: number; sum: RGB }>();
  let total = 0;
  const add = (x: number, y: number): void => {
    const o = (y * W + x) * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const e = bins.get(k) ?? { n: 0, sum: [0, 0, 0] as RGB };
    e.n++;
    e.sum[0] += r;
    e.sum[1] += g;
    e.sum[2] += b;
    bins.set(k, e);
    total++;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < t || y < t || x >= W - t || y >= H - t) add(x, y);
    }
  }
  return [...bins.values()]
    .filter((e) => e.n / total >= 0.1)
    .sort((a, b) => b.n - a.n)
    .slice(0, 4)
    .map((e) => [e.sum[0] / e.n, e.sum[1] / e.n, e.sum[2] / e.n] as RGB);
}

export function synthesizeMask(image: PixelImage, landmarks: Pt[]): { mask: ClassMask; palette: IllustrationPalette } {
  const { width: W, height: H, data } = image;
  const L = landmarks.map((p) => ({ x: p.x * W, y: p.y * H }));
  const oval = FACE_OVAL.map((i) => L[i]);
  const xs = oval.map((p) => p.x);
  const ys = oval.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const fw = Math.max(1, x1 - x0);
  const fh = Math.max(1, y1 - y0);
  const cx = (x0 + x1) / 2;
  const browY = Math.min(...[...RIGHT_BROW, ...LEFT_BROW].map((i) => L[i].y));

  const px = (x: number, y: number): RGB => {
    const ix = Math.min(W - 1, Math.max(0, Math.round(x)));
    const iy = Math.min(H - 1, Math.max(0, Math.round(y)));
    const o = (iy * W + ix) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const sampleRect = (ax: number, ay: number, bx: number, by: number, keep: (c: RGB, x: number, y: number) => boolean): RGB[] => {
    const out: RGB[] = [];
    const step = Math.max(1, Math.round(Math.max(W, H) / 300));
    for (let y = Math.max(0, Math.floor(ay)); y < Math.min(H, by); y += step) {
      for (let x = Math.max(0, Math.floor(ax)); x < Math.min(W, bx); x += step) {
        const c = px(x, y);
        if (keep(c, x, y)) out.push(c);
      }
    }
    return out;
  };

  const background = borderColors(image);
  const isBg = (c: RGB): number => (background.length ? Math.min(...background.map((b) => dist(c, b))) : Infinity);

  // 肌色: 頬〜口のあたり（目・口の色は外れ値として落とす）
  const skin = robustColor(sampleRect(cx - 0.3 * fw, y0 + 0.45 * fh, cx + 0.3 * fw, y0 + 0.8 * fh, () => true), 38);

  // 髪色: 頭の上〜生え際あたりで、肌でも背景でもない色の最頻値
  const hairSamples = skin
    ? sampleRect(cx - 1.0 * fw, y0 - 0.7 * fh, cx + 1.0 * fw, y0 + 0.35 * fh, (c) => dist(c, skin) > 48 && isBg(c) > 30)
    : [];
  const hair = hairSamples.length >= 20 ? modeColor(hairSamples) : null;

  const out = new Uint8Array(W * H);
  const skinTol = 42;
  const hairTol = 44;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = px(x, y);
      const dSkin = skin ? dist(c, skin) : Infinity;
      const dHair = hair ? dist(c, hair) : Infinity;
      const dBg = isBg(c);
      const nearAxis = Math.abs(x - cx);
      let cls: number = SEG.BACKGROUND;
      const inOval = x >= x0 && x <= x1 && y >= y0 && y <= y1 && polyContains(oval, x, y);
      if (inOval) {
        // 眉より上で髪色なら前髪、それ以外は顔（目・口の色も顔として扱う）
        cls = y < browY - 0.02 * fh && dHair < hairTol && dHair < dSkin ? SEG.HAIR : SEG.FACE_SKIN;
      } else if (dBg < 26 && dBg <= dSkin) {
        cls = SEG.BACKGROUND;
      } else if (dSkin < skinTol && y >= browY && y <= y1 && nearAxis < 0.75 * fw) {
        cls = SEG.FACE_SKIN; // 耳・輪郭の外側の肌
      } else if (dSkin < skinTol && y > y1 - 0.15 * fh && nearAxis < 1.4 * fw) {
        cls = SEG.BODY_SKIN;
      } else if (y < y1 - 0.15 * fh && nearAxis < 1.7 * fw && y > y0 - 1.2 * fh) {
        // 頭の高さにある、肌でも背景でもない色は髪（ハイライト・陰影・リボンも頭のシルエットとして髪に含める）
        cls = SEG.HAIR;
      } else if (dHair < hairTol + 12 && nearAxis < 1.4 * fw && y < y1 + 1.8 * fh) {
        cls = SEG.HAIR; // あごより下に垂れる髪
      } else if (y > y1 - 0.1 * fh && nearAxis < 2.6 * fw && dBg >= 26) {
        cls = SEG.CLOTHES;
      }
      out[y * W + x] = cls;
    }
  }
  return { mask: { data: out, width: W, height: H }, palette: { skin, hair, background } };
}

/** 顔の楕円の内側のうち、肌クラスになっている割合（低ければセグメンテーションが効いていない） */
export function ovalSkinFraction(mask: ClassMask, landmarks: Pt[]): number {
  const oval = FACE_OVAL.map((i) => landmarks[i]);
  const xs = oval.map((p) => p.x);
  const ys = oval.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  let hit = 0;
  let total = 0;
  const n = 24;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + ((i + 0.5) / n) * (x1 - x0);
      // 目より下の頬〜顎を見る（前髪や目の影響を避ける）
      const y = y0 + (0.5 + 0.45 * ((j + 0.5) / n)) * (y1 - y0);
      if (!polyContains(oval, x, y)) continue;
      const mx = Math.min(mask.width - 1, Math.floor(x * mask.width));
      const my = Math.min(mask.height - 1, Math.floor(y * mask.height));
      const cls = mask.data[my * mask.width + mx];
      total++;
      if (cls === SEG.FACE_SKIN || cls === SEG.BODY_SKIN) hit++;
    }
  }
  return total ? hit / total : 0;
}
