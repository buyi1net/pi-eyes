// 视觉后端失败分类与熔断。
// 思路移植自 dsh-vision-router/lib/vision-resilience.js(MIT),按 pi 扩展环境精简:
// 保留"分类 → 决定换后端还是熔断 → 本轮全失败短路"三层,去掉凭证指纹与多会话 scope。

export type FailureKind =
  | "AUTH"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "SERVER"
  | "INVALID_REQUEST"
  | "NETWORK"
  | "QUOTA"
  | "OTHER";

export interface BackendFailure {
  kind: FailureKind;
  retryAfterMs?: number;
}

// 分类正则沿用 dsh 调教过的集合与顺序:先确定性失败,后环境性失败
const AUTH_PATTERNS = [/\b401\b/, /\b403\b/, /unauthorized/i, /invalid api[ -]?key/i, /forbidden/i, /authentication/i];
const RATE_LIMIT_PATTERNS = [/\b429\b/, /rate.?limit/i, /too many requests/i];
const TIMEOUT_PATTERNS = [/abort/i, /timeout/i, /etimedout/i, /timed ?out/i, /deadline exceeded/i];
const SERVER_PATTERNS = [/\b500\b/, /\b502\b/, /\b503\b/, /\b504\b/, /bad gateway/i, /service unavailable/i];
const INVALID_REQUEST_PATTERNS = [/\b400\b/, /\b404\b/, /\b413\b/, /\b422\b/, /invalid request/i, /does not support image/i, /invalid model/i, /no such model/i, /model not exist/i, /request body/i];
const NETWORK_PATTERNS = [/econn/i, /enotfound/i, /network/i, /fetch failed/i, /socket/i, /connection reset/i, /dns/i];
const QUOTA_PATTERNS = [/\b402\b/, /insufficient/i, /balance/i, /credits/i];

const KIND_BY_PATTERN: Array<[FailureKind, RegExp[]]> = [
  ["AUTH", AUTH_PATTERNS],
  ["RATE_LIMIT", RATE_LIMIT_PATTERNS],
  ["TIMEOUT", TIMEOUT_PATTERNS],
  ["SERVER", SERVER_PATTERNS],
  ["INVALID_REQUEST", INVALID_REQUEST_PATTERNS],
  ["NETWORK", NETWORK_PATTERNS],
  ["QUOTA", QUOTA_PATTERNS],
];

/** HTTP 状态码优先于报错文本分类。 */
export function kindForStatus(status: number | undefined): FailureKind | undefined {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 402) return "QUOTA";
  if (status === 400 || status === 404 || status === 413 || status === 422) return "INVALID_REQUEST";
  if (status !== undefined && status >= 500 && status <= 599) return "SERVER";
  return undefined;
}

export function classifyFailure(error: { status?: number; message: string; retryAfterMs?: number }): BackendFailure {
  let kind = kindForStatus(error.status);
  if (kind === undefined) {
    kind =
      KIND_BY_PATTERN.find(([, patterns]) => patterns.some((p) => p.test(error.message)))?.[0] ?? "OTHER";
  }
  return { kind, retryAfterMs: error.retryAfterMs };
}

/** per-backend 熔断器:认证类熔断 10 分钟,限频按 Retry-After 冷却。 */
const AUTH_TRIP_MS = 10 * 60 * 1000;
const DEFAULT_RATE_COOLDOWN_MS = 60 * 1000;

export class VisionCircuit {
  private backends = new Map<string, { authUntil?: number; cooldownUntil?: number }>();

  inspect(id: string, _turn: number, now = Date.now()): { blocked: boolean; reason?: string } {
    const hit = this.backends.get(id);
    if (!hit) return { blocked: false };
    if (hit.cooldownUntil !== undefined && hit.cooldownUntil > now) {
      return { blocked: true, reason: "rate-limit cooldown" };
    }
    if (hit.authUntil !== undefined && hit.authUntil > now) {
      return { blocked: true, reason: "auth failure cooldown" };
    }
    return { blocked: false };
  }

  record(id: string, failure: BackendFailure, _turn: number, now = Date.now()): void {
    const hit = this.backends.get(id) ?? {};
    this.backends.set(id, hit);
    if (failure.kind === "AUTH" || failure.kind === "QUOTA") {
      hit.authUntil = now + AUTH_TRIP_MS;
      return;
    }
    if (failure.kind === "RATE_LIMIT") {
      const cooldown = failure.retryAfterMs ?? DEFAULT_RATE_COOLDOWN_MS;
      hit.cooldownUntil = Math.max(hit.cooldownUntil ?? 0, now + cooldown);
      return;
    }
    // INVALID_REQUEST / TIMEOUT / SERVER / NETWORK / OTHER 不熔断：
    // 调用方可能修正图片、参数或请求体后再次使用同一后端。
  }

  clear(id: string): void {
    this.backends.delete(id);
  }
}

/** 本轮失败记忆:全部后端都失败后,后续调用不再碰网络。 */
export class TurnMemory {
  private turn = 0;
  private failedAll = false;
  private attempted: string[] = [];

  newTurn(turn: number): void {
    this.turn = turn;
    this.failedAll = false;
    this.attempted = [];
  }

  get currentTurn(): number {
    return this.turn;
  }

  get allFailed(): boolean {
    return this.failedAll;
  }

  recordAttempt(entry: string): void {
    this.attempted.push(entry);
  }

  get attempts(): string[] {
    return [...this.attempted];
  }

  markAllFailed(): void {
    this.failedAll = true;
  }
}

export const DO_NOT_RETRY_ADVICE =
  "Vision backends are unavailable for this turn (auth failure, rate limit, timeout or outage). " +
  "Do NOT call backend-dependent vision tools again this turn with only a reworded question — rephrasing cannot fix an " +
  "auth, rate-limit or infrastructure failure. Answer from the information you already have and " +
  "continue the text task; local-only tools such as crop, colors, pixel diff, foreground extraction, trace, " +
  "HTML screenshot and Tesseract OCR may still work. Tell the user the remote vision backend is temporarily unavailable.";

const CORRECT_REQUEST_ADVICE =
  "The backend rejected this request as invalid or too large. Correct the image path, format, count, size, " +
  "or tool parameters before retrying; do not retry the identical request.";

const CODE_FOR_ONLY_KIND: Partial<Record<FailureKind, string>> = {
  AUTH: "VISION_AUTH_FAILED",
  RATE_LIMIT: "VISION_RATE_LIMITED",
  TIMEOUT: "VISION_TIMEOUT",
};

/** 组结构化失败 JSON:工具描述里的 FAILURE SEMANTICS 承诺的就是这个形状。 */
export function buildFailureJson(kinds: FailureKind[], attempted: string[]): string {
  const set = new Set(kinds);
  const correctable = set.has("INVALID_REQUEST");
  const code =
    set.size === 1 ? CODE_FOR_ONLY_KIND[[...set][0]] ?? "VISION_BACKEND_UNAVAILABLE" : "VISION_BACKEND_UNAVAILABLE";
  return JSON.stringify({
    ok: false,
    code,
    retryable: correctable,
    reason: correctable ? CORRECT_REQUEST_ADVICE : DO_NOT_RETRY_ADVICE,
    attemptedBackends: attempted,
  });
}
