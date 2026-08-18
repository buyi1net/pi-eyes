// pi-vision-tools:给纯文本模型(DeepSeek 等)补视觉能力的工具扩展。
// 思路来自 dsh-vision-router:文本模型当大脑,视觉模型只当眼睛——
// 看图是工具调用,不是整轮切模型,可多步迭代(ground -> crop -> describe -> diff)。
// 工具描述文案与失败语义沿 dsh 调教版(见 ../../reference/核心依据/dsh-vision-router/)。

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type ImageContent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visionDescribePrompt, extractJson, isStructuredDescription } from "./backends";
import { VisionChain } from "./chain";
import {
  DEFAULT_PI_EYES_CONFIG,
  getPiEyesConfigPaths,
  loadPiEyesConfig,
  savePiEyesConfig,
  type ResolvedPiEyesConfig,
} from "./config";
import { testPiVisionModel } from "./pi-model-backend";
import { registerEyesSetup, type EyesSetupConfig, type SetupScope } from "./setup";
import { registerLookTools } from "./tools-look";
import { registerPixelTools } from "./tools-pixels";
import { imagePartFromPath } from "./pixels";

const TASK_DEADLINE_MS = 180_000;
const VISION_PROBE_IMAGE = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAAlklEQVR4nO3RwQkAMAgEwSs9nRvSQ+BARty/MplkmuWU674/9QsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAOgLfFkm7tAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD7MBUWbzxwABZ5XAAAAAElFTkSuQmCC",
};
const VISION_PROBE_EXPECTED = ["red", "green", "blue", "yellow", "black", "white"] as const;
// 用户贴图落地目录(dsh attachmentId 的 pi 等价物:文件路径即引用)
const ATTACHMENTS_DIR = join(tmpdir(), "pi-vision-attachments", `${process.pid}-${randomUUID()}`);

const DESCRIPTION =
  "Answer a semantic question about one or more images with the vision backend chain. " +
  "For text-only sessions this is the bridge that provides image understanding; for native multimodal " +
  "sessions it is an optional second opinion for structured evidence, comparison or verification. " +
  "Use vision_ocr for faithful text extraction, vision_ground for one target box, vision_detect for an " +
  "inventory of matching elements, and vision_colors for a measured palette instead of asking this tool " +
  "to approximate those operations. Supports image comparison; provide " +
  "`paths` (local image file paths, png/jpeg/webp/gif), 1-4 images in total. `question` is the " +
  "question to answer; be specific. Set `json: true` for the fixed object schema " +
  "{summary,layout,entities,text}, not an arbitrary caller-defined schema. Paths may be absolute or " +
  "relative to the working directory. " +
  "FAILURE SEMANTICS: if the result is JSON with ok:false, inspect retryable. A retryable:true result " +
  "means the path, format, count, size, or parameters must be corrected before retrying. For retryable:false " +
  "codes like VISION_AUTH_FAILED, " +
  "VISION_RATE_LIMITED, VISION_TIMEOUT or VISION_BACKEND_UNAVAILABLE, the vision backends " +
  "are unavailable this turn. Do NOT call vision_describe again with only a reworded question — rephrasing " +
  "cannot fix an auth, rate-limit or outage problem. Answer from the information you already have and " +
  "continue the text task, telling the user vision is temporarily unavailable. " +
  "Only content-level uncertainty in a SUCCESSFUL answer justifies a second look.";

function configPaths(ctx: ExtensionContext) {
  return getPiEyesConfigPaths(ctx.cwd, getAgentDir(), CONFIG_DIR_NAME);
}

function setupLanguage(config: ResolvedPiEyesConfig): "zh-CN" | "en" {
  if (config.ui.language !== "auto") return config.ui.language;
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function toSetupConfig(config: ResolvedPiEyesConfig): EyesSetupConfig {
  return {
    schemaVersion: 2,
    language: setupLanguage(config),
    backend: {
      route: {
        mode: config.backend.route.mode,
        allowedModels: config.backend.route.allowedModels?.map((model) => ({ ...model })) ?? null,
        ...(config.backend.route.fixedModel ? { fixedModel: { ...config.backend.route.fixedModel } } : {}),
      },
      ovhPublicChain: { ...config.backend.ovhPublicChain },
    },
  };
}

function setupUpdate(config: EyesSetupConfig): Record<string, unknown> {
  return {
    schemaVersion: 2,
    ui: { language: config.language },
    backend: {
      route: {
        mode: config.backend.route.mode,
        allowedModels: config.backend.route.allowedModels?.map((model) => ({ ...model })) ?? null,
        ...(config.backend.route.fixedModel ? { fixedModel: { ...config.backend.route.fixedModel } } : {}),
      },
      ovhPublicChain: { ...config.backend.ovhPublicChain },
    },
  };
}

export default function (pi: ExtensionAPI) {
  const chain = new VisionChain();
  let activeConfig = DEFAULT_PI_EYES_CONFIG;

  const applyConfig = async (ctx: ExtensionContext, showWarnings = false): Promise<ResolvedPiEyesConfig> => {
    const loaded = await loadPiEyesConfig({
      ...configPaths(ctx),
      projectTrusted: ctx.isProjectTrusted(),
    });
    activeConfig = loaded.config;
    chain.setRouting({
      route: {
        mode: activeConfig.backend.route.mode,
        allowedModels: activeConfig.backend.route.allowedModels?.map((model) => ({
          provider: model.provider,
          modelId: model.model,
        })) ?? null,
        ...(activeConfig.backend.route.fixedModel
          ? {
              fixedModel: {
                provider: activeConfig.backend.route.fixedModel.provider,
                modelId: activeConfig.backend.route.fixedModel.model,
              },
            }
          : {}),
      },
      ovhPublicChain: { ...activeConfig.backend.ovhPublicChain },
    });
    if (showWarnings && ctx.hasUI) {
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    }
    return activeConfig;
  };

  const saveSetupConfig = async (
    scope: SetupScope,
    config: EyesSetupConfig,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    if (scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error("当前项目未受信任，不能写入项目级 Pi Eyes 配置");
    }
    const paths = configPaths(ctx);
    await savePiEyesConfig(scope === "project" ? paths.projectPath : paths.globalPath, setupUpdate(config));
    await applyConfig(ctx, true);
  };

  registerEyesSetup(pi, {
    loadConfig: async (ctx) => toSetupConfig(await applyConfig(ctx, true)),
    saveConfig: saveSetupConfig,
    refreshModels: async (ctx) => {
      const result = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: ctx.signal });
      if (result.aborted) throw new Error("Pi 模型目录刷新已取消");
      if (result.errors.size > 0) {
        const details = [...result.errors.entries()]
          .map(([provider, error]) => `${provider}: ${error.message}`)
          .join("; ");
        throw new Error(details);
      }
    },
    testModel: async (model, ctx) => {
      const result = await testPiVisionModel(
        ctx.modelRegistry,
        { provider: model.provider, modelId: model.id },
        VISION_PROBE_IMAGE,
        VISION_PROBE_EXPECTED,
        { signal: ctx.signal },
      );
      return {
        ok: result.passed,
        message: `${result.matched}/${result.total}`,
      };
    },
  });

  // 不动态改写 active tools。多模态模型是否保留 vision_describe 由用户配置决定，
  // 避免模型切换时把用户原本禁用的工具擅自重新启用。

  pi.on("session_start", async (_event, ctx) => {
    await applyConfig(ctx, true);
  });

  pi.on("agent_start", async () => {
    chain.beginTurn();
  });

  pi.on("session_shutdown", async () => {
    await rm(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  // 用户在会话里贴的图落地成文件并告知路径。
  // 按模型能力分支(多模态:图直接进上下文,工具非必需;纯文本:工具是唯一看图途径)
  pi.on("before_agent_start", async (event, ctx) => {
    const images: ImageContent[] = event.images ?? [];
    const saved: string[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      if (!image.data) continue;
      const mediaType = image.mimeType || "image/png";
      const ext =
        mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : mediaType === "image/gif" ? "gif" : "png";
      await mkdir(ATTACHMENTS_DIR, { recursive: true });
      const target = join(ATTACHMENTS_DIR, `pasted-${Date.now()}-${i + 1}.${ext}`);
      await writeFile(target, Buffer.from(image.data, "base64"));
      saved.push(target);
    }
    if (saved.length === 0) return undefined;
    const multimodal = ctx.model?.input?.includes("image") === true;
    const content = multimodal
      ? `The user attached ${saved.length} image(s), also saved to disk (you can see them directly). ` +
        `Use native vision for ordinary viewing; use vision_ground/detect for boxes, vision_ocr for exact text, ` +
        `vision_colors/pixel_diff for measurements, and vision_crop for a local transform:\n${saved.join("\n")}`
      : `The user attached ${saved.length} image(s) in this message. A text-only model cannot see them directly; ` +
        `they were saved to disk. Use vision_describe for visual meaning, vision_ocr for exact text, ` +
        `vision_ground/detect for locations, or vision_colors/pixel_diff for measurements. After vision_crop ` +
        `or vision_trace, pass the returned path to vision_describe or the relevant analysis tool:\n${saved.join("\n")}`;
    return {
      message: {
        customType: "pi-eyes",
        content,
        display: false,
      },
    };
  });

  pi.registerTool({
    name: "vision_describe",
    label: "Vision Describe",
    description: DESCRIPTION,
    promptSnippet: "Look at local image files and answer focused questions via vision backends",
    promptGuidelines: [
      "Use vision_describe for semantic image understanding or comparison. For exact text, boxes, palettes, or pixel metrics, use the corresponding specialized vision tool instead.",
    ],
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 4,
        description:
          "Local image paths (png/jpeg/webp/gif), absolute or relative to the working directory, 1-4 images",
      }),
      question: Type.String({
        description: 'The question for the vision model, e.g. "compare the two images and list the differences"',
      }),
      json: Type.Optional(
        Type.Boolean({ description: "Return the fixed {summary,layout,entities,text} JSON object (default false)" }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // 读取并校验图片(路径错误是调用方问题,直接抛错让模型看到并自行修正)
      const images = [];
      for (const raw of params.paths) {
        const trimmed = raw.startsWith("@") ? raw.slice(1) : raw;
        const path = resolve(ctx.cwd, trimmed);
        onUpdate?.({ content: [{ type: "text", text: `Reading ${trimmed}…` }] });
        try {
          images.push(await imagePartFromPath(path, { signal }));
        } catch (error) {
          throw new Error(`vision_describe: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const prompt = visionDescribePrompt(params.question, params.json === true);
      const deadlineAt = Date.now() + TASK_DEADLINE_MS;
      const currentModel = ctx.model
        ? { provider: ctx.model.provider, modelId: ctx.model.id }
        : undefined;
      const answer = await chain.ask(ctx.modelRegistry, images, prompt, { signal, deadlineAt, currentModel });
      if (!answer.ok) {
        return { content: [{ type: "text", text: answer.json }], details: { backend: "none", attempts: answer.json } };
      }

      let text = answer.text;
      // json 模式:解析失败给一次"只回 JSON"的纠错重试(dsh 同款策略)
      if (params.json === true) {
        let valid = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const parsed = extractJson(text);
          if (parsed !== undefined && isStructuredDescription(parsed)) {
            text = JSON.stringify(parsed);
            valid = true;
            break;
          }
          if (attempt === 0) {
            onUpdate?.({ content: [{ type: "text", text: "Answer did not match the fixed JSON schema, retrying…" }] });
            const retry = await chain.ask(
              ctx.modelRegistry,
              images,
              prompt + "\n\nThat output did not match the required {summary,layout,entities,text} schema. Respond with ONLY a conforming JSON object now.",
              { signal, deadlineAt, currentModel },
            );
            if (!retry.ok) return { content: [{ type: "text", text: retry.json }], details: { backend: "none" } };
            text = retry.text;
          }
        }
        if (!valid) {
          throw new Error("vision_describe: backend failed to return the required {summary,layout,entities,text} JSON schema after one correction attempt");
        }
      }
      return { content: [{ type: "text", text }], details: { backend: answer.backend } };
    },
  });

  registerLookTools(pi, chain);
  registerPixelTools(pi, chain);
}
