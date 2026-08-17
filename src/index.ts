// pi-vision-tools:给纯文本模型(DeepSeek 等)补视觉能力的工具扩展。
// 思路来自 dsh-vision-router:文本模型当大脑,视觉模型只当眼睛——
// 看图是工具调用,不是整轮切模型,可多步迭代(ground -> crop -> describe -> diff)。
// 工具描述文案与失败语义沿 dsh 调教版(见 ../../reference/核心依据/dsh-vision-router/)。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visionDescribePrompt, extractJson } from "./backends";
import { VisionChain } from "./chain";
import { registerLookTools } from "./tools-look";
import { registerPixelTools } from "./tools-pixels";
import { imagePartFromPath } from "./pixels";

const TASK_DEADLINE_MS = 180_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 用户贴图落地目录(dsh attachmentId 的 pi 等价物:文件路径即引用)
const ATTACHMENTS_DIR = join(tmpdir(), "pi-vision-attachments");

const DESCRIPTION =
  "Look at images with the vision backend chain and answer a focused question about them. " +
  "For text-only sessions this is the bridge that provides image understanding; for native multimodal " +
  "sessions it is an optional second look for structured evidence, comparison or verification. " +
  "Supports comparing multiple images (e.g. a design mock vs an implementation screenshot). Provide " +
  "`paths` (local image file paths, png/jpeg/webp/gif), 1-4 images in total. `question` is the " +
  "question to answer; be specific. Set `json: true` to require a single valid JSON object as the answer. " +
  "FAILURE SEMANTICS: if the result is JSON with ok:false and a code like VISION_AUTH_FAILED, " +
  "VISION_RATE_LIMITED, VISION_TIMEOUT or VISION_BACKEND_UNAVAILABLE_THIS_TURN, the vision backends " +
  "are unavailable this turn. Do NOT call vision_describe again with a reworded question — rephrasing " +
  "cannot fix an auth, rate-limit or outage problem. Answer from the information you already have and " +
  "continue the text task, telling the user vision is temporarily unavailable. " +
  "Only content-level uncertainty in a SUCCESSFUL answer justifies a second look.";

interface PastedImage {
  type: "image";
  source: { type: "base64"; media_type?: string; mediaType?: string; data: string };
}

export default function (pi: ExtensionAPI) {
  const chain = new VisionChain();

  // 多模态模型用自己的原生视觉工作(用户拍板):vision_describe 只是"看图回答",
  // 多模态模型原生就能做,禁用避免冗余后端调用;像素级工具(ground/detect/
  // crop/diff/ocr/trace/…)是原生视觉做不了的度量操作,对任何模型一律保留。
  // 回加只针对自己移除的:用户经 pi config 手动禁用的不碰。
  let describeRemovedByUs = false;
  const applyDescribeGating = (model: { input?: readonly string[] } | undefined) => {
    const multimodal = model?.input?.includes("image") === true;
    const active = pi.getActiveTools();
    if (multimodal) {
      const next = active.filter((name) => name !== "vision_describe");
      if (next.length !== active.length) {
        pi.setActiveTools(next);
        describeRemovedByUs = true;
      }
    } else if (describeRemovedByUs && !active.includes("vision_describe")) {
      pi.setActiveTools([...new Set([...active, "vision_describe"])]);
      describeRemovedByUs = false;
    }
  };
  // 启动/换模型都重算:会话启动时模型已定,session_start 覆盖;会话内 /model
  // 切换由 model_select 覆盖(纯文本 ↔ 多模态互切即时生效)
  pi.on("session_start", async (_event, ctx) => {
    applyDescribeGating(ctx.model as { input?: readonly string[] } | undefined);
  });
  pi.on("model_select", async (event) => {
    applyDescribeGating(event.model as { input?: readonly string[] });
  });

  pi.on("agent_start", async () => {
    chain.beginTurn();
  });

  // 用户在会话里贴的图落地成文件并告知路径。
  // 按模型能力分支(多模态:图直接进上下文,工具非必需;纯文本:工具是唯一看图途径)
  pi.on("before_agent_start", async (event, ctx) => {
    const images = (event as { images?: PastedImage[] }).images ?? [];
    const saved: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      if (!image || image.type !== "image" || image.source?.type !== "base64" || !image.source.data) continue;
      const mediaType = image.source.mediaType ?? image.source.media_type ?? "image/png";
      const ext = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : "png";
      await mkdir(ATTACHMENTS_DIR, { recursive: true });
      const target = join(ATTACHMENTS_DIR, `pasted-${Date.now()}-${i + 1}.${ext}`);
      await writeFile(target, Buffer.from(image.source.data, "base64"));
      saved.push(target);
    }
    if (saved.length === 0) return undefined;
    const multimodal = ctx.model?.input?.includes("image") === true;
    const content = multimodal
      ? `The user attached ${saved.length} image(s), also saved to disk (you can see them directly). ` +
        `For pixel-precise work (bounding boxes, diff metrics, cropping) the vision_* tools are available; ` +
        `a plain description question needs no tool:\n${saved.join("\n")}`
      : `The user attached ${saved.length} image(s) in this message. A text-only model cannot see them directly; ` +
        `they were saved to disk. Use the vision_* tools (vision_describe / vision_ground / vision_ocr ...) ` +
        `with these paths to look at them:\n${saved.join("\n")}`;
    return {
      message: {
        customType: "pi-eyes",
        content,
        display: true,
      },
    };
  });

  pi.registerTool({
    name: "vision_describe",
    label: "Vision Describe",
    description: DESCRIPTION,
    promptSnippet: "Look at local image files and answer focused questions via vision backends",
    promptGuidelines: [
      "Use vision_describe when a task involves looking at image files (screenshots, photos, diagrams) or comparing several; text-only models cannot see images without it.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 4,
        description:
          "Local image file paths (png/jpeg/webp/gif), absolute or relative to the working directory, 1-4 images",
      }),
      question: Type.String({
        description: 'The question for the vision model, e.g. "compare the two images and list the differences"',
      }),
      json: Type.Optional(Type.Boolean({ description: "Require the answer to be a single valid JSON object" })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // 读取并校验图片(路径错误是调用方问题,直接抛错让模型看到并自行修正)
      const images = [];
      for (const raw of params.paths) {
        const trimmed = raw.startsWith("@") ? raw.slice(1) : raw;
        const path = resolve(ctx.cwd, trimmed);
        onUpdate?.({ content: [{ type: "text", text: `Reading ${trimmed}…` }] });
        try {
          images.push(await imagePartFromPath(path, MAX_IMAGE_BYTES));
        } catch (error) {
          throw new Error(`vision_describe: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const prompt = visionDescribePrompt(params.question, params.json === true);
      const deadlineAt = Date.now() + TASK_DEADLINE_MS;
      const answer = await chain.ask(ctx.modelRegistry, images, prompt, { signal, deadlineAt });
      if (!answer.ok) {
        return { content: [{ type: "text", text: answer.json }], details: { backend: "none", attempts: answer.json } };
      }

      let text = answer.text;
      // json 模式:解析失败给一次"只回 JSON"的纠错重试(dsh 同款策略)
      if (params.json === true) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const parsed = extractJson(text);
          if (parsed !== undefined) {
            text = JSON.stringify(parsed);
            break;
          }
          if (attempt === 0) {
            onUpdate?.({ content: [{ type: "text", text: "Answer was not valid JSON, retrying…" }] });
            const retry = await chain.ask(
              ctx.modelRegistry,
              images,
              prompt + "\n\nThat output was not valid JSON. Respond with ONLY a valid JSON object now.",
              { signal, deadlineAt },
            );
            if (!retry.ok) return { content: [{ type: "text", text: retry.json }], details: { backend: "none" } };
            text = retry.text;
          }
        }
      }
      return { content: [{ type: "text", text }], details: { backend: answer.backend } };
    },
  });

  registerLookTools(pi, chain);
  registerPixelTools(pi, chain);
}
