import { FaceLandmarker, FilesetResolver, ImageEmbedder, ImageSegmenter } from '@mediapipe/tasks-vision';
import { extractFeatures, type AnalysisResult, type ClassMask, type Pt } from './features';
import { cropEyes } from './glasses-crop';
import { glassesScore, GLASSES_MODEL } from './glasses-model';
import { LEFT_EYE_OUTER, RIGHT_EYE_OUTER } from './landmarks';
import { mix } from './color';
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
  const result = extractFeatures({ image, mask, landmarks: face.landmarks, blendshapes: face.blendshapes });
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
