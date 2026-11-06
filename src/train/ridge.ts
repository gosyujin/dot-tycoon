// 学習用の小さな数値ライブラリ（リッジ回帰を双対形式で解く + 評価指標）。
// 特徴量は n(サンプル数) < d(次元) なので、n×n のカーネル行列 K = X Xᵀ を解くほうが速い。

export interface RidgeModel {
  mean: number[];
  std: number[];
  w: number[];
  b: number;
}

/** (A) x = b をガウス消去で解く。A は正定値なので pivot 選びは不要 */
function solveSPD(A: Float64Array, b: Float64Array, n: number): Float64Array {
  // Cholesky: A = L Lᵀ
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** 標準化して、ラベル(±1)にリッジ回帰を当てる */
export function fitRidge(X: Float32Array[], y: number[], lambda: number): RidgeModel {
  const n = X.length;
  const d = X[0].length;
  const mean = new Array<number>(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
  const std = new Array<number>(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map((x) => Float64Array.from(x, (v, j) => (v - mean[j]) / std[j]));
  const ym = y.reduce((a, b) => a + b, 0) / n;
  const yc = Float64Array.from(y, (v) => v - ym);

  const K = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k <= i; k++) {
      let s = 0;
      const zi = Z[i];
      const zk = Z[k];
      for (let j = 0; j < d; j++) s += zi[j] * zk[j];
      K[i * n + k] = K[k * n + i] = s;
    }
    K[i * n + i] += lambda * d; // 次元数に対して正則化を相対化
  }
  const alpha = solveSPD(K, yc, n);
  const w = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) w[j] += alpha[i] * Z[i][j];
  return { mean, std, w, b: ym };
}

export function score(m: RidgeModel, x: Float32Array | number[]): number {
  let s = m.b;
  for (let j = 0; j < m.w.length; j++) s += ((x[j] - m.mean[j]) / m.std[j]) * m.w[j];
  return s;
}

/** ROC-AUC（正例のスコアが負例より高い確率） */
export function auc(scores: number[], labels: number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  // 同点は平均順位にする
  const rank = new Array<number>(scores.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    for (let k = i; k <= j; k++) rank[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let rankSum = 0;
  let nPos = 0;
  labels.forEach((l, i) => {
    if (l > 0) {
      rankSum += rank[i];
      nPos++;
    }
  });
  const nNeg = labels.length - nPos;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** 負例の特異度が spec 以上になる最小のしきい値と、そのときの再現率 */
export function thresholdAtSpecificity(scores: number[], labels: number[], spec: number): { threshold: number; recall: number } {
  const negs = scores.filter((_, i) => labels[i] < 0).sort((a, b) => a - b);
  const threshold = negs[Math.min(negs.length - 1, Math.floor(spec * negs.length))] ?? 0;
  const pos = scores.filter((_, i) => labels[i] > 0);
  return { threshold, recall: pos.filter((s) => s > threshold).length / Math.max(1, pos.length) };
}
