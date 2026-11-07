// MediaPipe の WASM と学習済みモデルを public/ に用意する。
// - WASM は node_modules からコピー
// - モデルは MediaPipe 公式の配布元から未取得のときだけダウンロード
// 実行時に外部 CDN へ依存しないので、GitHub Pages / オフラインでも動く。
import { cpSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    minBytes: 1_000_000,
  },
  {
    file: 'selfie_multiclass_256x256.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
    minBytes: 1_000_000,
  },
  {
    file: 'mobilenet_v3_small.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/latest/mobilenet_v3_small.tflite',
    minBytes: 1_000_000,
  },
  // 開発専用(メガネ分類器の学習で比較に使う)。`npm run setup:train` のときだけ取得し、公開物には入れない
  {
    train: true,
    file: 'mobilenet_v3_large.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_large/float32/latest/mobilenet_v3_large.tflite',
    minBytes: 1_000_000,
  },
];

// WASM
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
if (!existsSync(wasmSrc)) {
  console.error('[setup] @mediapipe/tasks-vision が見つかりません。先に npm install を実行してください。');
  process.exit(1);
}
mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });
console.log('[setup] wasm copied');

// Models
const modelDir = join(root, 'public/models');
mkdirSync(modelDir, { recursive: true });
const withTrain = process.argv.includes('--train');
for (const m of MODELS) {
  if (m.train && !withTrain) continue;
  const dst = join(modelDir, m.file);
  if (existsSync(dst) && statSync(dst).size >= m.minBytes) {
    console.log(`[setup] ${m.file} ok`);
    continue;
  }
  console.log(`[setup] downloading ${m.file} ...`);
  const res = await fetch(m.url);
  if (!res.ok) {
    console.error(`[setup] download failed: ${m.url} -> ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < m.minBytes) {
    console.error(`[setup] ${m.file} is unexpectedly small (${buf.length} bytes)`);
    process.exit(1);
  }
  const tmp = dst + '.part';
  writeFileSync(tmp, buf);
  renameSync(tmp, dst);
  console.log(`[setup] ${m.file} saved (${buf.length} bytes)`);
}
