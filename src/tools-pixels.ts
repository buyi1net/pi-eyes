// 像素工具组:vision_pixel_diff / vision_colors / vision_ocr /
// vision_long_screenshot_ocr / vision_trace / vision_extract_foreground /
// vision_html_screenshot。
// 算法层移植自 dsh(MIT);像素编解码走 PS 管线;potrace 跑 worker 线程
// (CPU 密集 + 需要硬超时终止);html 截图用 puppeteer-core + 本机 Chrome。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { execFile, spawn } from "node:child_process";
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
  probeImage,
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
  mergeOcrChunks,
} from "./algorithms";

const TASK_DEADLINE_MS = 180_000;
const OCR_DEADLINE_MS = 240_000;
const IMAGE_ARG_DOC = "Local image path (png/jpeg/webp/gif), workspace-relative or absolute";

function resolveImagePath(cwd: string, input: string): string {
  const trimmed = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, trimmed);
}

function runId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function abortError(): Error {
  return Object.assign(new Error("operation aborted"), { name: "AbortError" });
}

function parseVisionFailure(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { ok: false, code: "VISION_BACKEND_UNAVAILABLE", reason: json };
  } catch {
    return { ok: false, code: "VISION_BACKEND_UNAVAILABLE", reason: json };
  }
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

/** 运行子进程并把二进制输入完整写入 stdin，支持超时和取消。 */
export function runProcessWithInput(
  command: string,
  args: string[],
  bytes: Uint8Array,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (timeoutMs <= 0) {
      reject(new Error("process deadline exceeded"));
      return;
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxOutput = 32 * 1024 * 1024;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        if (!child.killed) child.kill();
        reject(error);
      } else {
        resolveOutput(Buffer.concat(stdout).toString("utf8"));
      }
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error(`process timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutput) finish(new Error("process stdout exceeded 32 MiB"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutput) stderr.push(chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, closeSignal) => {
      if (settled) return;
      if (code === 0) finish();
      else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`process exited with code ${String(code)}${closeSignal ? ` (${closeSignal})` : ""}${detail ? `: ${detail}` : ""}`));
      }
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(Buffer.from(bytes));
  });
}

/** dsh 同款:tesseract stdin->stdout,chi_sim+eng,psm 6。 */
function ocrWithTesseract(bytes: Uint8Array, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return runProcessWithInput(
    "tesseract",
    ["stdin", "stdout", "-l", "chi_sim+eng", "--psm", "6"],
    bytes,
    Math.min(timeoutMs, 60_000),
    signal,
  );
}

// ── potrace worker(dsh 模式:硬超时 terminate;CPU 密集不占主线程) ──

function runPotraceWorker(workerData: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveRun, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    let worker: Worker | undefined;
    const finish = (error?: Error, svg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker?.terminate();
      if (error) reject(error);
      else resolveRun(svg ?? "");
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => {
      finish(new Error("potrace timed out — the image is too large or too complex; crop it to the target region first"));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
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
              const failures = []
              let pending = tasks.length
              const maybeDone = () => {
                if (pending > 0) return
                if (failures.length > 0) {
                  parentPort.postMessage({ error: 'potrace failed for color layer(s): ' + failures.join('; ') })
                  return
                }
                if (paths.length === 0) {
                  parentPort.postMessage({ error: 'potrace produced no vector paths for any color layer' })
                  return
                }
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
                  if (err) {
                    failures.push(entry.hex + ': ' + String((err && err.message) || err))
                  } else if (svg) {
                    const found = [...svg.matchAll(/d="([^"]+)"/g)].map((m) => m[1])
                    if (found.length === 0) failures.push(entry.hex + ': no path data returned')
                    for (const d of found) paths.push({ hex: entry.hex, d })
                  } else {
                    failures.push(entry.hex + ': empty SVG returned')
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
async function maskToPng(gray: Uint8Array, width: number, height: number, signal?: AbortSignal): Promise<Uint8Array> {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const g = gray[i];
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  const out = await scratchPath(`mask-${randomUUID().slice(0, 8)}.png`);
  await encodePng(rgba, width, height, out, signal);
  return new Uint8Array(await readFile(out, { signal }));
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const originalPath = resolveImagePath(ctx.cwd, params.original);
      const rebuiltPath = resolveImagePath(ctx.cwd, params.rebuilt);
      const original = await decodeImage(originalPath, undefined, signal);
      if (original.width <= 0 || original.height <= 0) throw new Error("vision_pixel_diff: could not read original dimensions");
      const threshold = Number.isFinite(params.threshold) && params.threshold >= 0 ? Math.round(params.threshold) : 16;
      // rebuilt 对齐到 original 尺寸(dsh resize fit:fill 语义)
      const rebuilt = await decodeImage(rebuiltPath, { width: original.width, height: original.height }, signal);
      const diff = computePixelDiff(original.data, rebuilt.data, threshold, original.width, original.height);
      const heatmap = renderDiffHeatmap(original.data, diff.mask, original.width, original.height);
      const stem = artifactStem(params.original, "diff");
      const invocation = runId();
      const heatmapPath = await artifactPath(ctx.cwd, `${stem}-${invocation}-heatmap.png`);
      await encodePng(heatmap, original.width, original.height, heatmapPath, signal);
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
      const reportPath = await saveArtifactBytes(ctx.cwd, `${stem}-${invocation}-report.json`, JSON.stringify(report, null, 2));
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const full = await probeImage(path, signal);
      const top = Number.isInteger(params.top) && params.top > 0 ? params.top : 8;
      // dsh resize(64,64,{fit:'inside'}) 语义:等比、可放大
      const fit = fitInside(full.width, full.height, 64, 64);
      const small = await decodeImage(path, fit, signal);
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
      "Returns ok/complete, the text, and which engine produced it. engine=tesseract is strict: " +
      "if tesseract is unavailable or fails, the tool reports that failure and never uploads the image. " +
      "SCOPE: vision_ocr reads letters, it does NOT recognize people, objects or scenes. Never use it " +
      "as a fallback when vision_describe fails to identify who/what is in a picture. If vision_describe returns " +
      "ok:false with a backend-unavailable code, only the vision OCR engine shares that dependency; " +
      "local tesseract remains independent. Do not chain OCR and scene understanding as retries of each other.",
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
      const hasTesseract = engine !== "vision" ? await probeTesseract() : false;
      if (engine === "tesseract" && !hasTesseract) {
        const result = {
          engine: "tesseract",
          ok: false,
          complete: false,
          code: "TESSERACT_UNAVAILABLE",
          retryable: false,
          text: "",
        };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      if (hasTesseract) {
        try {
          const bytes = new Uint8Array(await readFile(path, { signal }));
          const text = await ocrWithTesseract(bytes, Math.min(12_000, deadlineAt - Date.now()), signal);
          if (text.trim() !== "" || engine === "tesseract") {
            const result = { engine: "tesseract", ok: true, complete: true, text: text.trim() };
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if (engine === "tesseract") {
            const result = {
              engine: "tesseract",
              ok: false,
              complete: false,
              code: "TESSERACT_FAILED",
              retryable: true,
              text: "",
              error: error instanceof Error ? error.message : String(error),
            };
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          }
        }
      }
      if (Date.now() >= deadlineAt) {
        const result = { engine: "none", ok: false, complete: false, code: "VISION_TIMEOUT", retryable: false, text: "" };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      const part = await imagePartFromPath(path, { signal });
      const answer = await chain.ask(
        ctx.modelRegistry,
        [part],
        "请原样转述图中的所有文字,保持阅读顺序(从上到下、从左到右)与段落结构,不要添加解释。只输出文字本身。",
        {
          signal,
          deadlineAt,
          currentModel: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
        },
      );
      if (!answer.ok) {
        const result = { ...parseVisionFailure(answer.json), engine: "none", ok: false, complete: false, text: "" };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      const result = { engine: "vision", ok: true, complete: true, text: answer.text, backend: answer.backend };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
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
      "deduplicates overlap before stitching text in reading order. Writes chunk PNGs, Markdown, " +
      "and a manifest into a unique run directory. The result explicitly reports ok, complete, " +
      "failed, and skipped counts. engine=tesseract is strict and never falls back to upload.",
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
      const full = await probeImage(path, signal);
      if (full.width <= 0 || full.height <= 0) throw new Error("vision_long_screenshot_ocr: could not read image dimensions");
      const chunkHeight =
        Number.isInteger(params.chunkHeight) && params.chunkHeight >= 400 ? Math.min(params.chunkHeight, 2000) : 1200;
      const overlap =
        Number.isInteger(params.overlap) && params.overlap >= 0 ? Math.min(params.overlap, Math.floor(chunkHeight / 2)) : 120;
      const engine = params.engine === "tesseract" || params.engine === "vision" ? params.engine : "auto";
      const windows = longOcrWindows(full.height, chunkHeight, overlap);
      const stem = artifactStem(params.image, "ocr");
      const invocation = runId();
      const dir = join(artifactsDir(ctx.cwd), `${stem}-${invocation}`);
      await mkdir(dir, { recursive: true });
      const hasTesseract = engine !== "vision" ? await probeTesseract() : false;
      if (engine === "tesseract" && !hasTesseract) {
        const summary = {
          engine: "tesseract",
          ok: false,
          complete: false,
          code: "TESSERACT_UNAVAILABLE",
          chunks: windows.length,
          processed: 0,
          failed: 0,
          skipped: windows.length,
          text: "",
          artifactsDir: dir,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
      }
      const deadlineAt = Date.now() + OCR_DEADLINE_MS;
      let visionFailed = false;
      type ChunkResult = {
        chunk: number;
        top: number;
        bottom: number;
        engine: "tesseract" | "vision" | "none";
        status: "ok" | "empty" | "failed" | "skipped";
        chars: number;
        text: string;
        error?: string;
        code?: string;
        attemptedBackends?: unknown[];
      };
      const results: ChunkResult[] = [];

      for (let i = 0; i < windows.length; i++) {
        const { top, bottom } = windows[i];
        if (signal?.aborted) throw abortError();
        if (Date.now() >= deadlineAt) {
          results.push({ chunk: i + 1, top, bottom, engine: "none", status: "skipped", chars: 0, text: "", error: "OCR deadline exceeded" });
          continue;
        }
        // 展示用 chunk PNG + 视觉用白底 JPEG(部分后端对带 alpha 的 PNG 退化)
        const chunkPng = join(dir, `chunk-${String(i + 1).padStart(2, "0")}.png`);
        await cropToPng(path, { x1: 0, y1: top, x2: full.width, y2: bottom }, chunkPng, signal);
        const chunkJpeg = await scratchPath(`ocr-${randomUUID().slice(0, 8)}.jpg`);
        await cropToJpeg(path, { x1: 0, y1: top, x2: full.width, y2: bottom }, chunkJpeg, signal);
        let text = "";
        let used: ChunkResult["engine"] = "none";
        let status: ChunkResult["status"] = "empty";
        let failure: string | undefined;
        if (hasTesseract) {
          try {
            const bytes = new Uint8Array(await readFile(chunkPng, { signal }));
            const out = await ocrWithTesseract(bytes, Math.min(12_000, deadlineAt - Date.now()), signal);
            text = out.trim();
            used = "tesseract";
            status = text === "" ? "empty" : "ok";
          } catch (error) {
            if (signal?.aborted) throw error;
            failure = error instanceof Error ? error.message : String(error);
            if (engine === "tesseract") {
              results.push({ chunk: i + 1, top, bottom, engine: "tesseract", status: "failed", chars: 0, text: "", error: failure });
              continue;
            }
          }
        }
        if (text === "" && engine !== "tesseract" && visionFailed) {
          results.push({
            chunk: i + 1,
            top,
            bottom,
            engine: "none",
            status: "skipped",
            chars: 0,
            text: "",
            error: "vision backend unavailable after an earlier chunk failed",
          });
          continue;
        }
        if (text === "" && engine !== "tesseract" && Date.now() < deadlineAt) {
          try {
            const part = await imagePartFromPath(chunkJpeg, { signal });
            const answer = await chain.ask(
              ctx.modelRegistry,
              [part],
              "请原样转述这张长截图分片中的所有文字,保持阅读顺序(从上到下、从左到右)," +
                "不要添加解释,只输出文字本身。如果画面中没有可见文字,只输出 EMPTY,不要编造内容。",
              {
                signal,
                deadlineAt,
                currentModel: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
              },
            );
            if (!answer.ok) {
              const detail = parseVisionFailure(answer.json);
              visionFailed = true;
              used = "none";
              status = "failed";
              failure = typeof detail.reason === "string" ? detail.reason : answer.json;
              results.push({
                chunk: i + 1,
                top,
                bottom,
                engine: used,
                status,
                chars: 0,
                text: "",
                error: failure,
                ...(typeof detail.code === "string" ? { code: detail.code } : {}),
                ...(Array.isArray(detail.attemptedBackends) ? { attemptedBackends: detail.attemptedBackends } : {}),
              });
              continue;
            } else {
              text = answer.text.trim();
              failure = undefined;
              // 不对密集文本设置人为字符上限；后端返回多少就完整保留多少。
              used = "vision";
              status = text === "" || text === "EMPTY" ? "empty" : "ok";
              if (text === "EMPTY") text = "";
            }
          } catch (error) {
            if (signal?.aborted) throw error;
            used = "none";
            status = "failed";
            failure = error instanceof Error ? error.message : String(error);
          }
        }
        if (used === "none" && status === "empty" && Date.now() >= deadlineAt) {
          status = "skipped";
          failure = "OCR deadline exceeded before this chunk could be completed";
        }
        results.push({ chunk: i + 1, top, bottom, engine: used, status, chars: text.length, text, ...(failure ? { error: failure } : {}) });
      }

      const joined = mergeOcrChunks(results.map((r) => r.text));
      const engines: Record<string, number> = {};
      for (const r of results) engines[r.engine] = (engines[r.engine] ?? 0) + 1;
      const failed = results.filter((r) => r.status === "failed").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const processed = results.length - skipped;
      const complete = failed === 0 && skipped === 0 && results.length === windows.length;
      const manifest = {
        source: params.image,
        runId: invocation,
        ok: complete,
        complete,
        width: full.width,
        height: full.height,
        chunkHeight,
        overlap,
        chunks: results.length,
        processed,
        failed,
        skipped,
        engines,
        perChunk: results.map(({ text, ...rest }) => rest),
      };
      const manifestPath = join(dir, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      const mdPath = join(dir, "ocr.md");
      await writeFile(mdPath, joined, "utf8");
      const summary = {
        ok: complete,
        complete,
        text: joined,
        chunks: results.length,
        processed,
        failed,
        skipped,
        engines,
        markdownPath: mdPath,
        manifestPath,
        artifactsDir: dir,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary) }], details: { ...summary, text: undefined } };
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const steps = Number.isInteger(params.steps) && params.steps > 0 ? Math.min(params.steps, 16) : 4;
      const colorMode = params.color !== false;
      // 矢量化在 ~1MP 之外无收益,potrace 成本随像素陡增(dsh 同款上限)
      const full = await probeImage(path, signal);
      const fit = fitInside(full.width, full.height, Math.round(Math.sqrt(1_000_000)), Math.round(Math.sqrt(1_000_000)));
      const img = await decodeImage(path, fit, signal);
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
        const pngs = await Promise.all(grayMasks.map((gray) => maskToPng(gray, img.width, img.height, signal)));
        svg = await runPotraceWorker(
          { mode: "color", pngs: pngs.map((png, i) => ({ hex: palette[i].hex, png })), width: img.width, height: img.height },
          60_000,
          signal,
        );
      } else {
        // 灰度模式直接把原图(限像素后)编码成 PNG 交给 posterize
        const srcPng = await scratchPath(`trace-${randomUUID().slice(0, 8)}.png`);
        // encodePng 输入是 RGBA,原图已是 RGBA
        await encodePng(img.data, img.width, img.height, srcPng, signal);
        svg = await runPotraceWorker({ mode: "gray", png: await readFile(srcPng, { signal }), steps, fillStrategy: "dominant" }, 60_000, signal);
      }
      const target = await saveArtifactBytes(
        ctx.cwd,
        `${artifactStem(params.image, colorMode ? "trace-color" : `trace-${steps}`)}-${runId()}.svg`,
        svg,
      );
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
      "write the cutout as a transparent PNG artifact. Best for logos on uniform backgrounds. " +
      "Images above 4 megapixels are proportionally reduced to at most 2000x2000 before processing; " +
      "the result reports originalWidth/originalHeight and scaled.",
    promptSnippet: "Cut out the foreground by flood-filling a solid background to transparency",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      tolerance: Type.Optional(Type.Number({ description: "Max per-channel color distance from the background, default 40" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const full = await probeImage(path, signal);
      // 同 dsh 的 CPU 保护:洪水填充是同步像素遍历,超 4MP 先降
      const fit = full.width * full.height > 4_000_000 ? fitInside(full.width, full.height, 2000, 2000) : undefined;
      const img = await decodeImage(path, fit, signal);
      const tolerance = Number.isFinite(params.tolerance) && params.tolerance >= 0 ? Math.round(params.tolerance) : 40;
      const cutout = floodFillBackground(img.data, img.width, img.height, tolerance);
      const outPath = await artifactPath(ctx.cwd, `${artifactStem(params.image, "fg")}-${runId()}.png`);
      await encodePng(cutout, img.width, img.height, outPath, signal);
      const info = await stat(outPath);
      const result = {
        path: outPath,
        width: img.width,
        height: img.height,
        originalWidth: full.width,
        originalHeight: full.height,
        scaled: fit !== undefined,
        bytes: info.size,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
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
      const launchArgs = ["--disable-gpu", "--hide-scrollbars", "--incognito"];
      if (fullPage) {
        // lazy 图片在首屏外不加载:整页截取前关掉懒加载
        launchArgs.push("--blink-settings=imagesLazyLoadingEnabled=false");
      }
      const browser = await puppeteer.default.launch({ executablePath, headless: true, args: launchArgs });
      const timeoutSignal = AbortSignal.timeout(TASK_DEADLINE_MS);
      const deadlineSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const closeOnAbort = () => { void browser.close().catch(() => {}); };
      deadlineSignal.addEventListener("abort", closeOnAbort, { once: true });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width, height });
        await page.goto(pathToFileURL(targetPath).href, { waitUntil: "networkidle0", timeout: 30_000, signal: deadlineSignal });
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
          if (deadlineSignal.aborted) throw abortError();
          pageHeight = await page.evaluate(() =>
            Math.max(
              document.documentElement.scrollHeight,
              document.body ? document.body.scrollHeight : 0,
              window.innerHeight,
            ),
          );
        }
        if (deadlineSignal.aborted) throw abortError();
        const png = fullPage ? await page.screenshot({ type: "png", fullPage: true }) : await page.screenshot({ type: "png" });
        const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`;
        const outPath = await saveArtifactBytes(ctx.cwd, `${artifactStem(source, stem)}-${runId()}.png`, new Uint8Array(png));
        const result: Record<string, unknown> = { path: outPath, width, height, bytes: png.length };
        if (fullPage && pageHeight !== undefined) result.pageHeight = pageHeight;
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { path: outPath } };
      } finally {
        deadlineSignal.removeEventListener("abort", closeOnAbort);
        await browser.close().catch(() => {});
      }
    },
  });

  // 每轮结束清理像素管线临时目录(bin/meta 中间物)
  pi.on("agent_end", async () => {
    await cleanupScratch().catch(() => {});
  });
}
