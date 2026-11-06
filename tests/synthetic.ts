// 合成の「顔」を作るテスト用ヘルパー。MediaPipe を使わずに extractFeatures の振る舞いを確かめる。
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
} from '../src/landmarks';
import type { AnalysisInput, Pt } from '../src/features';

export const W = 400;
export const H = 520;
export const COLORS = {
  bg: [180, 200, 230],
  skin: [230, 190, 160],
  hair: [60, 40, 30],
  clothes: [200, 30, 30],
  iris: [40, 30, 60],
} as const;

const FACE = { cx: 200, cy: 250, rx: 80, ry: 105 };

export interface FaceSpec {
  /** 'short': 頭頂のみ / 'long': 肩まで / 'none': 髪なし */
  hair?: 'short' | 'long' | 'none';
  /** 前髪: おでこ(顔の上端〜眉)を髪で覆う割合 0..1 */
  fringeCover?: number;
  /** 顔の左(画像左)半分だけ前髪で覆う */
  fringeLeftOnly?: boolean;
  /** 頭頂の髪の高さ(顔の高さに対する割合) */
  topHeight?: number;
  /** 目のまわりを「その他」クラス(サングラス)にする */
  sunglasses?: boolean;
  blendshapes?: Record<string, number>;
}

function ellipsePts(cx: number, cy: number, rx: number, ry: number, n: number, start = 0): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const t = start + (2 * Math.PI * i) / n;
    return { x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) };
  });
}

export function makeFace(spec: FaceSpec = {}): AnalysisInput {
  const { hair = 'short', fringeCover = 0, topHeight = 0.2 } = spec;
  const lm: Pt[] = Array.from({ length: 478 }, () => ({ x: FACE.cx, y: FACE.cy }));
  const set = (idx: number[], pts: Pt[]): void => idx.forEach((i, k) => (lm[i] = pts[k]));

  set(FACE_OVAL, ellipsePts(FACE.cx, FACE.cy, FACE.rx, FACE.ry, FACE_OVAL.length, -Math.PI / 2));
  lm[FOREHEAD_TOP] = { x: FACE.cx, y: FACE.cy - FACE.ry };
  lm[CHIN] = { x: FACE.cx, y: FACE.cy + FACE.ry };

  const eyeY = 225;
  const eyes: [number[], number, number, number, number][] = [
    [RIGHT_EYE, 155, RIGHT_EYE_OUTER, RIGHT_EYE_INNER, RIGHT_IRIS_CENTER],
    [LEFT_EYE, 245, LEFT_EYE_OUTER, LEFT_EYE_INNER, LEFT_IRIS_CENTER],
  ];
  for (const [idx, cx, outer, inner, iris] of eyes) {
    set(idx, ellipsePts(cx, eyeY, 22, 8, idx.length));
    const sign = cx < FACE.cx ? -1 : 1;
    lm[outer] = { x: cx + sign * 22, y: eyeY };
    lm[inner] = { x: cx - sign * 22, y: eyeY };
    lm[iris] = { x: cx, y: eyeY };
  }
  for (const [ring, cx] of [
    [RIGHT_IRIS_RING, 155],
    [LEFT_IRIS_RING, 245],
  ] as const) {
    set([...ring], ellipsePts(cx, eyeY, 7, 7, 4));
  }
  set(RIGHT_BROW, ellipsePts(155, 198, 24, 6, RIGHT_BROW.length));
  set(LEFT_BROW, ellipsePts(245, 198, 24, 6, LEFT_BROW.length));
  set(LIPS_OUTER, ellipsePts(200, 312, 26, 9, LIPS_OUTER.length));
  set(LIPS_INNER, ellipsePts(200, 312, 18, 2, LIPS_INNER.length));
  lm[13] = { x: 200, y: 311 };
  lm[14] = { x: 200, y: 313 };
  lm[RIGHT_CHEEK] = { x: 160, y: 285 };
  lm[LEFT_CHEEK] = { x: 240, y: 285 };
  lm[FOREHEAD_MID] = { x: 200, y: 165 };

  // 画像とクラスマスク
  const data = new Uint8ClampedArray(W * H * 4);
  const mask = new Uint8Array(W * H);
  const paint = (x: number, y: number, cls: number, rgb: readonly number[]): void => {
    const i = y * W + x;
    mask[i] = cls;
    data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  };
  const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

  const faceTop = FACE.cy - FACE.ry;
  const faceH = 2 * FACE.ry;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let cls: number = SEG.BACKGROUND;
      let rgb: readonly number[] = COLORS.bg;
      if (y > 372 && Math.abs(x - 200) < 140) {
        cls = SEG.CLOTHES;
        rgb = COLORS.clothes;
      }
      if (hair !== 'none') {
        // 頭頂〜こめかみの髪
        const inHead = inEllipse(x, y, FACE.cx, FACE.cy - topHeight * faceH * 0.45, FACE.rx + 14, FACE.ry + topHeight * faceH * 0.9);
        const inFaceBox = inEllipse(x, y, FACE.cx, FACE.cy, FACE.rx, FACE.ry);
        if (inHead && y < FACE.cy - 20 && !inFaceBox) {
          cls = SEG.HAIR;
          rgb = COLORS.hair;
        }
        if (hair === 'long' && !inFaceBox && y >= FACE.cy - 40 && y < 470 && x > FACE.cx - FACE.rx - 40 && x < FACE.cx + FACE.rx + 40) {
          cls = SEG.HAIR;
          rgb = COLORS.hair;
        }
      }
      if (inEllipse(x, y, FACE.cx, FACE.cy, FACE.rx, FACE.ry)) {
        cls = SEG.FACE_SKIN;
        rgb = COLORS.skin;
        // 前髪
        const foreheadBottom = 190;
        if (fringeCover > 0 && y < faceTop + fringeCover * (foreheadBottom - faceTop) + 4 && hair !== 'none') {
          if (!spec.fringeLeftOnly || x < FACE.cx) {
            cls = SEG.HAIR;
            rgb = COLORS.hair;
          }
        }
        // 目
        for (const [, cx] of eyes) if (inEllipse(x, y, cx, eyeY, 7, 7)) rgb = COLORS.iris;
        if (spec.sunglasses) {
          for (const cx of [155, 245]) {
            if (inEllipse(x, y, cx, eyeY, 40, 28)) {
              cls = SEG.OTHERS;
              rgb = [20, 20, 25];
            }
          }
        }
      }
      paint(x, y, cls, rgb);
    }
  }

  return {
    image: { data, width: W, height: H },
    mask: { data: mask, width: W, height: H },
    landmarks: lm.map((p) => ({ x: p.x / W, y: p.y / H })),
    blendshapes: spec.blendshapes ?? {},
  };
}
