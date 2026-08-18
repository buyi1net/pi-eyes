import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface PiVisionModelSelection {
  provider: string;
  modelId: string;
}

export interface PiVisionImage {
  data: string;
  mediaType: string;
}

export interface PiVisionModelCandidate extends PiVisionModelSelection {
  name: string;
  api: string;
  available: boolean;
  auth: {
    configured: boolean;
    source?: string;
    label?: string;
  };
}

export interface PiVisionCallOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface AutomaticPiVisionModelOptions {
  currentModel?: PiVisionModelSelection;
  allowedModels?: readonly PiVisionModelSelection[] | null;
  excludedModels?: ReadonlySet<string>;
}

export interface PiVisionProbeResult {
  passed: boolean;
  matched: number;
  total: number;
  answers: string[];
  text: string;
}

export type PiVisionModelRegistry = Pick<
  ModelRegistry,
  "getAll" | "getAvailable" | "find" | "getProviderAuthStatus" | "complete"
>;

export function piVisionModelKey(provider: string, modelId: string): string {
  return `${provider}\0${modelId}`;
}

/** 列出全部声明支持图片的模型，并分别保留认证与当前可用状态。 */
export function discoverPiVisionModels(registry: PiVisionModelRegistry): PiVisionModelCandidate[] {
  const available = new Set(registry.getAvailable().map((model) => piVisionModelKey(model.provider, model.id)));
  return registry.getAll()
    .filter((model) => model.input.includes("image"))
    .map((model) => {
      const auth = registry.getProviderAuthStatus(model.provider);
      return {
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        api: model.api,
        available: available.has(piVisionModelKey(model.provider, model.id)),
        auth: {
          configured: auth.configured,
          ...(auth.source ? { source: auth.source } : {}),
          ...(auth.label ? { label: auth.label } : {}),
        },
      };
    });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 从 Pi 当前可用的图片模型中按稳定规则选择一个，不发起模型调用。 */
export function selectAutomaticPiVisionModel(
  registry: PiVisionModelRegistry,
  options: AutomaticPiVisionModelOptions = {},
): PiVisionModelSelection | undefined {
  const allowed = options.allowedModels === null || options.allowedModels === undefined
    ? undefined
    : new Set(options.allowedModels.map((model) => piVisionModelKey(model.provider, model.modelId)));
  const seen = new Set<string>();
  const candidates = registry.getAvailable()
    .filter((model) => model.input.includes("image"))
    .filter((model) => {
      const key = piVisionModelKey(model.provider, model.id);
      if (seen.has(key) || options.excludedModels?.has(key) || (allowed && !allowed.has(key))) return false;
      seen.add(key);
      return true;
    })
    .map((model) => ({ provider: model.provider, modelId: model.id }));

  const currentKey = options.currentModel
    ? piVisionModelKey(options.currentModel.provider, options.currentModel.modelId)
    : undefined;
  candidates.sort((left, right) => {
    const leftKey = piVisionModelKey(left.provider, left.modelId);
    const rightKey = piVisionModelKey(right.provider, right.modelId);
    if (currentKey) {
      if (leftKey === currentKey && rightKey !== currentKey) return -1;
      if (rightKey === currentKey && leftKey !== currentKey) return 1;
      const leftSameProvider = left.provider === options.currentModel!.provider;
      const rightSameProvider = right.provider === options.currentModel!.provider;
      if (leftSameProvider !== rightSameProvider) return leftSameProvider ? -1 : 1;
    }
    return compareText(`${left.provider}/${left.modelId}`, `${right.provider}/${right.modelId}`);
  });
  return candidates[0];
}

/** 只按 provider 与 modelId 联合键查找，不用显示名或模糊匹配。 */
export function resolvePiVisionModel(
  registry: PiVisionModelRegistry,
  selection: PiVisionModelSelection,
): Model<Api> | undefined {
  const model = registry.find(selection.provider, selection.modelId);
  return model?.input.includes("image") ? model : undefined;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** 经 Pi 原生 provider 调度发送图片，不读取凭证，也不自行构造 HTTP 请求。 */
export async function callPiVisionModel(
  registry: PiVisionModelRegistry,
  selection: PiVisionModelSelection,
  prompt: string,
  images: PiVisionImage[],
  options: PiVisionCallOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const model = resolvePiVisionModel(registry, selection);
  if (!model) {
    throw new Error(`Pi 视觉模型不可用：${selection.provider}/${selection.modelId}`);
  }
  if (images.length === 0) throw new Error("调用 Pi 视觉模型时至少需要一张图片");
  const maxTokens = Math.min(options.maxTokens ?? model.maxTokens, model.maxTokens);

  const result = await registry.complete(
    model,
    {
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      messages: [{
        role: "user",
        timestamp: Date.now(),
        content: [
          ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })),
          { type: "text" as const, text: prompt },
        ],
      }],
    },
    {
      ...(options.signal ? { signal: options.signal } : {}),
      maxTokens,
    },
  );

  if (result.stopReason === "aborted") {
    throw abortError(result.errorMessage || "Pi 视觉模型请求已取消");
  }
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage || `Pi 视觉模型请求失败：${selection.provider}/${selection.modelId}`);
  }
  if (result.errorMessage) throw new Error(result.errorMessage);

  const text = result.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`Pi 视觉模型未返回文本：${selection.provider}/${selection.modelId}`);
  return text;
}

function normalizeProbeValue(value: string): string {
  return value.trim().toLowerCase();
}

function parseProbeAnswers(text: string): string[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string")
      ? parsed.map(normalizeProbeValue)
      : [];
  } catch {
    return [];
  }
}

export function evaluatePiVisionProbe(text: string, expected: readonly string[]): PiVisionProbeResult {
  const normalizedExpected = expected.map(normalizeProbeValue);
  const answers = parseProbeAnswers(text);
  const matched = normalizedExpected.reduce(
    (count, value, index) => count + (answers[index] === value ? 1 : 0),
    0,
  );
  const total = normalizedExpected.length;
  const threshold = total === 0 ? 1 : Math.ceil(total * 5 / 6);
  return { passed: total > 0 && matched >= threshold, matched, total, answers, text };
}

/** 仅在调用方明确触发时，使用调用方提供的测试图验证模型是否真正能看图。 */
export async function testPiVisionModel(
  registry: PiVisionModelRegistry,
  selection: PiVisionModelSelection,
  image: PiVisionImage,
  expected: readonly string[],
  options: PiVisionCallOptions = {},
): Promise<PiVisionProbeResult> {
  if (expected.length === 0) throw new Error("Pi 视觉模型测试至少需要一个预期值");
  // 排序后再放进提示，避免候选标签的排列意外泄露测试图答案。
  const labels = [...new Set(expected.map(normalizeProbeValue))].sort();
  const prompt =
    `The image contains ${expected.length} colored cells. Read them from left to right, then top to bottom. ` +
    `Use only these labels: ${labels.join(", ")}. Return only one JSON array with ${expected.length} strings.`;
  const text = await callPiVisionModel(registry, selection, prompt, [image], {
    ...options,
    maxTokens: options.maxTokens ?? 128,
  });
  return evaluatePiVisionProbe(text, expected);
}
