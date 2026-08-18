// 看图工具组:vision_ground(定位)/ vision_detect(元素清单)/
// vision_crop(裁剪)/ vision_present(展示给用户)。
// 描述文案与 prompt 沿 dsh 调教版;像素操作走 PS 管线。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { stat, mkdir } from "node:fs/promises";
import type { VisionChain } from "./chain";
import {
  decodeImage,
  probeImage,
  cropToPng,
  annotateBoxes,
  artifactStem,
  artifactsDir,
  imagePartFromPath,
} from "./pixels";
import { extractJson } from "./backends";
import { normalizeDetectResult, type Box } from "./algorithms";

// dsh 同款 deadline 预算:一次工具任务内所有后端尝试与重试共享
const TASK_DEADLINE_MS = 180_000;

const IMAGE_ARG_DOC = "Local image path (png/jpeg/webp/gif), absolute or relative to the working directory";

/** 统一路径解析:剥 @ 前缀、相对 cwd。 */
function resolveImagePath(cwd: string, input: string): string {
  const trimmed = input.startsWith("@") ? input.slice(1) : input;
  return resolve(cwd, trimmed);
}

/** 从视觉模型 JSON 输出取 box 对象(dsh parseBox 的对象分支)。 */
function boxFromObject(value: unknown): Box | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  const x1 = b.x1;
  const y1 = b.y1;
  const x2 = b.x2;
  const y2 = b.y2;
  if (![x1, y1, x2, y2].every((n) => Number.isInteger(n))) return undefined;
  if ((x1 as number) < 0 || (y1 as number) < 0 || (x2 as number) <= (x1 as number) || (y2 as number) <= (y1 as number)) {
    return undefined;
  }
  return { x1: x1 as number, y1: y1 as number, x2: x2 as number, y2: y2 as number };
}

function clampBox(box: Box, width: number, height: number): Box {
  return {
    x1: Math.max(0, Math.min(box.x1, width - 1)),
    y1: Math.max(0, Math.min(box.y1, height - 1)),
    x2: Math.max(1, Math.min(box.x2, width)),
    y2: Math.max(1, Math.min(box.y2, height)),
  };
}

export function registerLookTools(pi: ExtensionAPI, chain: VisionChain): void {
  // ── vision_ground ──────────────────────────────────────────────
  pi.registerTool({
    name: "vision_ground",
    label: "Vision Ground",
    description:
      "Locate a target in an image and return its ORIGINAL-pixel bounding box (x1/y1/x2/y2), " +
      "optionally producing an annotated PNG artifact. Pair with vision_crop and vision_pixel_diff " +
      "for a verify-able pixel loop (reference -> implementation -> screenshot -> metrics). " +
      "Use this for one named target; use vision_detect for every matching element. Annotation is off by default. " +
      "If the result is JSON with ok:false, inspect retryable: correct invalid input when true; when false, " +
      "do not retry with only reworded instructions this turn.",
    promptSnippet: "Locate a target in an image and get its original-pixel bounding box",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      target: Type.String({ minLength: 1, description: 'Required target to locate, e.g. "the send button"' }),
      annotate: Type.Optional(Type.Boolean({ description: "Also write an annotated PNG with the box drawn (default false)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const { width, height } = await probeImage(path, signal);
      if (width <= 0 || height <= 0) throw new Error("vision_ground: could not read image dimensions");
      const target = params.target.trim();
      if (target === "") throw new Error("vision_ground: target is required and cannot be blank");
      const deadlineAt = Date.now() + TASK_DEADLINE_MS;
      const part = await imagePartFromPath(path, { signal });

      const instruction =
        `Target to locate: "${target.slice(0, 500)}". ` +
        `The image is ${width}x${height} pixels. Return ONE JSON object with integer fields ` +
        `{"x1":...,"y1":...,"x2":...,"y2":...} — the tight bounding box of that target in ` +
        `ORIGINAL image pixels (0 <= x1 < x2 <= ${width}, 0 <= y1 < y2 <= ${height}). ` +
        `Output only the JSON object.`;

      const currentModel = ctx.model
        ? { provider: ctx.model.provider, modelId: ctx.model.id }
        : undefined;
      let answer = await chain.ask(ctx.modelRegistry, [part], instruction, { signal, deadlineAt, currentModel });
      if (!answer.ok) return { content: [{ type: "text", text: answer.json }], details: { backend: "none" } };
      let box = boxFromObject(extractJson(answer.text));
      if (box === undefined) {
        throw new Error(`vision_ground: the vision model did not return a valid box. Raw output: ${answer.text.slice(0, 500)}`);
      }
      let clamped = clampBox(box, width, height);

      // 退化窄条(宽或高 < 2px)时按 dsh 策略重试一次,要求完整框
      if (clamped.x2 - clamped.x1 < 2 || clamped.y2 - clamped.y1 < 2) {
        answer = await chain.ask(
          ctx.modelRegistry,
          [part],
          `Your previous box ${JSON.stringify(clamped)} was a degenerate sliver, not the target. ` +
            `Return ONE JSON object with the FULL tight bounding box of the target in ORIGINAL ` +
            `image pixels (0 <= x1 < x2 <= ${width}, 0 <= y1 < y2 <= ${height}). Output only the JSON object.`,
          { signal, deadlineAt, currentModel },
        );
        if (!answer.ok) return { content: [{ type: "text", text: answer.json }], details: { backend: "none" } };
        box = boxFromObject(extractJson(answer.text));
        if (box === undefined) {
          throw new Error(
            `vision_ground: the vision model returned a degenerate box (${clamped.x1},${clamped.y1},${clamped.x2},${clamped.y2}) ` +
              `and the retry returned no valid box. Raw output: ${answer.text.slice(0, 500)}`,
          );
        }
        clamped = clampBox(box, width, height);
        if (clamped.x2 - clamped.x1 < 2 || clamped.y2 - clamped.y1 < 2) {
          throw new Error(
            `vision_ground: the vision model returned only degenerate boxes for a ${width}x${height} image. ` +
              `Last raw output: ${answer.text.slice(0, 500)}`,
          );
        }
      }

      const result: Record<string, unknown> = { ...clamped, width, height, backend: answer.backend };
      if (params.annotate === true) {
        const outPath = await artifactPath(ctx.cwd, `${artifactStem(params.image, `ground-${randomUUID().slice(0, 8)}`)}.png`);
        await annotateBoxes(path, [clamped], outPath, signal);
        result.annotatedPath = outPath;
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { backend: answer.backend } };
    },
  });

  // ── vision_detect ──────────────────────────────────────────────
  pi.registerTool({
    name: "vision_detect",
    label: "Vision Detect",
    description:
      "Find every element of a kind in an image (buttons, inputs, links, icons…) and return a " +
      "numbered inventory with ORIGINAL-pixel boxes, optionally annotated on the image. The model " +
      'can then reference "element #3" in follow-up vision_crop / vision_describe calls. ' +
      "Use this for all matches of a required target kind; use vision_ground for one named target. " +
      "Annotation is off by default. " +
      "If the result is JSON with ok:false, inspect retryable: correct invalid input when true; when false, " +
      "do not retry with only reworded instructions this turn.",
    promptSnippet: "List every element of a kind in an image with numbered original-pixel boxes",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      target: Type.String({
        minLength: 1,
        description: 'Required kind of elements to list, e.g. "buttons", "input fields", or "navigation links"',
      }),
      annotate: Type.Optional(Type.Boolean({ description: "Also write an annotated PNG with numbered boxes (default false)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const { width, height } = await probeImage(path, signal);
      if (width <= 0 || height <= 0) throw new Error("vision_detect: could not read image dimensions");
      const target = params.target.trim();
      if (target === "") throw new Error("vision_detect: target is required and cannot be blank");
      const deadlineAt = Date.now() + TASK_DEADLINE_MS;
      const part = await imagePartFromPath(path, { signal });

      const instruction = visionDetectInstruction(target, width, height);
      const currentModel = ctx.model
        ? { provider: ctx.model.provider, modelId: ctx.model.id }
        : undefined;
      let answer = await chain.ask(ctx.modelRegistry, [part], instruction, { signal, deadlineAt, currentModel });
      if (!answer.ok) return { content: [{ type: "text", text: answer.json }], details: { backend: "none" } };
      let parsed = extractJson(answer.text);
      if (parsed === undefined) {
        const retry = await chain.ask(
          ctx.modelRegistry,
          [part],
          instruction + "\nYour previous answer was not valid JSON. Respond with ONLY the JSON object, no prose, no fences.",
          { signal, deadlineAt, currentModel },
        );
        if (!retry.ok) return { content: [{ type: "text", text: retry.json }], details: { backend: "none" } };
        answer = retry;
        parsed = extractJson(retry.text);
      }
      const normalized = normalizeDetectResult(parsed, width, height);
      if (normalized === undefined) {
        throw new Error(`vision_detect: the vision model did not return a valid inventory. Raw output: ${answer.text.slice(0, 500)}`);
      }
      const result: typeof normalized & { annotatedPath?: string } = normalized;
      if (params.annotate === true && result.elements.length > 0) {
        const outPath = await artifactPath(ctx.cwd, `${artifactStem(params.image, `detect-${randomUUID().slice(0, 8)}`)}.png`);
        await annotateBoxes(
          path,
          result.elements.map((e) => ({ ...e.box, label: String(e.number) })),
          outPath,
          signal,
        );
        result.annotatedPath = outPath;
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { backend: answer.backend } };
    },
  });

  // ── vision_crop ────────────────────────────────────────────────
  pi.registerTool({
    name: "vision_crop",
    label: "Vision Crop",
    description:
      "Crop a pixel region (x1,y1,x2,y2 in ORIGINAL pixels) out of an image and write the " +
      "result as a PNG artifact. This is a local transform and does not inspect the crop. A text-only " +
      "model must pass the returned path to vision_describe, vision_ocr, or another analysis tool.",
    promptSnippet: "Crop a pixel region to a PNG; analyze the returned path with another vision tool",
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      region: Type.String({ description: 'Pixel box "x1,y1,x2,y2" in original image coordinates' }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const { width, height } = await probeImage(path, signal);
      const box = parseRegion(params.region);
      if (box === undefined) {
        throw new Error(`vision_crop: invalid region "${params.region}" (expect "x1,y1,x2,y2" integers)`);
      }
      if (box.x2 > width || box.y2 > height) {
        throw new Error(`vision_crop: region exceeds image bounds (${width}x${height})`);
      }
      const name = `${artifactStem(params.image, `crop-${box.x1}-${box.y1}-${box.x2}-${box.y2}-${randomUUID().slice(0, 8)}`)}.png`;
      const outPath = await artifactPath(ctx.cwd, name);
      await cropToPng(path, box, outPath, signal);
      const info = await stat(outPath);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path: outPath, width: box.x2 - box.x1, height: box.y2 - box.y1, bytes: info.size }),
          },
        ],
        details: { outPath },
      };
    },
  });

  // ── vision_present ─────────────────────────────────────────────
  pi.registerTool({
    name: "vision_present",
    label: "Vision Present",
    description:
      "Return a local image as inline tool-result content so it can be previewed in pi without opening an " +
      "external system viewer. Use this only when an inline preview adds value or the user asks to see the " +
      "artifact; creating or analyzing an image does not require this extra call.",
    promptSnippet: "Preview a local image inline in pi without opening an external viewer",
    promptGuidelines: [
      "Use vision_present only for an intentional inline preview; do not call it automatically after every generated, edited, cropped, or exported image.",
    ],
    parameters: Type.Object({
      image: Type.String({ description: IMAGE_ARG_DOC }),
      label: Type.Optional(Type.String({ description: "Optional short user-facing label for the image" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const path = resolveImagePath(ctx.cwd, params.image);
      const image = await imagePartFromPath(path, { signal });
      const label = params.label && params.label.trim() !== "" ? params.label.trim().slice(0, 200) : "image";
      return {
        content: [
          { type: "text", text: JSON.stringify({ path, label, presented: "inline" }) },
          { type: "image", data: image.data, mimeType: image.mediaType },
        ],
        details: { path, label, presented: "inline" },
      };
    },
  });
}

function parseRegion(value: string): Box | undefined {
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return undefined;
  const [x1, y1, x2, y2] = parts;
  if (x1 < 0 || y1 < 0 || x2 <= x1 || y2 <= y1) return undefined;
  return { x1, y1, x2, y2 };
}

/** dsh visionDetectInstruction 原文。 */
function visionDetectInstruction(target: string, width: number, height: number): string {
  return (
    `The image is ${width}x${height} pixels. Find every "${target.slice(0, 300)}" in it. ` +
    "Return ONE JSON object and nothing else, shaped EXACTLY as:\n" +
    '{"elements":[{"label":"<short element name>","box":{"x1":0,"y1":0,"x2":0,"y2":0}},...]}\n' +
    '- "elements" is a numbered list (array order = element number) of every match, from top-left to bottom-right in reading order;\n' +
    "- every box is the tight bounding box in ORIGINAL image pixels, integers, 0 <= x1 < x2 <= " +
    `${width}, 0 <= y1 < y2 <= ${height}` +
    ';\n- if nothing matches, return {"elements":[]}.'
  );
}

/** 工件绝对路径(建目录,不写文件)。 */
async function artifactPath(cwd: string, name: string): Promise<string> {
  const dir = artifactsDir(cwd);
  await mkdir(dir, { recursive: true });
  return join(dir, name);
}
