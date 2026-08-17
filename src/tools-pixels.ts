// 像素工具组:vision_pixel_diff / vision_colors / vision_ocr /
// vision_long_screenshot_ocr / vision_trace / vision_extract_foreground /
// vision_html_screenshot。
// 算法层移植自 dsh(MIT);像素编解码走 PS 管线;potrace 跑 worker 线程
// (CPU 密集 + 需要硬超时终止);html 截图用 puppeteer-core + 本机 Chrome。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { VisionChain } from "./chain";
import {
  decodeImage,
  encodePng,
  cropToPng,
  cropToJpeg,
  artifactStem,
  artifactsDir,
  saveArtifactBytes,
  artifactPath,
  imagePartFromPath,
  cleanupScratch,
  scratchPath,
} from "./pixels";
import {
  computePixelDiff,
  renderDiffHeatmap,
  quantizeColors,
  floodFillBackground,
  longOcrWindows,
} from "./algorithms";

const TASK_DEADLINE_MS = 180_000;
const OCR_DEADLINE_MS = 240_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_ARG_DOC = "Local image path (png/jpeg/webp/gif), workspace-relative or absolute";

function resolveImagePath(cwd: string, input: string): string {
  const trimmed = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, trimmed);
}

// ── tesseract 探测(装了就用,没装走视觉模型;缓存结论避免反复探测) ──
let tesseractAvailable: boolean | undefined;

function probeTesseract(): Promise<boolean> {
  if (tesseractAvailable !== undefined) return Promise.resolve(tesseractAvailable);
  return new Promise((resolveProbe) => {
    execFile("tesseract", ["--version"], { timeout: 5_000, windowsHide: true }, (error) => {
      tesseractAvailable = !error;
      resolveProbe(tesseractAvailable);
    });
  });
}

/** dsh 同款:tesseract stdin->stdout,chi_sim+eng,psm 6。 */
function ocrWithTesseract(bytes: Uint8Array, timeoutMs: number): Promise<string> {
  return new Promise((resolveOcr, reject) => {
    execFile(
      "tesseract",
      ["stdin", "stdout", "-l", "chi_sim+eng", "--psm", "6"],
      { timeout: Math.min(timeoutMs, 60_000), maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolveOcr(String(stdout ?? ""));
      },
    );
  });
}

// ── potrace worker(dsh 模式:硬超时 terminate;CPU 密集不占主线程) ──

function runPotraceWorker(workerData: Record<string, unknown>, timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, reject) => {
    let settled = false;
    let worker: Worker | undefined;
    const finish = (error?: Error, svg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker?.terminate();
      if (error) reject(error);
      else resolveRun(svg ?? "");
    };
    const timer = setTimeout(() => {
      finish(new Error("potrace timed out — the image is too large or too complex; crop it to the target region first"));
    }, timeoutMs);
    try {
      const require = createRequire(import.meta.url);
      let potraceUrl: string;
      try {
        potraceUrl = pathToFileURL(require.resolve("potrace")).href;
      } catch {
        finish(new Error("vision_trace requires the npm package 'potrace'; run npm install in the pi-eyes extension directory"));
        return;
      }
      const source = `
        import('node:worker_threads').then(({ parentPort, workerData }) => {
          import(workerData.potraceUrl).then((mod) => {
            const potrace = mod.default ?? mod
            if (workerData.mode === 'gray') {
              potrace.posterize(Buffer.from(workerData.png), {
                steps: workerData.steps,
                fillStrategy: workerData.fillStrategy,
              }, (error, svg) => {
                parentPort.postMessage(error ? { error: String((error && error.message) || error) } : { svg })
              })
            } else {
              const tasks = workerData.pngs // [{ hex, png }]
              const paths = []
              let pending = tasks.length
              const maybeDone = () => {
                if (pending > 0) return
                const pathSvg = paths.map((p) => '<path fill="' + p.hex + '" d="' + p.d + '"/>').join('')
                const { width, height } = workerData
                parentPort.postMessage({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
                  '" viewBox="0 0 ' + width + ' ' + height + '"><rect width="' + width + '" height="' + height +
                  '" fill="#ffffff"/>' + pathSvg + '</svg>' })
              }
              if (pending === 0) { maybeDone(); return }
              tasks.forEach((entry) => {
                potrace.trace(Buffer.from(entry.png), (err, svg) => {
                  pending -= 1
                  if (!err && svg) {
                    const found = [...svg.matchAll(/d="([^"]+)"/g)].map((m) => m[1])
                    for (const d of found) paths.push({ hex: entry.hex, d })
                  }
                  maybeDone()
                })
              })
            }
          }).catch((error) => {
            parentPort.postMessage({ error: String((error && error.message) || error) })
          })
        })
      `;
      worker = new Worker(source, { eval: true, workerData: { potraceUrl, ...workerData } });
      worker.once("message", (message: { error?: string; svg?: string }) => {
        if (message && message.error) finish(new Error(message.error));
        else finish(undefined, message && message.svg);
      });
      worker.once("error", (error) => finish(error));
      worker.once("exit", (code) => {
        if (code !== 0 && !settled) finish(new Error(`potrace worker exited with code ${code}`));
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** 灰度 mask(0/255)转 PNG(经 PS 管线,批量并发)。 */
async function maskToPng(gray: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const g = gray[i];
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  const out = await scratchPath(`mask-${randomUUID().slice(0, 8)}.png`);
  await encodePng(rgba, width, height, out);
  return new Uint8Array(await readFile(out));
}

/** 等比缩放目标尺寸(sharp resize inside 语义:可放大,长边贴目标)。 */
function fitInside(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(maxW / width, maxH / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ── Chrome/Edge 探测(html_screenshot) ──
function chromiumCandidates(): string[] {
  const env = [
    ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? [process.env.PUPPETEER_EXECUTABLE_PATH] : []),
  ];
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? "";
  return [
    ...env,
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
}

export function registerPixelTools(pi: ExtensionAPI, chain: VisionChain): void {
  // ── vision_pixel_diff ──────────────────────────────────────────
  pi.registerTool({
    name: "vision_pixel_diff",
    label: "Vision Pixel Diff",
    description:
      "Compare two images pixel by pixel: returns the differing-pixel ratio, the worst 8x8-grid " +
      "regions as original-pixel boxes, and writes a red heatmap PNG plus a JSON report as artifacts. " +
      "Use it to verify an implementation against a reference.",
    promptSnippet: "Pixel-level diff of two images with heatmap and worst-region report",
    parameters: Type.Object({
      original: Type.String({ description: "Reference image path" }),
      rebuilt: Type.String({ description: "Candidate image path; resized to the original size before comparing" }),
      threshold: Type.Optional(Type.Number({ description: "Per-channel difference threshold, default 16" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const originalPath = resolveImagePath(ctx.cwd, params.original);
      const rebuiltPath = resolveImagePath(ctx.cwd, params.rebuilt);
      const original = await decodeImage(originalPath);
      if (original.width <= 0 || original.height <= 0) throw new Error("vision_pixel_diff: could not read original dimensions");
      const threshold = Number.isFinite(params.threshold) && params.threshold >= 0 ? Math.round(params.threshold) : 16;
      // rebuilt 对齐到 original 尺寸(dsh resize fit:fill 语义)
      const rebuilt = await decodeImage(rebuiltPath, { width: original.width, height: original.height });
      const diff = computePixelDiff(original.data, rebuilt.data, threshold, original.width, original.height);
      const heatmap = renderDiffHeatmap(original.data, diff.mask, original.width, original.height);
      const stem = artifactStem(params.original, "diff");
      const heatmapPath = await artifactPath(ctx.cwd, `${stem}-heatmap.png`);
      await encodePng(heatmap, original.width, original.height, heatmapPath);
      const worst = diff.cells.slice(0, 5).map((cell) => ({
        x1: cell.x1,
        y1: cell.y1,
        x2: cell.x2,
        y2: cell.y2,
        ratio: Number(cell.ratio.toFixed(4)),
        differing: cell.differing,
        total: cell.total,
      }));
      const report = {
        original: params.original,
        rebuilt: params.rebuilt,
        threshold,
        width: original.width,
        height: original.height,
        differingPixels: diff.differing,
        totalPixels: diff.total,
        diffRatio: Number(diff.ratio.toFixed(4)),
        worstRegions: worst,
      };
      const reportPath = await saveArtifactBytes(ctx.cwd, `${stem}-report.json`, JSON.stringify(report, null, 2));
      return {
        content: [{ type: "text", text: JSON.stringify({ ...report, heatmapPath, reportPath }) }],
        details: { heatmapPath, reportPath },
      };
    },
  });

  // ── vision_colors ──────────────────────────────────────────────
  pi.registerTool({
    name: "vision_colors",
    label: "Vision Colors",
    description:
      "Extract the dominant colors of an image (quantization) with their share of pixels, " +
      "e.g. to match a palette when rebuilding a UI.",
    promptSnippet: "Extract dominant colors and their pixel share from an image",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      top: Type.Optional(Type.Number({ description: "How many colors to return, default 8" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const full = await decodeImage(path);
      const top = Number.isInteger(params.top) && params.top > 0 ? params.top : 8;
      // dsh resize(64,64,{fit:'inside'}) 语义:等比、可放大
      const fit = fitInside(full.width, full.height, 64, 64);
      const small = await decodeImage(path, fit);
      const colors = quantizeColors(small.data, Math.min(top, 32));
      return { content: [{ type: "text", text: JSON.stringify(colors) }], details: { colors } };
    },
  });

  // ── vision_ocr ─────────────────────────────────────────────────
  pi.registerTool({
    name: "vision_ocr",
    label: "Vision OCR",
    description:
      "Transcribe TEXT from an image. Uses the local tesseract engine (chi_sim+eng) when " +
      "available — fast, free, offline — and falls back to a vision model otherwise. " +
      "Returns the text and which engine produced it. " +
      "SCOPE: vision_ocr reads letters, it does NOT recognize people, objects or scenes. Never use it " +
      "as a fallback when vision_describe fails to identify who/what is in a picture. If vision_describe returns " +
      "ok:false with a backend-unavailable code, calling vision_ocr instead will fail the same way — " +
      "do not chain these tools as retries of each other.",
    promptSnippet: "Transcribe text from an image (tesseract or vision model)",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      engine: Type.Optional(
        Type.String({
          description: '"auto" (default): local tesseract first, vision model fallback; or force "tesseract"/"vision"',
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const engine = params.engine === "tesseract" || params.engine === "vision" ? params.engine : "auto";
      const deadlineAt = Date.now() + OCR_DEADLINE_MS;
      if (engine !== "vision" && (await probeTesseract())) {
        try {
          const bytes = new Uint8Array(await readFile(path));
          const text = await ocrWithTesseract(bytes, Math.min(12_000, deadlineAt - Date.now()));
          if (text.trim() !== "") return { content: [{ type: "text", text: JSON.stringify({ engine: "tesseract", text: text.trim() }) }], details: { engine: "tesseract" } };
          if (engine === "tesseract") return { content: [{ type: "text", text: JSON.stringify({ engine: "tesseract", text: "" }) }], details: { engine: "tesseract" } };
        } catch (error) {
          if (engine === "tesseract") {
            throw new Error(`vision_ocr: local tesseract failed (${error instanceof Error ? error.message : String(error)})`);
          }
        }
      }
      if (Date.now() >= deadlineAt) {
        const json = JSON.stringify({ engine: "none", ok: false, code: "VISION_TIMEOUT", retryable: false, text: "" });
        return { content: [{ type: "text", text: json }], details: { engine: "none" } };
      }
      const part = await imagePartFromPath(path, MAX_IMAGE_BYTES);
      const answer = await chain.ask(
        ctx.modelRegistry,
        [part],
        "请原样转述图中的所有文字,保持阅读顺序(从上到下、从左到右)与段落结构,不要添加解释。只输出文字本身。",
        { signal, deadlineAt },
      );
      if (!answer.ok) return { content: [{ type: "text", text: JSON.stringify({ engine: "none", ok: false, code: "VISION_BACKEND_UNAVAILABLE", retryable: false, text: "" }) }], details: { engine: "none" } };
      return { content: [{ type: "text", text: JSON.stringify({ engine: "vision", text: answer.text }) }], details: { engine: "vision", backend: answer.backend } };
    },
  });

  // ── vision_long_screenshot_ocr ─────────────────────────────────
  pi.registerTool({
    name: "vision_long_screenshot_ocr",
    label: "Vision Long Screenshot OCR",
    description:
      "Transcribe a LONG screenshot (chat logs, long documents) into ordered Markdown. " +
      "Splits the image into overlapping horizontal chunks, OCRs each chunk with the local " +
      "tesseract engine (chi_sim+eng) when available or the vision model otherwise, and " +
      "stitches the text in reading order. Writes chunk PNGs, the Markdown, and a manifest " +
      "into the artifacts directory.",
    promptSnippet: "Transcribe a long screenshot into Markdown via overlapping chunks",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      chunkHeight: Type.Optional(Type.Number({ description: "Chunk height in pixels, default 1200" })),
      overlap: Type.Optional(Type.Number({ description: "Overlap between adjacent chunks in pixels, default 120" })),
      engine: Type.Optional(
        Type.String({
          description: '"auto" (default): local tesseract first, vision model fallback; or force "tesseract"/"vision"',
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const full = await decodeImage(path);
      if (full.width <= 0 || full.height <= 0) throw new Error("vision_long_screenshot_ocr: could not read image dimensions");
      const chunkHeight =
        Number.isInteger(params.chunkHeight) && params.chunkHeight >= 400 ? Math.min(params.chunkHeight, 2000) : 1200;
      const overlap =
        Number.isInteger(params.overlap) && params.overlap >= 0 ? Math.min(params.overlap, Math.floor(chunkHeight / 2)) : 120;
      const engine = params.engine === "tesseract" || params.engine === "vision" ? params.engine : "auto";
      const windows = longOcrWindows(full.height, chunkHeight, overlap);
      const stem = artifactStem(params.image, "ocr");
      const dir = join(artifactsDir(ctx.cwd), stem);
      await mkdir(dir, { recursive: true });
      const hasTesseract = engine !== "vision" ? await probeTesseract() : false;
      const deadlineAt = Date.now() + OCR_DEADLINE_MS;
      let visionFailed = false;
      const results: Array<{ chunk: number; top: number; bottom: number; engine: string; chars: number; text: string }> = [];

      for (let i = 0; i < windows.length; i++) {
        const { top, bottom } = windows[i];
        if (Date.now() >= deadlineAt) {
          results.push({ chunk: i + 1, top, bottom, engine: "skipped", chars: 0, text: "" });
          continue;
        }
        // 展示用 chunk PNG + 视觉用白底 JPEG(部分后端对带 alpha 的 PNG 退化)
        const chunkPng = join(dir, `chunk-${String(i + 1).padStart(2, "0")}.png`);
        const { cropToPng } = await import("./pixels");
        await cropToPng(path, { x1: 0, y1: top, x2: full.width, y2: bottom }, chunkPng);
        const chunkJpeg = await scratchPath(`ocr-${randomUUID().slice(0, 8)}.jpg`);
        await cropToJpeg(path, { x1: 0, y1: top, x2: full.width, y2: bottom }, chunkJpeg);
        let text = "";
        let used = "none";
        if (hasTesseract) {
          try {
            const bytes = new Uint8Array(await readFile(chunkPng));
            const out = await ocrWithTesseract(bytes, Math.min(12_000, deadlineAt - Date.now()));
            text = out.trim();
            used = "tesseract";
          } catch (error) {
            if (engine === "tesseract") {
              throw new Error(`vision_long_screenshot_ocr: tesseract failed on chunk ${i + 1} (${error instanceof Error ? error.message : String(error)})`);
            }
          }
        }
        if (text === "" && engine !== "tesseract" && !visionFailed && Date.now() < deadlineAt) {
          try {
            const part = await imagePartFromPath(chunkJpeg, MAX_IMAGE_BYTES);
            const answer = await chain.ask(
              ctx.modelRegistry,
              [part],
              "请原样转述这张长截图分片中的所有文字,保持阅读顺序(从上到下、从左到右)," +
                "不要添加解释,只输出文字本身。如果画面中没有可见文字,只输出 EMPTY,不要编造内容。",
              { signal, deadlineAt },
            );
            if (!answer.ok) {
              visionFailed = true;
              used = "failed";
            } else {
              text = answer.text.trim();
              // 可读分片很少超 12k 字:超长视为幻觉,按 dsh 策略用更严格 prompt 重试一次
              if (text.length > 12000) {
                const retry = await chain.ask(
                  ctx.modelRegistry,
                  [part],
                  "重新转写这张图片中的真实文字,保持阅读顺序。只输出图中肉眼可见的文字," +
                    "禁止编造、禁止重复;总输出不超过 3000 字。没有任何文字就只输出 EMPTY。",
                  { signal, deadlineAt },
                );
                if (!retry.ok) {
                  visionFailed = true;
                  used = "failed";
                  text = "";
                } else {
                  const retryText = retry.text.trim();
                  if (retryText !== "") text = retryText;
                  used = "vision";
                }
              } else {
                used = "vision";
              }
              if (text === "EMPTY") text = "";
            }
          } catch {
            used = "failed";
          }
        }
        results.push({ chunk: i + 1, top, bottom, engine: used, chars: text.length, text });
      }

      const joined = results.map((r) => r.text).filter((t) => t !== "").join("\n\n");
      const engines: Record<string, number> = {};
      for (const r of results) engines[r.engine] = (engines[r.engine] ?? 0) + 1;
      const manifest = {
        source: params.image,
        width: full.width,
        height: full.height,
        chunkHeight,
        overlap,
        chunks: results.length,
        engines,
        perChunk: results.map(({ text, ...rest }) => rest),
      };
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      const mdPath = join(dir, "ocr.md");
      await writeFile(mdPath, joined, "utf8");
      const summary = { text: joined, chunks: results.length, engines, markdownPath: mdPath, manifestPath, artifactsDir: dir };
      return { content: [{ type: "text", text: JSON.stringify(summary) }], details: { markdownPath: mdPath } };
    },
  });

  // ── vision_trace ───────────────────────────────────────────────
  pi.registerTool({
    name: "vision_trace",
    label: "Vision Trace",
    description:
      "Vectorize an image (icon/logo) into an SVG via a local potrace pipeline. " +
      "Default: COLOR-preserving vectorization — one path per dominant color with fill=\"#rrggbb\". " +
      "Set color=false for the layered grayscale posterization, where `steps` (1-16, default 4) " +
      "controls levels. Writes the SVG as an artifact.",
    promptSnippet: "Vectorize an image (icon/logo) into SVG via potrace",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      steps: Type.Optional(Type.Number({ description: "Posterization steps, 1-16, default 4 (only when color=false)" })),
      color: Type.Optional(Type.Boolean({ description: "Preserve original colors (default true)" })),
      colors: Type.Optional(Type.Number({ description: "Number of dominant colors in color mode, 1-16, default 8" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const steps = Number.isInteger(params.steps) && params.steps > 0 ? Math.min(params.steps, 16) : 4;
      const colorMode = params.color !== false;
      // 矢量化在 ~1MP 之外无收益,potrace 成本随像素陡增(dsh 同款上限)
      const full = await decodeImage(path);
      const fit = fitInside(full.width, full.height, Math.round(Math.sqrt(1_000_000)), Math.round(Math.sqrt(1_000_000)));
      const img = await decodeImage(path, fit);
      let svg: string;
      let colorCount = 0;
      if (colorMode) {
        const colors = Number.isInteger(params.colors) && params.colors > 0 ? Math.min(params.colors, 16) : 8;
        const palette = quantizeColors(img.data, colors);
        colorCount = palette.length;
        // 每色一个 1bit mask -> PNG(并发走 PS 管线)-> worker potrace.trace
        const hexRgb = (hex: string): [number, number, number] => {
          const n = parseInt(hex.slice(1), 16);
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        };
        const paletteRgb = palette.map((p) => hexRgb(p.hex));
        const pixels = img.width * img.height;
        const masks = palette.map(() => new Uint8Array(pixels));
        for (let p = 0; p < pixels; p++) {
          const o = p * 4;
          if (img.data[o + 3] < 128) continue;
          let best = 0;
          let bestD = Infinity;
          for (let c = 0; c < paletteRgb.length; c++) {
            const dr = img.data[o] - paletteRgb[c][0];
            const dg = img.data[o + 1] - paletteRgb[c][1];
            const db = img.data[o + 2] - paletteRgb[c][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          }
          masks[best][p] = 1;
        }
        const grayMasks = masks.map((mask) => {
          const gray = new Uint8Array(pixels);
          for (let p = 0; p < pixels; p++) gray[p] = mask[p] ? 0 : 255;
          return gray;
        });
        const pngs = await Promise.all(grayMasks.map((gray) => maskToPng(gray, img.width, img.height)));
        svg = await runPotraceWorker(
          { mode: "color", pngs: pngs.map((png, i) => ({ hex: palette[i].hex, png })), width: img.width, height: img.height },
          60_000,
        );
      } else {
        // 灰度模式直接把原图(限像素后)编码成 PNG 交给 posterize
        const srcPng = await scratchPath(`trace-${randomUUID().slice(0, 8)}.png`);
        // encodePng 输入是 RGBA,原图已是 RGBA
        await encodePng(img.data, img.width, img.height, srcPng);
        svg = await runPotraceWorker({ mode: "gray", png: await readFile(srcPng), steps, fillStrategy: "dominant" }, 60_000);
      }
      const target = await saveArtifactBytes(ctx.cwd, `${artifactStem(params.image, colorMode ? "trace-color" : `trace-${steps}`)}.svg`, svg);
      const info = await stat(target);
      return {
        content: [{ type: "text", text: JSON.stringify({ path: target, bytes: info.size, ...(colorMode ? { colors: colorCount } : {}) }) }],
        details: { path: target },
      };
    },
  });

  // ── vision_extract_foreground ──────────────────────────────────
  pi.registerTool({
    name: "vision_extract_foreground",
    label: "Vision Extract Foreground",
    description:
      "Remove a solid-ish background (border flood fill with color tolerance) and " +
      "write the cutout as a transparent PNG artifact. Best for logos on uniform backgrounds.",
    promptSnippet: "Cut out the foreground by flood-filling a solid background to transparency",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      tolerance: Type.Optional(Type.Number({ description: "Max per-channel color distance from the background, default 40" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const full = await decodeImage(path);
      // 同 dsh 的 CPU 保护:洪水填充是同步像素遍历,超 4MP 先降
      const fit = full.width * full.height > 4_000_000 ? fitInside(full.width, full.height, 2000, 2000) : undefined;
      const img = fit ? await decodeImage(path, fit) : full;
      const tolerance = Number.isFinite(params.tolerance) && params.tolerance >= 0 ? Math.round(params.tolerance) : 40;
      const cutout = floodFillBackground(img.data, img.width, img.height, tolerance);
      const outPath = await artifactPath(ctx.cwd, `${artifactStem(params.image, "fg")}.png`);
      await encodePng(cutout, img.width, img.height, outPath);
      const info = await stat(outPath);
      return {
        content: [{ type: "text", text: JSON.stringify({ path: outPath, width: img.width, height: img.height, bytes: info.size }) }],
        details: { path: outPath },
      };
    },
  });

  // ── vision_html_screenshot ─────────────────────────────────────
  pi.registerTool({
    name: "vision_html_screenshot",
    label: "Vision HTML Screenshot",
    description:
      "Render a local .html/.htm file in the system Chrome (headless) and save a PNG screenshot " +
      "as an artifact — the verify step of the reference -> implementation -> screenshot -> " +
      "pixel-diff loop. With fullPage: true the page keeps the requested viewport but the whole " +
      "scrollable height is captured and the result JSON reports pageHeight (CSS px).",
    promptSnippet: "Render a local HTML file in headless Chrome and save a PNG screenshot",
    parameters: Type.Object({
      source: Type.String({ description: "Local .html or .htm file path" }),
      width: Type.Optional(Type.Number({ description: "Viewport width, default 1200" })),
      height: Type.Optional(Type.Number({ description: "Viewport height, default 720" })),
      fullPage: Type.Optional(
        Type.Boolean({
          description:
            "Capture the complete scrollable page height at the requested viewport width instead of just the viewport (default false)",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const source = String(params.source ?? "");
      if (!/\.(html?|htm)$/i.test(source)) {
        throw new Error("vision_html_screenshot: source must be a local .html/.htm file");
      }
      const targetPath = resolveImagePath(ctx.cwd, source);
      if (!existsSync(targetPath)) {
        throw new Error(`vision_html_screenshot: file not found: ${source}`);
      }
      const executablePath = chromiumCandidates().find((p) => existsSync(p));
      if (executablePath === undefined) {
        throw new Error("vision_html_screenshot: no Chrome/Chromium/Edge found; install one or set CHROME_PATH / PUPPETEER_EXECUTABLE_PATH");
      }
      let puppeteer: typeof import("puppeteer-core");
      try {
        puppeteer = await import("puppeteer-core");
      } catch {
        throw new Error("vision_html_screenshot requires the npm package 'puppeteer-core'; run npm install in the pi-eyes extension directory");
      }
      const width = Number.isInteger(params.width) && params.width > 0 ? params.width : 1200;
      const height = Number.isInteger(params.height) && params.height > 0 ? params.height : 720;
      const fullPage = params.fullPage === true;
      const launchArgs = ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--incognito"];
      if (fullPage) {
        // lazy 图片在首屏外不加载:整页截取前关掉懒加载
        launchArgs.push("--blink-settings=imagesLazyLoadingEnabled=false");
      }
      const browser = await puppeteer.default.launch({ executablePath, headless: true, args: launchArgs });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        await page.goto(pathToFileURL(targetPath).href, { waitUntil: "networkidle0", timeout: 30_000, signal });
        let pageHeight: number | undefined;
        if (fullPage) {
          // 滚动唤醒懒加载/滚动触发的渲染,再量整页高(dsh wakePageForFullCapture)
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
              window.scrollTo(0, y);
              await new Promise((r) => setTimeout(r, 60));
            }
            await new Promise((r) => setTimeout(r, 300));
            window.scrollTo(0, 0);
            await new Promise((r) => setTimeout(r, 800));
          });
          pageHeight = await page.evaluate(() =>
            Math.max(
              document.documentElement.scrollHeight,
              document.body ? document.body.scrollHeight : 0,
              window.innerHeight,
            ),
          );
        }
        const png = fullPage ? await page.screenshot({ type: "png", fullPage: true }) : await page.screenshot({ type: "png" });
        const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`;
        const outPath = await saveArtifactBytes(ctx.cwd, `${artifactStem(source, stem)}.png`, new Uint8Array(png));
        const result: Record<string, unknown> = { path: outPath, width, height, bytes: png.length };
        if (fullPage && pageHeight !== undefined) result.pageHeight = pageHeight;
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { path: outPath } };
      } finally {
        await browser.close();
      }
    },
  });

  // 每轮结束清理像素管线临时目录(bin/meta 中间物)
  pi.on("agent_end", async () => {
    await cleanupScratch().catch(() => {});
  });
}
