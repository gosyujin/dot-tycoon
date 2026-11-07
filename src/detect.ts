import { FaceLandmarker, FilesetResolver, ImageEmbedder, ImageSegmenter } from '@mediapipe/tasks-vision';
import { extractFeatures, type AnalysisResult, type ClassMask, type Pt } from './features';
import { cropEyes } from './glasses-crop';
import { glassesScore, GLASSES_MODEL } from './glasses-model';
import { LEFT_EYE_OUTER, RIGHT_EYE_OUTER } from './landmarks';
import { mix } from './color';
import { ovalSkinFraction, synthesizeMask } from './illustration';
import { DEFAULT_FEATURES } from './types';

export class NoFaceError extends Error {
  constructor() {
    super('顔を検出できませんでした。顔がはっきり写った正面寄りの画像を試してください。');
    this.name = 'NoFaceError';
  }
}

export interface Analysis {
  /** 解析に使った画像（傾き補正済み・縮小済み） */
  canvas: HTMLCanvasElement;
  mask: ClassMask;
  landmarks: Pt[];
  result: AnalysisResult;
  /** 傾き補正で回した角度（度） */
  rotationDeg: number;
}

const MAX_SIDE = 1024;
/** 顔の頬〜顎のうち肌クラスになっている割合がこれ未満なら、セグメンテーションが効いていない（イラスト）とみなす */
const ILLUSTRATION_SKIN_FRACTION = 0.35;
const assetUrl = (path: string): string => new URL(path, document.baseURI).href;

interface Models {
  landmarker: FaceLandmarker;
  segmenter: ImageSegmenter;
  /** 普通のメガネの判定用。読み込めなかったときは null（サングラス判定だけで動く） */
  embedder: ImageEmbedder | null;
}
let modelsPromise: Promise<Models> | null = null;

/** モデルは同梱ファイル（public/models, public/mediapipe）から読む。外部CDNは使わない */
export function loadModels(): Promise<Models> {
  modelsPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(assetUrl('mediapipe/wasm'));
    const [landmarker, segmenter, embedder] = await Promise.all([
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: assetUrl('models/face_landmarker.task'), delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 4,
        // イラストの顔は実写より自信度が低く出るので、既定(0.5)より緩くする
        minFaceDetectionConfidence: 0.15,
        minFacePresenceConfidence: 0.15,
        outputFaceBlendshapes: true,
      }),
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: assetUrl('models/selfie_multiclass_256x256.tflite'), delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      }),
      ImageEmbedder.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: assetUrl('models/mobilenet_v3_small.tflite'), delegate: 'CPU' },
        runningMode: 'IMAGE',
        l2Normalize: true,
      }).catch((e) => {
        console.warn('メガネ判定モデルを読み込めませんでした（サングラスのみ自動判定になります）', e);
        return null;
      }),
    ]);
    return { landmarker, segmenter, embedder };
  })();
  // 失敗したら次回やり直せるように
  modelsPromise.catch(() => {
    modelsPromise = null;
  });
  return modelsPromise;
}

function fitToCanvas(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 画像を angle(rad) 回す。はみ出す角は元画像を引き伸ばしたものでぼかして埋める */
function rotateCanvas(src: HTMLCanvasElement, angle: number): HTMLCanvasElement {
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const w = Math.round(src.width * cos + src.height * sin);
  const h = Math.round(src.width * sin + src.height * cos);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  try {
    ctx.filter = 'blur(24px)';
  } catch {
    /* ctx.filter 非対応の環境では引き伸ばすだけ */
  }
  ctx.drawImage(src, -24, -24, w + 48, h + 48);
  ctx.filter = 'none';
  ctx.translate(w / 2, h / 2);
  ctx.rotate(angle);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

type FaceHit = { landmarks: Pt[]; blendshapes: Record<string, number> };

function detectFace(models: Models, canvas: HTMLCanvasElement): FaceHit | null {
  const res = models.landmarker.detect(canvas);
  if (!res.faceLandmarks.length) return null;
  // 一番大きい顔を選ぶ
  let best = 0;
  let bestArea = -1;
  res.faceLandmarks.forEach((lm, i) => {
    const xs = lm.map((p) => p.x);
    const ys = lm.map((p) => p.y);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  });
  const blendshapes: Record<string, number> = {};
  for (const c of res.faceBlendshapes?.[best]?.categories ?? []) blendshapes[c.categoryName] = c.score;
  return { landmarks: res.faceLandmarks[best].map((p) => ({ x: p.x, y: p.y })), blendshapes };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 正規化ランドマークの外接矩形（canvas のピクセル座標） */
function landmarkBox(lm: Pt[], W: number, H: number): Box {
  const xs = lm.map((p) => p.x * W);
  const ys = lm.map((p) => p.y * H);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/**
 * 全体では顔が見つからないとき（イラスト・全身像・小さい顔）、画像を拡大しながらずらして探す。
 * 見つかった候補を重なりでまとめ、多く見つかった・上にあるものを顔とみなす。
 */
interface TileFace {
  /** 顔の外接矩形（canvas 座標） */
  box: Box;
  /** 実際に検出に成功したタイルの範囲（canvas 座標） */
  tile: Box;
}

function findFaceByTiles(models: Models, canvas: HTMLCanvasElement): TileFace | null {
  const W = canvas.width;
  const H = canvas.height;
  const base = Math.min(W, H);
  const hits: (Box & { tile: Box })[] = [];
  for (const scale of [1, 0.6, 0.4, 0.28]) {
    const side = Math.max(32, base * scale);
    const step = side * 0.55;
    const S = Math.round(Math.min(512, Math.max(256, side)));
    const tile = document.createElement('canvas');
    tile.width = tile.height = S;
    const tctx = tile.getContext('2d', { willReadFrequently: true })!;
    for (let y = 0; y + side <= H + 1; y += step) {
      for (let x = 0; x + side <= W + 1; x += step) {
        tctx.fillStyle = '#ffffff';
        tctx.fillRect(0, 0, S, S);
        tctx.drawImage(canvas, x, y, side, side, 0, 0, S, S);
        for (const lm of models.landmarker.detect(tile).faceLandmarks) {
          const b = landmarkBox(lm, side, side);
          // タイルの中で小さすぎる/大きすぎる検出は誤検出が多い
          if (b.w < side * 0.12 || b.w > side * 0.95) continue;
          hits.push({ x: x + b.x, y: y + b.y, w: b.w, h: b.h, tile: { x, y, w: side, h: side } });
        }
      }
    }
  }
  if (!hits.length) return null;
  type Hit = Box & { tile: Box };
  const clusters: { rep: Hit; members: Hit[] }[] = [];
  for (const h of [...hits].sort((a, b) => b.w * b.h - a.w * a.h)) {
    const c = clusters.find((k) => iou(k.rep, h) > 0.25);
    if (c) c.members.push(h);
    else clusters.push({ rep: h, members: [h] });
  }
  const score = (c: { rep: Hit; members: Hit[] }): number => c.members.length * (1.3 - (0.6 * (c.rep.y + c.rep.h / 2)) / H);
  const best = clusters.sort((a, b) => score(b) - score(a))[0];
  const avg = (f: (b: Box) => number): number => best.members.reduce((s, b) => s + f(b), 0) / best.members.length;
  return { box: { x: avg((b) => b.x), y: avg((b) => b.y), w: avg((b) => b.w), h: avg((b) => b.h) }, tile: best.rep.tile };
}

/** 顔の周り（頭〜肩）を切り出して拡大する。顔が小さい画像の解析精度を上げる */
function zoomOnFace(canvas: HTMLCanvasElement, box: Box, mult = 3.0, dy = 0.3): HTMLCanvasElement {
  const W = canvas.width;
  const H = canvas.height;
  const side = Math.min(Math.min(W, H), Math.max(box.w, box.h) * mult);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2 + box.h * dy;
  const sx = Math.min(W - side, Math.max(0, cx - side / 2));
  const sy = Math.min(H - side, Math.max(0, cy - side / 2));
  const out = document.createElement('canvas');
  out.width = out.height = Math.round(Math.min(MAX_SIDE, Math.max(512, side)));
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, sx, sy, side, side, 0, 0, out.width, out.height);
  return out;
}

export async function analyzeImage(
  source: ImageBitmap | HTMLImageElement,
  onStatus: (msg: string) => void = () => {},
): Promise<Analysis> {
  onStatus('モデルを読み込んでいます…');
  const models = await loadModels();

  const w = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const h = 'naturalHeight' in source ? source.naturalHeight : source.height;
  let canvas = fitToCanvas(source, w, h);

  onStatus('顔を探しています…');
  let face = detectFace(models, canvas);
  let zoomed = false;
  if (!face) {
    // イラスト・全身像・小さな顔: 拡大しながら探して、顔の周りを切り出して再検出する
    onStatus('顔を探しています（拡大して探索）…');
    const found = findFaceByTiles(models, canvas);
    if (found) {
      // 切り出しの大きさを変えながら再検出し、だめなら検出に成功したタイルそのものを使う
      const candidates = [3.0, 2.2, 1.6, 4.0].map((m) => zoomOnFace(canvas, found.box, m));
      candidates.push(zoomOnFace(canvas, found.tile, 1.0, 0));
      for (const crop of candidates) {
        const again = detectFace(models, crop);
        if (again) {
          canvas = crop;
          face = again;
          zoomed = true;
          break;
        }
      }
    }
  } else {
    // 顔が小さいときは拡大して取り直す（髪・肌・服の色の精度が上がる）
    const b = landmarkBox(face.landmarks, canvas.width, canvas.height);
    if (b.h < Math.min(canvas.width, canvas.height) * 0.18) {
      const crop = zoomOnFace(canvas, b);
      const again = detectFace(models, crop);
      if (again) {
        canvas = crop;
        face = again;
        zoomed = true;
      }
    }
  }
  if (!face) throw new NoFaceError();

  // 顔の傾きを補正（髪型・前髪の判定は顔が水平な前提のため）
  let rotationDeg = 0;
  const a = face.landmarks[RIGHT_EYE_OUTER];
  const b = face.landmarks[LEFT_EYE_OUTER];
  const roll = Math.atan2((b.y - a.y) * canvas.height, (b.x - a.x) * canvas.width);
  if (Math.abs(roll) > (4 * Math.PI) / 180) {
    const rotated = rotateCanvas(canvas, -roll);
    const again = detectFace(models, rotated);
    if (again) {
      canvas = rotated;
      face = again;
      rotationDeg = (-roll * 180) / Math.PI;
    }
  }

  onStatus('髪・肌・服を解析しています…');
  const seg = models.segmenter.segment(canvas);
  let mask: ClassMask;
  try {
    const cm = seg.categoryMask;
    if (!cm) throw new Error('セグメンテーション結果が空でした');
    mask = { data: cm.getAsUint8Array().slice(), width: cm.width, height: cm.height };
  } finally {
    seg.close();
  }

  const image = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  // 人物セグメンテーションはイラストにほぼ効かない。顔の位置の肌として認識されていなければ、色で分けたマスクに替える
  let mode: 'photo' | 'illustration' = 'photo';
  if (ovalSkinFraction(mask, face.landmarks) < ILLUSTRATION_SKIN_FRACTION) {
    onStatus('イラストとして色を分けています…');
    mask = synthesizeMask(image, face.landmarks).mask;
    mode = 'illustration';
  }
  const result = extractFeatures({ image, mask, landmarks: face.landmarks, blendshapes: face.blendshapes });
  result.debug.mode = mode;
  result.debug.zoomed = zoomed;
  if (result.features.glasses === 'none' && models.embedder) {
    onStatus('メガネを調べています…');
    try {
      const score = scoreClearGlasses(models.embedder, canvas, face.landmarks);
      result.debug.glassesModelScore = score;
      if (score > GLASSES_MODEL.threshold) {
        result.features.glasses = 'square';
        result.features.glassesColor = mix(result.features.hairColor, DEFAULT_FEATURES.glassesColor, 0.5);
      }
    } catch (e) {
      console.warn('メガネ判定に失敗しました', e);
    }
  }
  return { canvas, mask, landmarks: face.landmarks, result, rotationDeg };
}

function flipHorizontally(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = document.createElement('canvas');
  o.width = c.width;
  o.height = c.height;
  const x = o.getContext('2d')!;
  x.translate(c.width, 0);
  x.scale(-1, 1);
  x.drawImage(c, 0, 0);
  return o;
}

/** 目元の画像から、透明なレンズのメガネらしさを返す（大きいほどメガネ） */
function scoreClearGlasses(embedder: ImageEmbedder, canvas: HTMLCanvasElement, landmarks: Pt[]): number {
  const crop = cropEyes(canvas, landmarks, RIGHT_EYE_OUTER, LEFT_EYE_OUTER)[GLASSES_MODEL.crop];
  const emb = (c: HTMLCanvasElement): Float32Array => Float32Array.from(embedder.embed(c).embeddings[0].floatEmbedding ?? []);
  return glassesScore(emb(crop), emb(flipHorizontally(crop)));
}
