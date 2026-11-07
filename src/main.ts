import './style.css';
import { analyzeImage, loadModels, NoFaceError, type Analysis } from './detect';
import { exportGrid, FORMATS, type ExportFormat } from './export';
import { renderSprite, type Grid } from './render';
import { SEG } from './landmarks';
import { DEFAULT_FEATURES, type Features } from './types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const drop = $<HTMLLabelElement>('drop');
const fileInput = $<HTMLInputElement>('file');
const dropText = $('drop-text');
const stage = $('stage');
const srcCanvas = $<HTMLCanvasElement>('src-canvas');
const overlayCanvas = $<HTMLCanvasElement>('overlay-canvas');
const overlayToggle = $<HTMLLabelElement>('overlay-toggle');
const overlayCheck = $<HTMLInputElement>('overlay');
const statusEl = $('status');
const dotCanvas = $<HTMLCanvasElement>('dot');
const formatSel = $<HTMLSelectElement>('format');
const scaleSel = $<HTMLSelectElement>('scale');
const downloadBtn = $<HTMLButtonElement>('download');
const form = $<HTMLFormElement>('features');
const resetBtn = $<HTMLButtonElement>('reset');
const debugEl = $('debug');

let detected: Features | null = null;
let current: Features = { ...DEFAULT_FEATURES };
let grid: Grid = renderSprite(current);
let analysis: Analysis | null = null;
let baseName = 'dot';

// ------------------------------------------------------------ 特徴フォーム

type ColorKey = 'hairColor' | 'skinColor' | 'eyeColor' | 'lipColor' | 'clothesColor' | 'bgColor' | 'glassesColor';
type SelectKey = 'hairLength' | 'fringe' | 'hairVolume' | 'eyes' | 'mouth' | 'glasses' | 'bgMode';

const COLORS: [ColorKey, string][] = [
  ['hairColor', '髪の色'],
  ['skinColor', '肌の色'],
  ['eyeColor', '目の色'],
  ['lipColor', '唇の色'],
  ['clothesColor', '服の色'],
  ['bgColor', '背景の色（写真から）'],
  ['glassesColor', 'メガネの色'],
];
const SELECTS: [SelectKey, string, [string, string][]][] = [
  ['hairLength', '髪の長さ', [['bald', '坊主・なし'], ['buzz', '短く刈り込み'], ['short', '短め'], ['medium', '中くらい'], ['long', '長い']]],
  ['fringe', '前髪', [['none', 'なし（おでこ）'], ['part', '真ん中分け'], ['left', '左に流す'], ['right', '右に流す'], ['full', 'ぱっつん']]],
  ['hairVolume', '髪のボリューム', [['0', '普通'], ['1', '高め'], ['2', 'ふんわり広め']]],
  ['eyes', '目', [['open', 'ひらく'], ['wide', 'おおきい'], ['happy', 'にっこり'], ['closed', 'とじる']]],
  ['mouth', '口', [['neutral', 'ふつう'], ['smile', 'ほほえみ'], ['grin', 'にっこり（歯）'], ['open', 'あけ口']]],
  ['glasses', 'メガネ', [['none', 'なし'], ['round', '丸'], ['square', '四角'], ['sun', 'サングラス']]],
  ['bgMode', '背景', [['photo', '写真の背景色'], ['hair', '髪色の淡色'], ['transparent', '透明']]],
];

const colorInputs = new Map<ColorKey, HTMLInputElement>();
const selectInputs = new Map<SelectKey, HTMLSelectElement>();
let blushInput: HTMLInputElement;

function buildForm(): void {
  for (const [key, label] of SELECTS) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(label);
    const sel = document.createElement('select');
    sel.name = key;
    for (const [v, t] of SELECTS.find((s) => s[0] === key)![2]) sel.add(new Option(t, v));
    wrap.append(sel);
    form.append(wrap);
    selectInputs.set(key, sel);
  }
  for (const [key, label] of COLORS) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.append(label);
    const input = document.createElement('input');
    input.type = 'color';
    input.name = key;
    wrap.append(input);
    form.append(wrap);
    colorInputs.set(key, input);
  }
  const blushWrap = document.createElement('label');
  blushWrap.className = 'field check';
  blushInput = document.createElement('input');
  blushInput.type = 'checkbox';
  blushWrap.append(blushInput, 'ほっぺの赤み');
  form.append(blushWrap);

  form.addEventListener('input', () => {
    readForm();
    draw();
  });
  form.addEventListener('submit', (e) => e.preventDefault());
}

function writeForm(f: Features): void {
  for (const [k, input] of colorInputs) input.value = f[k];
  for (const [k, sel] of selectInputs) sel.value = String(f[k]);
  blushInput.checked = f.blush;
}

function readForm(): void {
  const next = { ...current } as Record<string, unknown>;
  for (const [k, input] of colorInputs) next[k] = input.value;
  for (const [k, sel] of selectInputs) next[k] = k === 'hairVolume' ? Number(sel.value) : sel.value;
  next.blush = blushInput.checked;
  current = next as unknown as Features;
}

// ------------------------------------------------------------ 描画・保存

function draw(): void {
  grid = renderSprite(current);
  const ctx = dotCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, grid.size, grid.size);
  grid.px.forEach((c, i) => {
    if (!c) return;
    ctx.fillStyle = c;
    ctx.fillRect(i % grid.size, Math.floor(i / grid.size), 1, 1);
  });
}

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

for (const f of FORMATS) formatSel.add(new Option(f.label, f.id));

downloadBtn.addEventListener('click', async () => {
  const fmt = FORMATS.find((f) => f.id === (formatSel.value as ExportFormat))!;
  const scale = Number(scaleSel.value);
  try {
    const blob = await exportGrid(grid, fmt.id, scale);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName}-dot${scale > 1 ? `-${scale}x` : ''}.${fmt.ext}`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), true);
  }
});

resetBtn.addEventListener('click', () => {
  if (!detected) return;
  current = { ...detected, bgMode: current.bgMode };
  writeForm(current);
  draw();
});

// ------------------------------------------------------------ 解析結果の重ね表示

const MASK_COLORS: Record<number, [number, number, number]> = {
  [SEG.HAIR]: [200, 60, 220],
  [SEG.FACE_SKIN]: [255, 150, 40],
  [SEG.BODY_SKIN]: [255, 220, 40],
  [SEG.CLOTHES]: [60, 120, 255],
  [SEG.OTHERS]: [40, 200, 120],
};

function drawOverlay(): void {
  const on = overlayCheck.checked && analysis !== null;
  overlayCanvas.hidden = !on;
  if (!on || !analysis) return;
  const { canvas, mask, landmarks, result } = analysis;
  overlayCanvas.width = canvas.width;
  overlayCanvas.height = canvas.height;
  const ctx = overlayCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const tint = document.createElement('canvas');
  tint.width = mask.width;
  tint.height = mask.height;
  const tctx = tint.getContext('2d')!;
  const img = tctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    const c = MASK_COLORS[mask.data[i]];
    if (!c) continue;
    img.data.set([c[0], c[1], c[2], 110], i * 4);
  }
  tctx.putImageData(img, 0, 0);
  ctx.drawImage(tint, 0, 0, canvas.width, canvas.height);

  const fb = result.debug.faceBox;
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = Math.max(2, canvas.width / 300);
  ctx.strokeRect(fb.x, fb.y, fb.w, fb.h);
  ctx.fillStyle = '#ffffff';
  const r = Math.max(1, canvas.width / 400);
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * canvas.width, p.y * canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
overlayCheck.addEventListener('change', drawOverlay);

// ------------------------------------------------------------ 画像の読み込み

let running = 0;
async function handleBitmap(bitmap: ImageBitmap, name: string): Promise<void> {
  const ticket = ++running;
  baseName = name.replace(/\.[^.]+$/, '') || 'dot';
  downloadBtn.disabled = true;
  resetBtn.disabled = true;
  try {
    const a = await analyzeImage(bitmap, (m) => ticket === running && setStatus(m));
    if (ticket !== running) return;
    analysis = a;
    srcCanvas.width = a.canvas.width;
    srcCanvas.height = a.canvas.height;
    srcCanvas.getContext('2d')!.drawImage(a.canvas, 0, 0);
    stage.hidden = false;
    overlayToggle.hidden = false;
    dropText.innerHTML = '別の画像をドロップ、またはクリックして選択';

    detected = a.result.features;
    current = { ...detected, bgMode: current.bgMode };
    writeForm(current);
    draw();
    drawOverlay();
    downloadBtn.disabled = false;
    resetBtn.disabled = false;

    const d = a.result.debug;
    const fb = d.fallbacks.length ? `（取得できず既定値で補った項目: ${d.fallbacks.join(', ')}）` : '';
    const rot = Math.abs(a.rotationDeg) > 0.5 ? ` / 顔の傾き ${a.rotationDeg.toFixed(1)}° を補正` : '';
    setStatus(`変換しました${rot}${fb}`);
    debugEl.hidden = false;
    debugEl.textContent = JSON.stringify(
      { features: detected, debug: d },
      (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v),
      2,
    );
  } catch (e) {
    if (ticket !== running) return;
    setStatus(e instanceof NoFaceError ? e.message : `解析に失敗しました: ${e instanceof Error ? e.message : e}`, true);
  }
}

async function handleFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) {
    setStatus('画像ファイルを選んでください。', true);
    return;
  }
  try {
    await handleBitmap(await createImageBitmap(file), file.name);
  } catch {
    setStatus('この画像を読み込めませんでした。', true);
  }
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void handleFile(f);
  fileInput.value = '';
});
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) void handleFile(f);
});
window.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
  if (f) void handleFile(f);
});

// ------------------------------------------------------------ 起動

buildForm();
writeForm(current);
draw();

void (async () => {
  try {
    await loadModels();
    setStatus('準備できました。画像を選んでください。');
    // 開発・共有用: ?img=<同一オリジンの画像URL> で自動読み込み
    const img = new URLSearchParams(location.search).get('img');
    if (img) {
      const res = await fetch(img);
      await handleBitmap(await createImageBitmap(await res.blob()), img.split('/').pop() ?? 'dot');
    }
  } catch (e) {
    setStatus(`モデルの読み込みに失敗しました: ${e instanceof Error ? e.message : e}`, true);
  }
})();
