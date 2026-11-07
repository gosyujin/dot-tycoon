// 開発専用: メガネ分類器の学習・評価ページ（train.html）。本番ビルドには含まれない。
//   1. dev-samples/train/manifest.json の画像を解析し、目元などのクロップを作る
//   2. MediaPipe ImageEmbedder で特徴量にする（元画像と左右反転の2枚）
//   3. 5分割の交差検証で、特徴抽出器 × クロップ × 正則化 を比較する
//   4. 最良の組み合わせで全データを学習し、重み(JSON)を出力する
import { FilesetResolver, ImageEmbedder } from '@mediapipe/tasks-vision';
import { analyzeImage } from '../detect';
import { LEFT_EYE_OUTER, RIGHT_EYE_OUTER } from '../landmarks';
import { auc, fitRidge, score, thresholdAtSpecificity, type RidgeModel } from './ridge';
import { EYE_CROPS, cropEyes, type CropName } from '../glasses-crop';

const EMBEDDERS = { small: 'models/mobilenet_v3_small.tflite', large: 'models/mobilenet_v3_large.tflite' } as const;
type EmbName = keyof typeof EMBEDDERS;

interface Row {
  file: string;
  label: 1 | -1;
  /** [embedder][crop] -> [元, 左右反転] */
  feats: Record<string, [Float32Array, Float32Array]>;
}

const state = {
  status: 'idle',
  log: [] as string[],
  rows: [] as Row[],
  skipped: { noFace: 0, sun: 0, error: 0 },
  report: '',
  json: '',
  oofs: {} as Record<string, { oof: number[]; y: number[] }>,
};
(window as unknown as { __train: typeof state }).__train = state;
const log = (s: string): void => {
  state.log.push(s);
  console.log(s);
};

const abs = (p: string): string => new URL(p, document.baseURI).href;

async function makeEmbedders(): Promise<Record<EmbName, ImageEmbedder>> {
  const fileset = await FilesetResolver.forVisionTasks(abs('mediapipe/wasm'));
  const out = {} as Record<EmbName, ImageEmbedder>;
  for (const [k, path] of Object.entries(EMBEDDERS)) {
    out[k as EmbName] = await ImageEmbedder.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: abs(path), delegate: 'CPU' },
      runningMode: 'IMAGE',
      l2Normalize: true,
    });
  }
  return out;
}

function flipped(c: HTMLCanvasElement): HTMLCanvasElement {
  const o = document.createElement('canvas');
  o.width = c.width;
  o.height = c.height;
  const x = o.getContext('2d')!;
  x.translate(c.width, 0);
  x.scale(-1, 1);
  x.drawImage(c, 0, 0);
  return o;
}

const embed = (e: ImageEmbedder, c: HTMLCanvasElement): Float32Array => Float32Array.from(e.embed(c).embeddings[0].floatEmbedding ?? []);

export async function collect(limit = Infinity): Promise<void> {
  state.status = 'loading';
  const manifest: { file: string; label: 'pos' | 'neg' }[] = await (await fetch('/dev-samples/train/manifest.json')).json();
  const embedders = await makeEmbedders();
  state.rows = [];
  let n = 0;
  for (const m of manifest) {
    if (n++ >= limit) break;
    try {
      const bmp = await createImageBitmap(await (await fetch('/dev-samples/train/' + m.file)).blob());
      const a = await analyzeImage(bmp);
      if (a.result.features.glasses === 'sun') {
        state.skipped.sun++; // サングラスは別の経路（セグメンテーション）で扱うので学習対象外
        continue;
      }
      const crops = cropEyes(a.canvas, a.landmarks, RIGHT_EYE_OUTER, LEFT_EYE_OUTER);
      const feats: Row['feats'] = {};
      for (const [en, emb] of Object.entries(embedders)) {
        for (const cn of Object.keys(EYE_CROPS) as CropName[]) {
          feats[`${en}/${cn}`] = [embed(emb, crops[cn]), embed(emb, flipped(crops[cn]))];
        }
      }
      state.rows.push({ file: m.file, label: m.label === 'pos' ? 1 : -1, feats });
    } catch (e) {
      if (String(e).includes('顔を検出')) state.skipped.noFace++;
      else state.skipped.error++;
    }
    if (n % 20 === 0) state.status = `collect ${n}/${manifest.length} (rows=${state.rows.length})`;
  }
  state.status = 'collected';
  log(`rows=${state.rows.length} pos=${state.rows.filter((r) => r.label > 0).length} skipped=${JSON.stringify(state.skipped)}`);
}

function folds(n: number, k: number, labels: number[]): number[] {
  // 正例・負例を交互に割り当てる単純な層化（シャッフルは固定シードの線形合同法）
  let seed = 12345;
  const rnd = (): number => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const idx = Array.from({ length: n }, (_, i) => i).sort(() => rnd() - 0.5);
  const out = new Array<number>(n);
  const cnt = { pos: 0, neg: 0 };
  for (const i of idx) out[i] = labels[i] > 0 ? cnt.pos++ % k : cnt.neg++ % k;
  return out;
}

export async function evaluate(lambdas = [0.3, 1, 3, 10], onlyKeys?: string[]): Promise<void> {
  state.status = 'evaluating';
  const rows = state.rows;
  const y = rows.map((r) => r.label);
  const fold = folds(rows.length, 5, y);
  const keys = onlyKeys ?? Object.keys(rows[0].feats);
  const lines: string[] = [];
  const results: { key: string; lambda: number; auc: number; recall95: number; acc: number }[] = [];
  for (const key of keys) {
    for (const lambda of lambdas) {
      const oof = new Array<number>(rows.length).fill(0);
      for (let f = 0; f < 5; f++) {
        const tr = rows.map((_, i) => i).filter((i) => fold[i] !== f);
        const X: Float32Array[] = [];
        const Y: number[] = [];
        for (const i of tr) {
          for (const v of rows[i].feats[key]) {
            X.push(v);
            Y.push(y[i]);
          }
        }
        const model = fitRidge(X, Y, lambda);
        for (let i = 0; i < rows.length; i++) {
          if (fold[i] === f) oof[i] = (score(model, rows[i].feats[key][0]) + score(model, rows[i].feats[key][1])) / 2;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      state.oofs[`${key}|${lambda}`] = { oof, y };
      const th = thresholdAtSpecificity(oof, y, 0.95);
      const acc = oof.filter((s, i) => (s > 0 ? 1 : -1) === y[i]).length / rows.length;
      results.push({ key, lambda, auc: auc(oof, y), recall95: th.recall, acc });
      state.status = `eval ${key} λ=${lambda}`;
    }
  }
  results.sort((a, b) => b.auc - a.auc);
  for (const r of results) lines.push(`${r.key.padEnd(14)} λ=${String(r.lambda).padEnd(4)} AUC=${r.auc.toFixed(3)} 特異度95%時の再現率=${r.recall95.toFixed(2)} acc@0=${r.acc.toFixed(3)}`);
  state.report = lines.join('\n');
  state.status = 'evaluated';
}

/** 全データで学習し、(x·w + b) の形に畳み込んだ重みを JSON にする */
export function fitFinal(key: string, lambda: number): RidgeModel & { folded: { w: number[]; b: number } } {
  const rows = state.rows;
  const X: Float32Array[] = [];
  const Y: number[] = [];
  for (const r of rows) for (const v of r.feats[key]) (X.push(v), Y.push(r.label));
  const m = fitRidge(X, Y, lambda);
  const w = m.w.map((v, j) => v / m.std[j]);
  const b = m.b - m.w.reduce((s, v, j) => s + (v * m.mean[j]) / m.std[j], 0);
  return { ...m, folded: { w, b } };
}

/** 任意の画像(dev-samples 配下の相対パス)を、学習済みの重みで採点する（動作確認用） */
export async function scoreFiles(files: string[], key: string, folded: { w: number[]; b: number }): Promise<Record<string, number | string>> {
  const [en, cn] = key.split('/') as [EmbName, CropName];
  const fileset = await FilesetResolver.forVisionTasks(abs('mediapipe/wasm'));
  const emb = await ImageEmbedder.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: abs(EMBEDDERS[en]), delegate: 'CPU' },
    runningMode: 'IMAGE',
    l2Normalize: true,
  });
  const dot = (x: Float32Array): number => x.reduce((s, v, j) => s + v * folded.w[j], folded.b);
  const out: Record<string, number | string> = {};
  for (const f of files) {
    try {
      const bmp = await createImageBitmap(await (await fetch('/dev-samples/' + f)).blob());
      const a = await analyzeImage(bmp);
      const c = cropEyes(a.canvas, a.landmarks, RIGHT_EYE_OUTER, LEFT_EYE_OUTER)[cn];
      const s = (dot(embed(emb, c)) + dot(embed(emb, flipped(c)))) / 2;
      out[f] = Math.round(s * 1000) / 1000 + (a.result.features.glasses === 'sun' ? ' (sun)' : '');
    } catch (e) {
      out[f] = String(e);
    }
  }
  return out;
}

Object.assign(window, { __trainApi: { collect, evaluate, fitFinal, scoreFiles, state } });
document.body.textContent = 'train page: window.__trainApi.collect() → evaluate() → fitFinal(key, lambda)';
