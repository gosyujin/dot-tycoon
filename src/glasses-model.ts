import weights from './glasses-weights.json';

/**
 * 普通のメガネ（レンズが透明なもの）の分類器。
 * 目元を切り出した画像を MediaPipe ImageEmbedder(MobileNetV3 small)で埋め込み、
 * 線形モデルの重みで採点する。重みは `src/train/`（開発専用）で学習したもの。
 */
export const GLASSES_MODEL = weights as {
  embedder: 'small';
  crop: 'eyes15';
  /** この値を超えたらメガネとみなす（メガネなしの誤検出を数%に抑える位置） */
  threshold: number;
  bias: number;
  w: number[];
  /** 学習時の交差検証での目安（README 用） */
  cv: { auc: number; specificity: number; recall: number; samples: number };
};

export function dotScore(emb: ArrayLike<number>, w: number[] = GLASSES_MODEL.w, bias = GLASSES_MODEL.bias): number {
  let s = bias;
  for (let j = 0; j < w.length; j++) s += emb[j] * w[j];
  return s;
}

/** 元の目元画像と左右反転画像のスコアの平均（学習時と同じ） */
export function glassesScore(embOriginal: ArrayLike<number>, embFlipped: ArrayLike<number>): number {
  return (dotScore(embOriginal) + dotScore(embFlipped)) / 2;
}
