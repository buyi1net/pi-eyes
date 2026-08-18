// 纯 JS 像素算法,逐行移植自 dsh-vision-router/index.js(MIT):
// computePixelDiff / renderDiffHeatmap / quantizeColors / floodFillBackground /
// longOcrWindows / parseBox。输入统一为 RGBA Uint8Array,由 pixels.ts 的
// PS 管线负责 GDI+ BGRA <-> RGBA 转换。

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 解析 "x1,y1,x2,y2" 或对象形式的像素框,非法返回 undefined。 */
export function parseBox(value: string): Box | undefined {
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return undefined;
  const [x1, y1, x2, y2] = parts;
  if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) return undefined;
  return { x1, y1, x2, y2 };
}

/** 逐像素 RGBA 对比:包括 alpha 在内的任一通道差超过 threshold 判为差异;8x8 网格取最差区域。 */
export function computePixelDiff(
  a: Uint8Array,
  b: Uint8Array,
  threshold: number,
  width: number,
  height: number,
): { differing: number; total: number; ratio: number; mask: Uint8Array; cells: Array<Box & { ratio: number; differing: number; total: number }> } {
  const length = Math.min(a.length, b.length);
  const pixels = Math.floor(length / 4);
  let differing = 0;
  const mask = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const d =
      Math.max(
        Math.abs(a[o] - b[o]),
        Math.abs(a[o + 1] - b[o + 1]),
        Math.abs(a[o + 2] - b[o + 2]),
        Math.abs(a[o + 3] - b[o + 3]),
      ) - threshold;
    if (d > 0) {
      differing += 1;
      mask[i] = 1;
    }
  }
  const ratio = pixels === 0 ? 0 : differing / pixels;
  const cells: Array<Box & { ratio: number; differing: number; total: number }> = [];
  const cw = Math.ceil(width / 8);
  const ch = Math.ceil(height / 8);
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      let hit = 0;
      let total = 0;
      for (let y = cy * ch; y < Math.min((cy + 1) * ch, height); y++) {
        for (let x = cx * cw; x < Math.min((cx + 1) * cw, width); x++) {
          total += 1;
          if (mask[y * width + x]) hit += 1;
        }
      }
      if (total > 0 && hit > 0) {
        cells.push({
          x1: cx * cw,
          y1: cy * ch,
          x2: Math.min((cx + 1) * cw, width),
          y2: Math.min((cy + 1) * ch, height),
          ratio: hit / total,
          differing: hit,
          total,
        });
      }
    }
  }
  cells.sort((x, y) => y.ratio - x.ratio);
  return { differing, total: pixels, ratio, mask, cells };
}

/** 差异热图:灰度底,差异像素标红。输出 RGBA。 */
export function renderDiffHeatmap(original: Uint8Array, mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const gray = Math.round(0.299 * original[o] + 0.587 * original[o + 1] + 0.114 * original[o + 2]);
    if (mask[i]) {
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    } else {
      out[o] = gray;
      out[o + 1] = gray;
      out[o + 2] = gray;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** 主色提取:32-bin 量化,忽略半透明像素,返回 hex + 占比。 */
export function quantizeColors(raw: Uint8Array, topN = 8, bins = 32): Array<{ hex: string; count: number; share: number }> {
  const step = 256 / bins;
  const counts = new Map<string, number>();
  const pixels = Math.floor(raw.length / 4);
  let visiblePixels = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (raw[o + 3] < 128) continue;
    visiblePixels += 1;
    const r = Math.floor(raw[o] / step) * step;
    const g = Math.floor(raw[o + 1] / step) * step;
    const b = Math.floor(raw[o + 2] / step) * step;
    const key = `${r},${g},${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => {
      const [r, g, b] = key.split(",").map(Number);
      const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
      return { hex, count, share: visiblePixels === 0 ? 0 : count / visiblePixels };
    });
}

/** 四角平均色为背景,从边缘洪水填充去背(带容差),alpha 置 0。原地输出副本。 */
export function floodFillBackground(raw: Uint8Array, width: number, height: number, tolerance = 40): Uint8Array {
  const total = width * height;
  const out = new Uint8Array(raw);
  const marked = new Uint8Array(total);
  let r = 0;
  let g = 0;
  let b = 0;
  const corners = [0, width - 1, (height - 1) * width, total - 1];
  for (const c of corners) {
    const o = c * 4;
    r += raw[o];
    g += raw[o + 1];
    b += raw[o + 2];
  }
  r /= 4;
  g /= 4;
  b /= 4;
  const queue: number[] = [];
  let head = 0;
  const push = (x: number, y: number) => {
    const i = y * width + x;
    if (marked[i]) return;
    const o = i * 4;
    const d = Math.max(Math.abs(raw[o] - r), Math.abs(raw[o + 1] - g), Math.abs(raw[o + 2] - b));
    if (d > tolerance) return;
    marked[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  for (let i = 0; i < total; i++) {
    if (marked[i]) out[i * 4 + 3] = 0;
  }
  return out;
}

/** 长截图滑窗:重叠水平窗口,阅读顺序。 */
export function longOcrWindows(height: number, chunkHeight: number, overlap: number): Array<{ top: number; bottom: number }> {
  const windows: Array<{ top: number; bottom: number }> = [];
  for (let top = 0; top < height; top += chunkHeight - overlap) {
    const bottom = Math.min(top + chunkHeight, height);
    windows.push({ top, bottom });
    if (bottom >= height) break;
  }
  return windows;
}

function normalizedOcrLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/**
 * 合并重叠 OCR 分片。先删除相邻分片边界处的重复行，再删除无换行文本的精确字符重叠。
 * 不做模糊删除，避免把本来重复的日志、表格或对话内容误删。
 */
export function mergeOcrChunks(chunks: string[]): string {
  let merged = "";
  for (const raw of chunks) {
    const next = raw.trim();
    if (next === "") continue;
    if (merged === "") {
      merged = next;
      continue;
    }

    const previousLines = merged.split(/\r?\n/);
    const nextLines = next.split(/\r?\n/);
    let overlappingLines = 0;
    const maxLines = Math.min(previousLines.length, nextLines.length, 80);
    for (let count = maxLines; count > 0; count--) {
      const suffix = previousLines.slice(-count).map(normalizedOcrLine);
      const prefix = nextLines.slice(0, count).map(normalizedOcrLine);
      if (suffix.every((line, index) => line !== "" && line === prefix[index])) {
        overlappingLines = count;
        break;
      }
    }
    if (overlappingLines > 0) {
      const remainder = nextLines.slice(overlappingLines).join("\n").trim();
      if (remainder !== "") merged += `\n\n${remainder}`;
      continue;
    }

    // OCR 有时把整个分片输出为单行，此时仅去掉长度 >= 12 的精确边界重叠。
    let overlappingChars = 0;
    const maxChars = Math.min(merged.length, next.length, 4_000);
    for (let count = maxChars; count >= 12; count--) {
      if (merged.slice(-count) === next.slice(0, count)) {
        overlappingChars = count;
        break;
      }
    }
    const remainder = next.slice(overlappingChars).trim();
    if (remainder !== "") merged += `\n\n${remainder}`;
  }
  return merged;
}

/** detect 结果归一化:框夹紧到图内,输出编号清单(dsh normalizeDetectResult 同款)。 */
export function normalizeDetectResult(
  parsed: Record<string, unknown> | undefined,
  width: number,
  height: number,
): { width: number; height: number; elements: Array<{ number: number; label: string; box: Box }> } | undefined {
  if (!parsed || !Array.isArray(parsed.elements)) return undefined;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
  const elements: Array<{ number: number; label: string; box: Box }> = [];
  for (const item of parsed.elements) {
    if (!item || typeof item !== "object") continue;
    const raw = (item as { box?: unknown }).box;
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const x1 = Math.round(Number(b.x1));
    const y1 = Math.round(Number(b.y1));
    const x2 = Math.round(Number(b.x2));
    const y2 = Math.round(Number(b.y2));
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const box: Box = {
      x1: clamp(x1, 0, width - 1),
      y1: clamp(y1, 0, height - 1),
      x2: clamp(x2, 1, width),
      y2: clamp(y2, 1, height),
    };
    if (box.x2 <= box.x1 || box.y2 <= box.y1) continue;
    const label = typeof (item as { label?: unknown }).label === "string" && String((item as { label?: string }).label).trim() !== ""
      ? String((item as { label?: string }).label).trim()
      : `element ${elements.length + 1}`;
    elements.push({ number: elements.length + 1, label, box });
  }
  return { width, height, elements };
}
