// 共享视觉链:后端解析、熔断、deadline、逐后端降级。
// index.ts 持有一个实例,describe/ground/detect/ocr 兜底都经它提问。

import {
  OVH_CHAIN,
  resolvePrimaryBackend,
  callVisionBackend,
  VisionHttpError,
  type ImagePart,
  type VisionBackend,
  type ProviderLookup,
} from "./backends";
import { VisionCircuit, TurnMemory, classifyFailure, buildFailureJson, type FailureKind } from "./resilience";

export interface VisionAnswerOk {
  ok: true;
  text: string;
  backend: string;
}

export interface VisionAnswerFail {
  ok: false;
  json: string;
}

export type VisionAnswer = VisionAnswerOk | VisionAnswerFail;

export class VisionChain {
  readonly circuit = new VisionCircuit();
  readonly turnMemory = new TurnMemory();
  private turnCount = 0;

  /** 一次 agent run 记一轮:清上一轮的失败短路与无效请求熔断。 */
  beginTurn(): void {
    this.turnCount += 1;
    this.turnMemory.newTurn(this.turnCount);
  }

  /**
   * 向视觉链提一次问。deadlineAt 是整个工具任务(可能含多次 ask)的共享截止,
   * 单后端再叠加 per-call 上限;本轮已全失败时直接短路。
   */
  async ask(
    registry: ProviderLookup,
    images: ImagePart[],
    prompt: string,
    options: { signal?: AbortSignal; deadlineAt: number; perCallMs?: number },
  ): Promise<VisionAnswer> {
    if (this.turnMemory.allFailed) {
      return { ok: false, json: buildFailureJson(["OTHER"], this.turnMemory.attempts) };
    }
    const backends: VisionBackend[] = [];
    const primary = await resolvePrimaryBackend(registry);
    if (primary) backends.push(primary);
    backends.push(...OVH_CHAIN);

    const attempted: string[] = [];
    const failureKinds: FailureKind[] = [];
    for (const backend of backends) {
      const remaining = options.deadlineAt - Date.now();
      if (remaining <= 0) {
        failureKinds.push("TIMEOUT");
        attempted.push(`${backend.id}: skipped (task deadline exhausted)`);
        break;
      }
      const gate = this.circuit.inspect(backend.id, this.turnCount);
      if (gate.blocked) {
        attempted.push(`${backend.id}: skipped (circuit open: ${gate.reason})`);
        continue;
      }
      if (options.signal?.aborted) {
        return { ok: false, json: buildFailureJson(["OTHER"], [...attempted, "cancelled"]) };
      }
      const perCall = Math.min(options.perCallMs ?? 60_000, remaining);
      const callSignal = options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(perCall)])
        : AbortSignal.timeout(perCall);
      try {
        const text = await callVisionBackend(backend, prompt, images, { signal: callSignal });
        this.circuit.clear(backend.id);
        return { ok: true, text, backend: backend.id };
      } catch (error) {
        const failure = classifyFailure({
          status: error instanceof VisionHttpError ? error.status : undefined,
          message: error instanceof Error ? error.message : String(error),
          retryAfterMs: error instanceof VisionHttpError ? error.retryAfterMs : undefined,
        });
        this.circuit.record(backend.id, failure, this.turnCount);
        this.turnMemory.recordAttempt(`${backend.id}: ${failure.kind}`);
        attempted.push(`${backend.id}: ${failure.kind}`);
        failureKinds.push(failure.kind);
      }
    }
    this.turnMemory.markAllFailed();
    return { ok: false, json: buildFailureJson(failureKinds.length > 0 ? failureKinds : ["OTHER"], attempted) };
  }
}
