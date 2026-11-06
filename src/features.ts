import { clamp, darken, hexToRgb, lighten, luminance, mix, rgbToHex, saturate, type RGB } from './color';
import {
  CHIN,
  FACE_OVAL,
  FOREHEAD_MID,
  FOREHEAD_TOP,
  LEFT_BROW,
  LEFT_CHEEK,
  LEFT_EYE,
  LEFT_EYE_INNER,
  LEFT_EYE_OUTER,
  LEFT_IRIS_CENTER,
  LEFT_IRIS_RING,
  LIPS_INNER,
  LIPS_OUTER,
  RIGHT_BROW,
  RIGHT_CHEEK,
  RIGHT_EYE,
  RIGHT_EYE_INNER,
  RIGHT_EYE_OUTER,
  RIGHT_IRIS_CENTER,
  RIGHT_IRIS_RING,
  SEG,
} from './landmarks';
import {
  DEFAULT_FEATURES,
  type EyeStyle,
  type Features,
  type Fringe,
  type GlassesStyle,
  type HairLength,
  type HairVolume,
  type Hex,
  type MouthStyle,
} from './types';

export interface PixelImage {
  /** RGBA */
  data: ArrayLike<number>;
  width: number;
  height: number;
}
export interface ClassMask {
  /** ピクセルごとの SEG クラス */
  data: ArrayLike<number>;
  width: number;
  height: number;
}
export interface Pt {
  x: number;
  y: number;
}

export interface AnalysisInput {
  image: PixelImage;
  mask: ClassMask;
  /** 正規化座標 (0..1) の顔ランドマーク（468点 + 虹彩10点） */
  landmarks: Pt[];
  blendshapes: Record<string, number>;
}

export interface AnalysisDebug {
  faceBox: { x: number; y: number; w: number; h: number };
  hair: {
    areaRatio: number;
    topExtent: number;
    topThickness: number;
    sideExtent: [number, number];
    covMouth: number;
    covJaw: number;
    covBelow: number;
    foreheadLeft: number;
    foreheadRight: number;
  };
  glassesScore: number;
  expression: { smile: number; jawOpen: number; blink: number; squint: number; wide: number };
  /** 写真から取れず、既定値で補った項目 */
  fallbacks: string[];
}

export interface AnalysisResult {
  features: Features;
  debug: AnalysisDebug;
}

// ---------------------------------------------------------------- 小さな道具

function polyContains(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bounds(pts: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** 輝度の両端を捨てた平均（ハイライト・影の影響を減らす） */
export function trimmedMean(colors: RGB[], trim = 0.15, minCount = 1): RGB | null {
  if (colors.length < minCount || colors.length === 0) return null;
  const sorted = [...colors].sort((a, b) => luminance(a) - luminance(b));
  const cut = Math.floor(sorted.length * trim);
  const mid = sorted.slice(cut, sorted.length - cut);
  const use = mid.length ? mid : sorted;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of use) {
    r += c[0];
    g += c[1];
    b += c[2];
  }
  return [r / use.length, g / use.length, b / use.length];
}

/** 最頻の色（各チャンネル16段階に丸めたビンの最大のもの）の平均 */
export function modeColor(colors: RGB[], minCount = 1): RGB | null {
  if (colors.length < minCount || colors.length === 0) return null;
  const bins = new Map<number, RGB[]>();
  for (const c of colors) {
    const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
    const arr = bins.get(key);
    if (arr) arr.push(c);
    else bins.set(key, [c]);
  }
  let best: RGB[] = [];
  for (const arr of bins.values()) if (arr.length > best.length) best = arr;
  return trimmedMean(best, 0);
}

// ---------------------------------------------------------------- 表情

export function expressionFromBlendshapes(b: Record<string, number>): {
  eyes: EyeStyle;
  mouth: MouthStyle;
  metrics: AnalysisDebug['expression'];
} {
  const v = (k: string): number => b[k] ?? 0;
  const smile = (v('mouthSmileLeft') + v('mouthSmileRight')) / 2;
  const jawOpen = v('jawOpen');
  const blink = (v('eyeBlinkLeft') + v('eyeBlinkRight')) / 2;
  const squint = (v('eyeSquintLeft') + v('eyeSquintRight')) / 2;
  const wide = (v('eyeWideLeft') + v('eyeWideRight')) / 2;

  let mouth: MouthStyle = 'neutral';
  if (jawOpen > 0.35) mouth = 'open';
  // 歯を見せる笑い（grin）は、強い笑顔で、かつ口が少し開いているときだけ
  else if (smile > 0.55 && jawOpen > 0.07) mouth = 'grin';
  else if (smile > 0.25) mouth = 'smile';

  let eyes: EyeStyle = 'open';
  if (blink > 0.55) eyes = 'closed';
  else if (smile > 0.45 && squint > 0.3) eyes = 'happy';
  else if (wide > 0.4) eyes = 'wide';

  return { eyes, mouth, metrics: { smile, jawOpen, blink, squint, wide } };
}

// ---------------------------------------------------------------- 本体

export function extractFeatures(input: AnalysisInput): AnalysisResult {
  const { image, mask } = input;
  const W = image.width;
  const H = image.height;
  const L: Pt[] = input.landmarks.map((p) => ({ x: p.x * W, y: p.y * H }));
  const fallbacks: string[] = [];

  const rgbAt = (x: number, y: number): RGB => {
    const ix = clamp(Math.round(x), 0, W - 1);
    const iy = clamp(Math.round(y), 0, H - 1);
    const o = (iy * W + ix) * 4;
    return [image.data[o], image.data[o + 1], image.data[o + 2]];
  };
  const clsAt = (x: number, y: number): number => {
    const mx = clamp(Math.floor((x / W) * mask.width), 0, mask.width - 1);
    const my = clamp(Math.floor((y / H) * mask.height), 0, mask.height - 1);
    return mask.data[my * mask.width + mx];
  };
  const inImage = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;
  const pick = (idx: number[]): Pt[] => idx.map((i) => L[i]);

  /** 矩形内（domain を満たす点だけを母数にする）で predicate を満たす割合 */
  const fraction = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    pred: (x: number, y: number) => boolean,
    domain?: (x: number, y: number) => boolean,
  ): number => {
    const step = Math.max(1, Math.round(Math.max(W, H) / 400));
    let hit = 0;
    let total = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y += step) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x += step) {
        if (domain && !domain(x, y)) continue;
        total++;
        if (pred(x, y)) hit++;
      }
    }
    return total ? hit / total : 0;
  };
  const isHair = (x: number, y: number): boolean => clsAt(x, y) === SEG.HAIR;
  const hairFrac = (x0: number, y0: number, x1: number, y1: number): number => fraction(x0, y0, x1, y1, isHair);

  // ---- 顔の幾何
  const oval = pick(FACE_OVAL);
  const ob = bounds(oval);
  const faceLeft = ob.x0;
  const faceRight = ob.x1;
  const faceTop = L[FOREHEAD_TOP].y;
  const chinY = L[CHIN].y;
  const fw = faceRight - faceLeft;
  const fh = chinY - faceTop;
  const cx = (faceLeft + faceRight) / 2;
  const rEye = pick(RIGHT_EYE);
  const lEye = pick(LEFT_EYE);
  const center = (pts: Pt[]): Pt => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  });
  const rc = center(rEye);
  const lc = center(lEye);
  const eyeY = (rc.y + lc.y) / 2;
  const mouthY = (L[13].y + L[14].y) / 2;
  const browTop = Math.min(bounds(pick(RIGHT_BROW)).y0, bounds(pick(LEFT_BROW)).y0);

  // ---- 色：肌
  const excluded = [rEye, lEye, pick(RIGHT_BROW), pick(LEFT_BROW), pick(LIPS_OUTER)].map((p) => ({ poly: p, b: bounds(p) }));
  const skinSamples: RGB[] = [];
  for (let y = Math.floor(ob.y0); y <= ob.y1; y += 2) {
    for (let x = Math.floor(ob.x0); x <= ob.x1; x += 2) {
      if (!inImage(x, y) || clsAt(x, y) !== SEG.FACE_SKIN) continue;
      if (!polyContains(oval, x, y)) continue;
      if (excluded.some((e) => x >= e.b.x0 && x <= e.b.x1 && y >= e.b.y0 && y <= e.b.y1 && polyContains(e.poly, x, y))) continue;
      skinSamples.push(rgbAt(x, y));
    }
  }
  let skin = trimmedMean(skinSamples, 0.2, 40);
  if (!skin) {
    fallbacks.push('skin');
    const patch: RGB[] = [];
    for (const i of [RIGHT_CHEEK, LEFT_CHEEK, FOREHEAD_MID]) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) patch.push(rgbAt(L[i].x + dx, L[i].y + dy));
    }
    skin = trimmedMean(patch, 0.2) ?? hexToRgb(DEFAULT_FEATURES.skinColor);
  }
  const skinHex = rgbToHex(skin);

  // ---- 髪
  const hx0 = faceLeft - 0.7 * fw;
  const hx1 = faceRight + 0.7 * fw;
  const hy0 = faceTop - 0.9 * fh;
  const hy1 = chinY + 1.2 * fh;
  const hairSamples: RGB[] = [];
  let hairCount = 0;
  for (let y = Math.max(0, Math.floor(hy0)); y < Math.min(H, hy1); y += 2) {
    for (let x = Math.max(0, Math.floor(hx0)); x < Math.min(W, hx1); x += 2) {
      if (clsAt(x, y) === SEG.HAIR) {
        hairCount++;
        hairSamples.push(rgbAt(x, y));
      }
    }
  }
  const areaRatio = (hairCount * 4) / Math.max(1, fw * fh);
  const hairRgb = trimmedMean(hairSamples, 0.15, 30);

  // 頭頂のボリューム: 顔の上端(ランドマーク10)から上へ、髪が連続する範囲
  const rowStep = Math.max(1, Math.round(fh / 80));
  let yTop = faceTop;
  let yStart = faceTop;
  let started = false;
  for (let y = faceTop + 0.05 * fh; y >= faceTop - 1.2 * fh; y -= rowStep) {
    const f = hairFrac(cx - 0.3 * fw, y, cx + 0.3 * fw, y + rowStep);
    if (f > 0.5) {
      if (!started) {
        started = true;
        yStart = y;
      }
      yTop = y;
    } else if (started) {
      break;
    } else if (y < faceTop - 0.4 * fh) {
      break;
    }
  }
  const topExtent = started ? clamp((faceTop - yTop) / fh, 0, 1.5) : 0;
  const topThickness = started ? clamp((yStart - yTop) / fh, 0, 1.5) : 0;

  // 横への広がり（アフロ・ふんわり系）
  const lateral = (dir: -1 | 1): number => {
    const edge = dir < 0 ? faceLeft : faceRight;
    const y0 = eyeY - 0.1 * fh;
    const y1 = eyeY + 0.25 * fh;
    const colW = Math.max(1, Math.round(fw / 60));
    let far = 0;
    let seen = false;
    for (let d = 0; d <= 1.2 * fw; d += colW) {
      const xa = edge + dir * d;
      const f = hairFrac(Math.min(xa, xa + dir * colW), y0, Math.max(xa, xa + dir * colW), y1);
      if (f > 0.5) {
        seen = true;
        far = d;
      } else if (seen) break;
      else if (d > 0.3 * fw) break;
    }
    return far / fw;
  };
  const sideExtent: [number, number] = [lateral(-1), lateral(1)];

  // 髪の長さ: 顔の左右の外側に、どの高さまで髪があるか
  const sideCov = (yc: number, half: number): number => {
    const y0 = yc - half;
    const y1 = yc + half;
    const l = hairFrac(faceLeft - 0.3 * fw, y0, faceLeft + 0.03 * fw, y1);
    const r = hairFrac(faceRight - 0.03 * fw, y0, faceRight + 0.3 * fw, y1);
    return (l + r) / 2;
  };
  const covMouth = sideCov(mouthY, 0.08 * fh);
  const covJaw = sideCov(chinY - 0.05 * fh, 0.08 * fh);
  const covBelow = sideCov(chinY + 0.28 * fh, 0.16 * fh);

  let hairLength: HairLength;
  if (areaRatio < 0.06 || (!started && areaRatio < 0.2)) hairLength = 'bald';
  else if (topThickness < 0.07 && areaRatio < 0.5) hairLength = 'buzz';
  else if (covBelow > 0.3) hairLength = 'long';
  else if (covJaw > 0.3 || covMouth > 0.45) hairLength = 'medium';
  else hairLength = 'short';

  let hairVolume: HairVolume = 0;
  if (topExtent > 0.45) hairVolume = 1;
  if (Math.min(sideExtent[0], sideExtent[1]) > 0.4) hairVolume = 2;

  // 前髪: おでこ領域（顔の上端〜眉の上）を髪が覆っている割合を左右別に見る
  const fy0 = faceTop + 0.03 * fh;
  const fy1 = Math.max(fy0 + 1, browTop);
  // 顔の輪郭の内側だけを見る（輪郭の外＝こめかみ上の髪は前髪ではない）
  const inOval = (x: number, y: number): boolean => polyContains(oval, x, y);
  const foreheadLeft = fraction(cx - 0.42 * fw, fy0, cx, fy1, isHair, inOval);
  const foreheadRight = fraction(cx, fy0, cx + 0.42 * fw, fy1, isHair, inOval);
  const fMean = (foreheadLeft + foreheadRight) / 2;
  let fringe: Fringe;
  if (fMean < 0.12) fringe = 'none';
  else if (fMean > 0.65 && Math.abs(foreheadLeft - foreheadRight) < 0.3) fringe = 'full';
  else if (Math.abs(foreheadLeft - foreheadRight) > 0.35) fringe = foreheadLeft > foreheadRight ? 'left' : 'right';
  else fringe = 'part';

  let hairHex: Hex;
  if (hairRgb) hairHex = rgbToHex(hairRgb);
  else {
    fallbacks.push('hair');
    hairHex = DEFAULT_FEATURES.hairColor;
  }

  // ---- 目の色（虹彩）
  let eyeColor: Hex = DEFAULT_FEATURES.eyeColor;
  if (L.length >= 478) {
    const irisSamples: RGB[] = [];
    for (const [c, ring] of [
      [RIGHT_IRIS_CENTER, RIGHT_IRIS_RING],
      [LEFT_IRIS_CENTER, LEFT_IRIS_RING],
    ] as const) {
      const ctr = L[c];
      const r = ring.reduce((s, i) => s + Math.hypot(L[i].x - ctr.x, L[i].y - ctr.y), 0) / ring.length;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.hypot(dx, dy) > r * 0.65) continue;
          const col = rgbAt(ctr.x + dx, ctr.y + dy);
          const hi = luminance(col) > 190; // 映り込み（キャッチライト）を除く
          if (!hi) irisSamples.push(col);
        }
      }
    }
    const iris = trimmedMean(irisSamples, 0.2, 6);
    if (iris) {
      const s = rgbToHex(iris);
      eyeColor =
        luminance(iris) < 95
          ? mix(DEFAULT_FEATURES.eyeColor, darken(s, 0.2), 0.35) // 暗い瞳はほぼ既定色（少しだけ色味）
          : saturate(darken(s, 0.4), 1.25); // 青・緑・明るい茶などは色味を出す
    } else fallbacks.push('eyeColor');
  } else fallbacks.push('eyeColor');

  // ---- 唇の色
  let lipColor: Hex = DEFAULT_FEATURES.lipColor;
  {
    const outer = pick(LIPS_OUTER);
    const inner = pick(LIPS_INNER);
    const lb = bounds(outer);
    const lipSamples: RGB[] = [];
    for (let y = Math.floor(lb.y0); y <= lb.y1; y++) {
      for (let x = Math.floor(lb.x0); x <= lb.x1; x++) {
        if (inImage(x, y) && polyContains(outer, x, y) && !polyContains(inner, x, y)) lipSamples.push(rgbAt(x, y));
      }
    }
    const lip = trimmedMean(lipSamples, 0.2, 10);
    if (lip) {
      let c = mix(rgbToHex(lip), DEFAULT_FEATURES.lipColor, 0.45);
      // 肌より十分暗くして、口が見えるようにする
      if (luminance(hexToRgb(c)) > luminance(skin) - 25) c = darken(c, 0.25);
      lipColor = c;
    } else fallbacks.push('lipColor');
  }

  // ---- 服
  const clothesSamples: RGB[] = [];
  for (let y = Math.max(0, Math.floor(chinY - 0.05 * fh)); y < H; y += 3) {
    for (let x = Math.max(0, Math.floor(faceLeft - 1.5 * fw)); x < Math.min(W, faceRight + 1.5 * fw); x += 3) {
      if (clsAt(x, y) === SEG.CLOTHES) clothesSamples.push(rgbAt(x, y));
    }
  }
  const clothesRgb = clothesSamples.length * 9 > 0.15 * fw * fh ? modeColor(clothesSamples, 20) : null;
  let clothesHex: Hex;
  if (clothesRgb) clothesHex = rgbToHex(clothesRgb);
  else {
    fallbacks.push('clothes');
    clothesHex = lighten(hairHex, 0.35);
  }

  // ---- 背景
  const bgSamples: RGB[] = [];
  const bgStep = Math.max(2, Math.round(Math.max(W, H) / 200));
  for (let y = 0; y < H; y += bgStep) {
    for (let x = 0; x < W; x += bgStep) if (clsAt(x, y) === SEG.BACKGROUND) bgSamples.push(rgbAt(x, y));
  }
  const bgRgb = bgSamples.length > ((W / bgStep) * (H / bgStep)) * 0.02 ? modeColor(bgSamples, 20) : null;
  let bgHex: Hex;
  if (bgRgb) bgHex = rgbToHex(bgRgb);
  else {
    fallbacks.push('bg');
    bgHex = mix(hairHex, '#ffffff', 0.82);
  }

  // ---- 表情
  const expr = expressionFromBlendshapes(input.blendshapes);

  // ---- サングラス
  const gl = detectSunglasses({ L, rgbAt, clsAt, rEye, lEye });

  const features: Features = {
    hairColor: hairHex,
    skinColor: skinHex,
    eyeColor,
    lipColor,
    clothesColor: clothesHex,
    bgColor: bgHex,
    bgMode: 'photo',
    hairLength,
    hairVolume,
    fringe,
    eyes: expr.eyes,
    mouth: expr.mouth,
    blush: true,
    glasses: gl.style,
    glassesColor: gl.color,
  };

  return {
    features,
    debug: {
      faceBox: { x: faceLeft, y: faceTop, w: fw, h: fh },
      hair: {
        areaRatio,
        topExtent,
        topThickness,
        sideExtent,
        covMouth,
        covJaw,
        covBelow,
        foreheadLeft,
        foreheadRight,
      },
      glassesScore: gl.score,
      expression: expr.metrics,
      fallbacks,
    },
  };
}

// ---------------------------------------------------------------- サングラス検出
//
// セグメンテーション（selfie_multiclass）の「その他 = アクセサリ」クラスが、目のまわりを
// どれだけ占めているかを見る。検証した画像では、サングラスありは 0.57〜0.90、なしは 0.07 以下
// と大きく離れていた。
//
// ※ 透明レンズの通常のメガネは、このクラスにほとんど反応しない（0.02〜0.22）。
//   色の線を探す方法や小型CLIPでも誤検出なしでは見分けられなかったため、自動判定せず、
//   UI で手動選択にしている（誤ってメガネを付けるより安全）。

interface SunglassesCtx {
  L: Pt[];
  rgbAt: (x: number, y: number) => RGB;
  clsAt: (x: number, y: number) => number;
  rEye: Pt[];
  lEye: Pt[];
}

export const SUNGLASSES_TUNING = {
  /** 両目まわりの「その他」の割合の平均 */
  threshold: 0.3,
  /** 片目でもこれ以上は必要 */
  minEach: 0.2,
};

function detectSunglasses(ctx: SunglassesCtx): { style: GlassesStyle; color: Hex; score: number } {
  const { L, rgbAt, clsAt } = ctx;
  const eyes = [
    { contour: ctx.rEye, outer: L[RIGHT_EYE_OUTER], inner: L[RIGHT_EYE_INNER] },
    { contour: ctx.lEye, outer: L[LEFT_EYE_OUTER], inner: L[LEFT_EYE_INNER] },
  ];
  const fracs: number[] = [];
  const colors: RGB[] = [];
  for (const e of eyes) {
    const cx = e.contour.reduce((s, p) => s + p.x, 0) / e.contour.length;
    const cy = e.contour.reduce((s, p) => s + p.y, 0) / e.contour.length;
    const w = Math.hypot(e.outer.x - e.inner.x, e.outer.y - e.inner.y);
    const step = Math.max(1, w / 20);
    let hit = 0;
    let total = 0;
    for (let dy = -0.9 * w; dy <= 0.9 * w; dy += step) {
      for (let dx = -1.1 * w; dx <= 1.1 * w; dx += step) {
        total++;
        if (clsAt(cx + dx, cy + dy) === SEG.OTHERS) {
          hit++;
          colors.push(rgbAt(cx + dx, cy + dy));
        }
      }
    }
    fracs.push(total ? hit / total : 0);
  }
  const score = (fracs[0] + fracs[1]) / 2;
  const T = SUNGLASSES_TUNING;
  if (score < T.threshold || Math.min(fracs[0], fracs[1]) < T.minEach) {
    return { style: 'none', color: DEFAULT_FEATURES.glassesColor, score };
  }
  const lens = trimmedMean(colors, 0.1) ?? hexToRgb(DEFAULT_FEATURES.glassesColor);
  // レンズの色を、読みやすいよう暗い側へ少し寄せる
  return { style: 'sun', color: mix(rgbToHex(lens), DEFAULT_FEATURES.glassesColor, 0.4), score };
}
