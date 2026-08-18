// 跨平台像素管线:sharp 负责编解码、缩放和裁剪,JS 负责确定性标注。
// Windows 在 sharp 原生模块无法加载时暂时回退到 GDI+;其它平台必须安装 sharp。

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sniffMediaType, type ImagePart } from "./backends";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "vision-pixels.ps1");
const MAX_SOURCE_PIXELS = 256_000_000;
const MAX_RAW_PIXELS = 64_000_000;

type SharpFactory = typeof import("sharp")["default"];
type SharpPipeline = import("sharp").Sharp;

let sharpPromise: Promise<SharpFactory | undefined> | undefined;

export interface RawImage {
  data: Uint8Array; // RGBA
  width: number;
  height: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

function checkAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function loadSharp(): Promise<SharpFactory | undefined> {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((module) => {
        // libvips 的文件缓存会在 Windows 上短暂占用刚处理的图片,妨碍会话清理。
        module.default.cache({ files: 0 });
        return module.default;
      })
      .catch((error: unknown) => {
        if (process.platform === "win32") return undefined;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`sharp is required for image processing on ${process.platform}: ${detail}`);
      });
  }
  return sharpPromise;
}

function sharpInput(sharp: SharpFactory, path: string) {
  return sharp(path, {
    failOn: "error",
    limitInputPixels: MAX_SOURCE_PIXELS,
    sequentialRead: true,
  });
}

async function runSharp<T>(pipeline: SharpPipeline, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAborted(signal);
  const cancel = () => pipeline.destroy();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await operation();
    checkAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) checkAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

async function sharpToFile(pipeline: SharpPipeline, outPath: string, signal?: AbortSignal): Promise<void> {
  const partialPath = join(dirname(outPath), `.${basename(outPath)}.${randomUUID()}.partial`);
  let published = false;
  try {
    await runSharp(pipeline, () => pipeline.toFile(partialPath), signal);
    checkAborted(signal);
    await rename(partialPath, outPath);
    published = true;
    checkAborted(signal);
  } catch (error) {
    await rm(partialPath, { force: true }).catch(() => {});
    if (published) await rm(outPath, { force: true }).catch(() => {});
    if (signal?.aborted) checkAborted(signal);
    throw error;
  }
}

function psRun(args: string[], timeoutMs = 60_000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH, ...args],
      { timeout: timeoutMs, windowsHide: true, signal },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`pixels pipeline failed: ${String(stderr).trim() || error.message}`));
        } else {
          resolvePromise();
        }
      },
    );
  });
}

/** 读取图片魔数。旧 GDI+ 回退不再借助 ImageMagick 转换 WebP。 */
async function ensureGdiReadable(path: string, signal?: AbortSignal): Promise<string> {
  checkAborted(signal);
  const handle = await open(path, "r");
  const header = Buffer.alloc(32);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  checkAborted(signal);
  const bytes = new Uint8Array(header.buffer, header.byteOffset, bytesRead);
  const type = sniffMediaType(bytes);
  if (type === undefined) {
    throw new Error(`${path} is not a recognized image (png/jpeg/webp/gif)`);
  }
  if (type !== "image/webp") return path;
  throw new Error("WebP processing requires sharp; the Windows GDI+ fallback only supports PNG, JPEG, and GIF");
}

/** BGRA(GDI+ 内存序)-> RGBA,原地交换 R/B。 */
function bgraToRgba(bytes: Uint8Array): Uint8Array {
  for (let o = 0; o < bytes.length; o += 4) {
    const t = bytes[o];
    bytes[o] = bytes[o + 2];
    bytes[o + 2] = t;
  }
  return bytes;
}

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid image dimensions: ${width}x${height}`);
  }
  if (width * height > MAX_RAW_PIXELS) {
    throw new Error(`image dimensions exceed the ${MAX_RAW_PIXELS}-pixel raw-buffer safety limit: ${width}x${height}`);
  }
}

function validateMetadata(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`invalid image dimensions: ${width}x${height}`);
  }
}

function normalizeBox(box: { x1: number; y1: number; x2: number; y2: number }): { left: number; top: number; width: number; height: number } {
  const x1 = Math.trunc(box.x1);
  const y1 = Math.trunc(box.y1);
  const x2 = Math.trunc(box.x2);
  const y2 = Math.trunc(box.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) {
    throw new Error(`invalid crop box: (${box.x1},${box.y1})-(${box.x2},${box.y2})`);
  }
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

let scratchDirPromise: Promise<string> | undefined;

async function scratch(): Promise<string> {
  if (!scratchDirPromise) {
    scratchDirPromise = mkdtemp(join(tmpdir(), "pi-vision-"))
      .catch((error) => {
        scratchDirPromise = undefined;
        throw error;
      });
  }
  return scratchDirPromise;
}

/** 一次性中间文件的落点(agent_end 统一清理)。 */
export async function scratchPath(name: string): Promise<string> {
  return join(await scratch(), name);
}

/** 释放本轮临时目录(bin/meta 中间物),工件不受影响。 */
export async function cleanupScratch(): Promise<void> {
  const pending = scratchDirPromise;
  scratchDirPromise = undefined;
  if (!pending) return;
  const dir = await pending.catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
}

async function probeGdiImage(path: string, signal?: AbortSignal): Promise<ImageDimensions> {
  const metaFile = await scratchPath(`probe-${randomUUID().slice(0, 8)}.json`);
  await psRun(["probe", "-In", path, "-Meta", metaFile], 30_000, signal);
  const meta = JSON.parse(await readFile(metaFile, { encoding: "utf8", signal })) as ImageDimensions;
  validateMetadata(meta.width, meta.height);
  return meta;
}

/** 只探测图片尺寸,不把整张 RGBA 导出到 Node。 */
export async function probeImage(path: string, signal?: AbortSignal): Promise<ImageDimensions> {
  checkAborted(signal);
  const sharp = await loadSharp();
  if (sharp) {
    const pipeline = sharpInput(sharp, path);
    const meta = await runSharp(pipeline, () => pipeline.metadata(), signal);
    const width = meta.width;
    const height = meta.height;
    if (width === undefined || height === undefined) throw new Error(`could not read image dimensions for ${path}`);
    validateMetadata(width, height);
    return { width, height };
  }

  const readable = await ensureGdiReadable(path, signal);
  return probeGdiImage(readable, signal);
}

/**
 * 解码图片为 RGBA。fitW/fitH 提供时先缩放到该尺寸(JS 层负责算等比目标),
 * 供 colors 降采样 / pixel_diff 对齐 / trace 限像素。
 */
export async function decodeImage(path: string, fit?: { width: number; height: number }, signal?: AbortSignal): Promise<RawImage> {
  checkAborted(signal);
  if (fit) validateDimensions(fit.width, fit.height);
  const sharp = await loadSharp();
  if (sharp) {
    if (!fit) {
      const metadataPipeline = sharpInput(sharp, path);
      const meta = await runSharp(metadataPipeline, () => metadataPipeline.metadata(), signal);
      if (meta.width === undefined || meta.height === undefined) {
        throw new Error(`could not read image dimensions for ${path}`);
      }
      // 无缩放解码会分配完整 RGBA,必须在 libvips 创建 Raw 缓冲前拒绝超限图片。
      validateDimensions(meta.width, meta.height);
    }
    let pipeline = sharpInput(sharp, path).ensureAlpha();
    if (fit) pipeline = pipeline.resize(fit.width, fit.height, { fit: "fill" });
    pipeline = pipeline.raw();
    const decoded = await runSharp(pipeline, () => pipeline.toBuffer({ resolveWithObject: true }), signal);
    validateDimensions(decoded.info.width, decoded.info.height);
    if (decoded.info.channels !== 4 || decoded.data.length !== decoded.info.width * decoded.info.height * 4) {
      throw new Error(`decode produced ${decoded.data.length} bytes for ${decoded.info.width}x${decoded.info.height} RGBA`);
    }
    return {
      data: new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      width: decoded.info.width,
      height: decoded.info.height,
    };
  }

  const readable = await ensureGdiReadable(path, signal);
  const source = await probeGdiImage(readable, signal);
  validateDimensions(source.width, source.height);
  const dir = await scratch();
  const id = randomUUID().slice(0, 8);
  const bin = join(dir, `${id}.bin`);
  const metaFile = join(dir, `${id}.json`);
  const args = ["decode", "-In", readable, "-Bin", bin, "-Meta", metaFile];
  if (fit) args.push("-W", String(fit.width), "-H", String(fit.height));
  await psRun(args, 60_000, signal);
  const meta = JSON.parse(await readFile(metaFile, { encoding: "utf8", signal })) as { width: number; height: number };
  const data = bgraToRgba(new Uint8Array(await readFile(bin, { signal })));
  if (data.length !== meta.width * meta.height * 4) {
    throw new Error(`decode produced ${data.length} bytes, expected ${meta.width * meta.height * 4}`);
  }
  return { data, width: meta.width, height: meta.height };
}

/** RGBA 编码为 PNG。 */
export async function encodePng(raw: Uint8Array, width: number, height: number, outPath: string, signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  validateDimensions(width, height);
  if (raw.byteLength !== width * height * 4) {
    throw new Error(`RGBA buffer has ${raw.byteLength} bytes, expected ${width * height * 4}`);
  }
  const sharp = await loadSharp();
  if (sharp) {
    const pipeline = sharp(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), {
      raw: { width, height, channels: 4 },
    }).png();
    await sharpToFile(pipeline, outPath, signal);
    return;
  }

  const dir = await scratch();
  const bin = join(dir, `${randomUUID().slice(0, 8)}.bin`);
  await writeFile(bin, bgraToRgba(Uint8Array.from(raw)), { signal });
  await psRun(["encode", "-Bin", bin, "-Out", outPath, "-W", String(width), "-H", String(height)], 60_000, signal);
}

/** 裁剪存 PNG。 */
export async function cropToPng(path: string, box: { x1: number; y1: number; x2: number; y2: number }, outPath: string, signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  const region = normalizeBox(box);
  validateDimensions(region.width, region.height);
  const sharp = await loadSharp();
  if (sharp) {
    const pipeline = sharpInput(sharp, path).extract(region).png();
    await sharpToFile(pipeline, outPath, signal);
    return;
  }

  const readable = await ensureGdiReadable(path, signal);
  const source = await probeGdiImage(readable, signal);
  validateDimensions(source.width, source.height);
  await psRun(["crop", "-In", readable, "-Out", outPath, "-X1", String(region.left), "-Y1", String(region.top), "-X2", String(region.left + region.width), "-Y2", String(region.top + region.height)], 60_000, signal);
}

/** 裁剪存白底 JPEG(视觉 OCR 分片:部分后端对带 alpha 的 PNG 会退化)。 */
export async function cropToJpeg(path: string, box: { x1: number; y1: number; x2: number; y2: number }, outPath: string, signal?: AbortSignal): Promise<void> {
  checkAborted(signal);
  const region = normalizeBox(box);
  validateDimensions(region.width, region.height);
  const sharp = await loadSharp();
  if (sharp) {
    const pipeline = sharpInput(sharp, path)
      .extract(region)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 92 });
    await sharpToFile(pipeline, outPath, signal);
    return;
  }

  const readable = await ensureGdiReadable(path, signal);
  const source = await probeGdiImage(readable, signal);
  validateDimensions(source.width, source.height);
  await psRun(["crop-jpeg", "-In", readable, "-Out", outPath, "-X1", String(region.left), "-Y1", String(region.top), "-X2", String(region.left + region.width), "-Y2", String(region.top + region.height)], 60_000, signal);
}

/** 画标注框(带 label 字段时画编号圆)存 PNG。 */
export async function annotateBoxes(
  path: string,
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number; label?: string }>,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  checkAborted(signal);
  const sharp = await loadSharp();
  if (sharp) {
    const image = await decodeImage(path, undefined, signal);
    drawAnnotations(image, boxes);
    await encodePng(image.data, image.width, image.height, outPath, signal);
    checkAborted(signal);
    return;
  }

  const readable = await ensureGdiReadable(path, signal);
  const source = await probeGdiImage(readable, signal);
  validateDimensions(source.width, source.height);
  const dir = await scratch();
  // JSON 含双引号,走文件传递,避免 PowerShell -File 参数的引号歧义
  const boxesFile = join(dir, `${randomUUID().slice(0, 8)}.json`);
  await writeFile(boxesFile, JSON.stringify(boxes), "utf8");
  await psRun(["annotate", "-In", readable, "-Out", outPath, "-Boxes", boxesFile], 60_000, signal);
}

const DIGIT_GLYPHS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

function setPixel(data: Uint8Array, width: number, height: number, x: number, y: number, color: readonly number[]): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  data[offset] = color[0];
  data[offset + 1] = color[1];
  data[offset + 2] = color[2];
  data[offset + 3] = color[3];
}

function fillCircle(image: RawImage, cx: number, cy: number, radius: number, color: readonly number[]): void {
  const r2 = radius * radius;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) setPixel(image.data, image.width, image.height, x, y, color);
    }
  }
}

function drawLabel(image: RawImage, label: string, cx: number, cy: number, radius: number): void {
  const digits = [...label].filter((char) => DIGIT_GLYPHS[char]);
  if (digits.length === 0) return;
  const scale = Math.max(1, Math.floor(radius / 4));
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = digits.length * glyphWidth + (digits.length - 1) * gap;
  let startX = Math.round(cx - totalWidth / 2);
  const startY = Math.round(cy - (5 * scale) / 2);
  for (const digit of digits) {
    const glyph = DIGIT_GLYPHS[digit];
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            setPixel(image.data, image.width, image.height, startX + column * scale + dx, startY + row * scale + dy, [255, 255, 255, 255]);
          }
        }
      }
    }
    startX += glyphWidth + gap;
  }
}

function drawAnnotations(
  image: RawImage,
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number; label?: string }>,
): void {
  const red = [255, 45, 85, 255] as const;
  const stroke = Math.max(2, Math.round(Math.max(image.width, image.height) / 400));
  const radius = Math.max(10, stroke * 4);
  for (const box of boxes) {
    const x1 = Math.max(0, Math.min(image.width - 1, Math.trunc(box.x1)));
    const y1 = Math.max(0, Math.min(image.height - 1, Math.trunc(box.y1)));
    const x2 = Math.max(x1, Math.min(image.width - 1, Math.trunc(box.x2)));
    const y2 = Math.max(y1, Math.min(image.height - 1, Math.trunc(box.y2)));
    for (let offset = 0; offset < stroke; offset++) {
      for (let x = x1; x <= x2; x++) {
        setPixel(image.data, image.width, image.height, x, y1 + offset, red);
        setPixel(image.data, image.width, image.height, x, y2 - offset, red);
      }
      for (let y = y1; y <= y2; y++) {
        setPixel(image.data, image.width, image.height, x1 + offset, y, red);
        setPixel(image.data, image.width, image.height, x2 - offset, y, red);
      }
    }
    if (box.label !== undefined) {
      const cx = Math.max(radius, Math.min(x1, image.width - radius));
      const cy = Math.max(radius, Math.min(y1, image.height - radius));
      fillCircle(image, cx, cy, radius, red);
      drawLabel(image, box.label, cx, cy, radius);
    }
  }
}

// ---------- 工件目录(dsh 同概念:cwd/.pi-vision/artifacts) ----------

// 运行时工件落在 cwd 的 temp/pi-vision/artifacts(项目规范:temp = 可随时删除的生成物)
const ARTIFACTS_REL = join("temp", "pi-vision", "artifacts");

export function artifactsDir(cwd: string): string {
  return resolve(cwd, ARTIFACTS_REL);
}

/** 工件命名:dsh artifactStem 同款,去扩展名 + 后缀,防非法字符。 */
export function artifactStem(imagePath: string, suffix: string): string {
  const base = basename(imagePath).replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "_") || "image";
  const safeSuffix = suffix.replace(/[^\w.-]+/g, "_");
  return `${base}-${safeSuffix}`;
}

/** 保存工件(字节),返回绝对路径;自动建目录。 */
export async function saveArtifactBytes(cwd: string, name: string, bytes: Uint8Array | string): Promise<string> {
  const target = await artifactPath(cwd, name);
  await writeFile(target, bytes);
  return target;
}

/** 工件绝对路径(建目录,不写文件);供直接写目标路径的管线(裁剪/标注)使用。 */
export async function artifactPath(cwd: string, name: string): Promise<string> {
  const dir = artifactsDir(cwd);
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}

/** 读图片文件为视觉后端的 base64 part(读不了/格式不对直接抛错)。 */
export async function imagePartFromPath(
  path: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<ImagePart & { path: string }> {
  const file = await stat(path);
  if (!file.isFile()) throw new Error(`${path} is not a file`);
  if (options.maxBytes !== undefined && file.size > options.maxBytes) {
    throw new Error(`${path} is larger than ${Math.round(options.maxBytes / 1024 / 1024)}MB; provide a smaller image`);
  }
  const bytes = new Uint8Array(await readFile(path, { signal: options.signal }));
  const mediaType = sniffMediaType(bytes);
  if (!mediaType) throw new Error(`${path} is not a recognized image (png/jpeg/webp/gif)`);
  return { path, data: Buffer.from(bytes).toString("base64"), mediaType };
}
