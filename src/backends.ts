// 视觉后端链定义与 OpenAI 兼容调用。
// 调用形态移植自 dsh-vision-router/index.js 的 callOpenAICompatible / toOpenAIContent(MIT)。

export interface VisionBackend {
  /** 展示与熔断用的稳定 provider/model 标识。 */
  id: string;
  baseURL: string;
  model: string;
  /** 空 = keyless 匿名端点(OVH) */
  apiKey?: string;
  maxTokens: number;
}

// OVHcloud AI Endpoints 匿名免费层做低频兜底:每 IP 每模型 2 次/分钟,免 Key,
// 国外域名走 pi 全局 EnvHttpProxyAgent(Clash 规则分流)。
// 顺序沿用 dsh 的"从大到小",质量优先;一个模型 429 可立即换下一个模型的独立额度。
const OVH_BASE_URL = "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1";
const OVH_REQUEST_LIMIT_BYTES = 10 * 1024 * 1024;
export const OVH_CHAIN: VisionBackend[] = [
  { id: "ovh/Qwen3.5-397B-A17B", baseURL: OVH_BASE_URL, model: "Qwen3.5-397B-A17B", maxTokens: 4096 },
  { id: "ovh/Qwen2.5-VL-72B-Instruct", baseURL: OVH_BASE_URL, model: "Qwen2.5-VL-72B-Instruct", maxTokens: 4096 },
  { id: "ovh/Qwen3.6-27B", baseURL: OVH_BASE_URL, model: "Qwen3.6-27B", maxTokens: 4096 },
  { id: "ovh/Mistral-Small-3.2-24B-Instruct-2506", baseURL: OVH_BASE_URL, model: "Mistral-Small-3.2-24B-Instruct-2506", maxTokens: 4096 },
  { id: "ovh/Qwen3.5-9B", baseURL: OVH_BASE_URL, model: "Qwen3.5-9B", maxTokens: 4096 },
];

/** 带 HTTP 状态与 Retry-After 的调用错误,供失败分类使用。 */
export class VisionHttpError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ImagePart {
  data: string; // base64
  mediaType: string;
}

/**
 * 一次非流式 OpenAI 兼容视觉调用。全局 fetch 已被 pi 设置为
 * EnvHttpProxyAgent,代理分流由 Clash 规则决定,这里不单独处理。
 */
export async function callVisionBackend(
  backend: VisionBackend,
  prompt: string,
  images: ImagePart[],
  options: { signal?: AbortSignal },
): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (backend.apiKey) headers.authorization = `Bearer ${backend.apiKey}`;
  const content: unknown[] = images.map((image) => ({
    type: "image_url",
    image_url: { url: `data:${image.mediaType};base64,${image.data}` },
  }));
  content.push({ type: "text", text: prompt });
  const url = `${backend.baseURL.replace(/\/$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model: backend.model,
    messages: [{ role: "user", content }],
    max_tokens: backend.maxTokens,
    stream: false,
  });
  if (backend.baseURL.startsWith(OVH_BASE_URL) && Buffer.byteLength(body, "utf8") > OVH_REQUEST_LIMIT_BYTES) {
    throw new VisionHttpError(
      "vision request exceeds the OVH 10MB request-body limit; use a smaller or compressed copy for this fallback backend",
      413,
    );
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: options.signal,
  });
  if (!response.ok) {
    // 429 携带 Retry-After 立即抛给熔断层做冷却,不做盲等
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3600_000) : undefined;
    throw new VisionHttpError(`vision backend "${backend.id}": ${response.status} ${detail}`, response.status, retryAfterMs);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text === "") {
    throw new VisionHttpError(`vision backend "${backend.id}": unexpected response shape`);
  }
  return text;
}

/** 按魔数识别图片类型,识别不出返回 undefined。 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

// ---------- prompt 构造与 JSON 提取(文案沿 dsh 调教版) ----------

function describeStructuredInstruction(question: string): string {
  return (
    `Look at the image and answer the question: 「${question.slice(0, 1500)}」. ` +
    "Return ONE JSON object and nothing else, shaped EXACTLY as:\n" +
    '{"summary":"<1-2 sentence answer to the question>",' +
    '"layout":[{"region":"<e.g. top-left / header / center>","content":"<what is there>"}],' +
    '"entities":[{"type":"<button|input|text|image|link|icon|other>","label":"<name or text>"}],' +
    '"text":"<the full text visible in the image, transcribed in reading order, as faithful as possible>"}\n' +
    '- "layout" lists the main regions in reading order (top-to-bottom, left-to-right);\n' +
    '- "entities" lists notable elements; use only the listed type values;\n' +
    '- "text" is the verbatim transcription; write "" when the image contains no text.'
  );
}

export function visionDescribePrompt(question: string, wantJson = false): string {
  const raw = question.trim();
  const text = raw === "" ? "Describe the image accurately and answer based only on visible content." : raw;
  return wantJson ? text + "\n\n" + describeStructuredInstruction(text) : text;
}

/** 从模型输出中提取 JSON 对象:先整体 parse,再截首尾大括号(容忍 markdown 围栏与前后杂文)。 */
export function extractJson(text: string): Record<string, unknown> | undefined {
  const tryParse = (raw: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return undefined;
}

const STRUCTURED_ENTITY_TYPES = new Set(["button", "input", "text", "image", "link", "icon", "other"]);

/** 校验 vision_describe json:true 承诺的固定四字段结构。 */
export function isStructuredDescription(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "entities,layout,summary,text") return false;
  if (typeof value.summary !== "string" || typeof value.text !== "string") return false;
  if (!Array.isArray(value.layout) || !Array.isArray(value.entities)) return false;
  const layoutOk = value.layout.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return Object.keys(row).sort().join(",") === "content,region" &&
      typeof row.region === "string" && typeof row.content === "string";
  });
  const entitiesOk = value.entities.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entity = item as Record<string, unknown>;
    return Object.keys(entity).sort().join(",") === "label,type" &&
      typeof entity.type === "string" && STRUCTURED_ENTITY_TYPES.has(entity.type) &&
      typeof entity.label === "string";
  });
  return layoutOk && entitiesOk;
}
