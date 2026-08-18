// PS 像素管线桥:JS 算法层(rgba Uint8Array)<-> GDI+ 编解码。
// webp 不被 GDI+ 支持,先经 magick 转 png(装了 ImageMagick 才有,失败时报清晰错误)。
// 注意:System.Drawing 的 Format32bppArgb 内存序是 BGRA,进出都做通道交换。

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { sniffMediaType, type ImagePart } from "./backends";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "vision-pixels.ps1");

export interface RawImage {
  data: Uint8Array; // RGBA
  width: number;
  height: number;
}

export interface ImageDimensions {
  width: number;
  height: number;
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

/** webp(及 GDI+ 读不了的格式)先转 png。返回可被 GDI+ 读取的路径。 */
async function ensureGdiReadable(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, "r");
  const header = Buffer.alloc(32);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  const bytes = new Uint8Array(header.buffer, header.byteOffset, bytesRead);
  const type = sniffMediaType(bytes);
  if (type === undefined) {
    throw new Error(`${path} is not a recognized image (png/jpeg/webp/gif)`);
  }
  if (type !== "image/webp") return path;
  const out = await scratchPath(`webp-${randomUUID().slice(0, 8)}.png`);
  await new Promise<void>((resolvePromise, reject) => {
    execFile("magick", [path, out], { timeout: 30_000, windowsHide: true, signal }, (error) => {
      if (error) reject(new Error(`webp conversion needs ImageMagick (magick) which failed: ${error.message}`));
      else resolvePromise();
    });
  });
  return out;
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

/** 只探测图片尺寸,不把整张 RGBA 导出到 Node。 */
export async function probeImage(path: string, signal?: AbortSignal): Promise<ImageDimensions> {
  const readable = await ensureGdiReadable(path, signal);
  const metaFile = await scratchPath(`probe-${randomUUID().slice(0, 8)}.json`);
  await psRun(["probe", "-In", readable, "-Meta", metaFile], 30_000, signal);
  const meta = JSON.parse(await readFile(metaFile, { encoding: "utf8", signal })) as ImageDimensions;
  if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width <= 0 || meta.height <= 0) {
    throw new Error(`could not read image dimensions for ${path}`);
  }
  return meta;
}

/**
 * 解码图片为 RGBA。fitW/fitH 提供时先缩放到该尺寸(JS 层负责算等比目标),
 * 供 colors 降采样 / pixel_diff 对齐 / trace 限像素。
 */
export async function decodeImage(path: string, fit?: { width: number; height: number }, signal?: AbortSignal): Promise<RawImage> {
  const readable = await ensureGdiReadable(path, signal);
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
  const dir = await scratch();
  const bin = join(dir, `${randomUUID().slice(0, 8)}.bin`);
  await writeFile(bin, bgraToRgba(new Uint8Array(raw)), { signal });
  await psRun(["encode", "-Bin", bin, "-Out", outPath, "-W", String(width), "-H", String(height)], 60_000, signal);
}

/** 裁剪存 PNG。 */
export async function cropToPng(path: string, box: { x1: number; y1: number; x2: number; y2: number }, outPath: string, signal?: AbortSignal): Promise<void> {
  const readable = await ensureGdiReadable(path, signal);
  await psRun(["crop", "-In", readable, "-Out", outPath, "-X1", String(box.x1), "-Y1", String(box.y1), "-X2", String(box.x2), "-Y2", String(box.y2)], 60_000, signal);
}

/** 裁剪存白底 JPEG(视觉 OCR 分片:部分后端对带 alpha 的 PNG 会退化)。 */
export async function cropToJpeg(path: string, box: { x1: number; y1: number; x2: number; y2: number }, outPath: string, signal?: AbortSignal): Promise<void> {
  const readable = await ensureGdiReadable(path, signal);
  await psRun(["crop-jpeg", "-In", readable, "-Out", outPath, "-X1", String(box.x1), "-Y1", String(box.y1), "-X2", String(box.x2), "-Y2", String(box.y2)], 60_000, signal);
}

/** 画标注框(带 label 字段时画编号圆)存 PNG。 */
export async function annotateBoxes(
  path: string,
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number; label?: string }>,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const readable = await ensureGdiReadable(path, signal);
  const dir = await scratch();
  // JSON 含双引号,走文件传递,避免 PowerShell -File 参数的引号歧义
  const boxesFile = join(dir, `${randomUUID().slice(0, 8)}.json`);
  await writeFile(boxesFile, JSON.stringify(boxes), "utf8");
  await psRun(["annotate", "-In", readable, "-Out", outPath, "-Boxes", boxesFile], 60_000, signal);
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
