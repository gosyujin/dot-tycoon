import { GIFEncoder } from 'gifenc';
import { hexToRgb } from './color';
import type { Grid } from './render';

export type ExportFormat = 'png' | 'webp' | 'jpeg' | 'gif' | 'svg';

export const FORMATS: { id: ExportFormat; label: string; mime: string; ext: string }[] = [
  { id: 'png', label: 'PNG（透過可）', mime: 'image/png', ext: 'png' },
  { id: 'webp', label: 'WebP（透過可）', mime: 'image/webp', ext: 'webp' },
  { id: 'gif', label: 'GIF（透過可）', mime: 'image/gif', ext: 'gif' },
  { id: 'svg', label: 'SVG（ベクター）', mime: 'image/svg+xml', ext: 'svg' },
  { id: 'jpeg', label: 'JPEG（透過なし）', mime: 'image/jpeg', ext: 'jpg' },
];

/**
 * SVG。reference/*.svg と同じ「行ごとに同色を横にまとめた rect」の形式。
 * scale を指定すると width/height を付ける（viewBox は常にドット数）
 */
export function gridToSvg(grid: Grid, opts: { scale?: number; title?: string } = {}): string {
  const { size, px } = grid;
  const rects: string[] = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      const c = px[y * size + x];
      let end = x + 1;
      while (end < size && px[y * size + end] === c) end++;
      if (c) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${c}"/>`);
      x = end;
    }
  }
  const dim = opts.scale ? ` width="${size * opts.scale}" height="${size * opts.scale}"` : '';
  const title = opts.title ? `<title>${escapeXml(opts.title)}</title>` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"${dim} ` +
    `shape-rendering="crispEdges" role="img">${title}${rects.join('')}</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
}

/**
 * GIF。ドット絵の色数は少ないので、減色せずそのままパレットにする（劣化なし）。
 * 透明があれば透過 GIF にする
 */
export function gridToGifBytes(grid: Grid, scale: number): Uint8Array {
  const { size, px } = grid;
  const palette: number[][] = [];
  const lookup = new Map<string, number>();
  let transparentIndex = -1;
  const idxOf = (c: string | null): number => {
    if (c === null) {
      if (transparentIndex < 0) {
        transparentIndex = palette.length;
        palette.push([0, 0, 0]);
      }
      return transparentIndex;
    }
    let i = lookup.get(c);
    if (i === undefined) {
      i = palette.length;
      palette.push([...hexToRgb(c)]);
      lookup.set(c, i);
    }
    return i;
  };
  const src = px.map(idxOf);
  if (palette.length > 256) throw new Error('GIF のパレットが 256 色を超えました');

  const w = size * scale;
  const index = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < w; x++) index[y * w + x] = src[sy * size + Math.floor(x / scale)];
  }
  const gif = GIFEncoder();
  gif.writeFrame(index, w, w, {
    palette,
    transparent: transparentIndex >= 0,
    transparentIndex: Math.max(transparentIndex, 0),
  });
  gif.finish();
  return gif.bytes();
}

/** 最近傍で拡大した canvas。background を渡すと透明部分をその色で塗る */
export function gridToCanvas(grid: Grid, scale: number, background: string | null = null): HTMLCanvasElement {
  const { size, px } = grid;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = px[y * size + x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`${mime} への変換に失敗しました`))), mime, quality);
  });
}

export async function exportGrid(grid: Grid, format: ExportFormat, scale: number): Promise<Blob> {
  switch (format) {
    case 'svg':
      return new Blob([gridToSvg(grid, { scale })], { type: 'image/svg+xml' });
    case 'gif':
      return new Blob([gridToGifBytes(grid, scale) as BlobPart], { type: 'image/gif' });
    case 'jpeg':
      // JPEG は透過できないので白で塗る
      return canvasToBlob(gridToCanvas(grid, scale, '#ffffff'), 'image/jpeg', 1);
    case 'webp':
      return canvasToBlob(gridToCanvas(grid, scale), 'image/webp', 1);
    default:
      return canvasToBlob(gridToCanvas(grid, scale), 'image/png');
  }
}
