// 共享视觉链:后端解析、熔断、deadline、逐后端降级。
// index.ts 持有一个实例,describe/ground/detect/ocr 兜底都经它提问。

import {
  OVH_CHAIN,
  callVisionBackend,
  VisionHttpError,
  type ImagePart,
  type VisionBackend,
} from "./backends";
import {
  callPiVisionModel,
  type PiVisionModelRegistry,
  type PiVisionModelSelection,
} from "./pi-model-backend";
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

export interface VisionRoutingConfig {
  selectedModel: PiVisionModelSelection | null;
  anonymousChain: {
    enabled: boolean;
    position: "fallback" | "primary";
  };
}

const DEFAULT_ROUTING: VisionRoutingConfig = {
  selectedModel: { provider: "zai-coding-cn", modelId: "glm-4.6v" },
  anonymousChain: { enabled: true, position: "fallback" },
};

type BackendTarget =
  | { kind: "pi"; id: string; selection: PiVisionModelSelection }
  | { kind: "anonymous"; id: string; backend: VisionBackend };

export class VisionChain {
  readonly circuit = new VisionCircuit();
  readonly turnMemory = new TurnMemory();
  private turnCount = 0;
  private routing: VisionRoutingConfig = DEFAULT_ROUTING;

  setRouting(config: VisionRoutingConfig): void {
    this.routing = {
      selectedModel: config.selectedModel ? { ...config.selectedModel } : null,
      anonymousChain: { ...config.anonymousChain },
    };
  }

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
    registry: PiVisionModelRegistry,
    images: ImagePart[],
    prompt: string,
    options: { signal?: AbortSignal; deadlineAt: number; perCallMs?: number },
  ): Promise<VisionAnswer> {
    if (this.turnMemory.allFailed) {
      return { ok: false, json: buildFailureJson(["OTHER"], this.turnMemory.attempts) };
    }
    const targets: BackendTarget[] = [];
    const piTarget = this.routing.selectedModel
      ? {
          kind: "pi" as const,
          id: `${this.routing.selectedModel.provider}/${this.routing.selectedModel.modelId}`,
          selection: this.routing.selectedModel,
        }
      : undefined;
    const anonymousTargets: BackendTarget[] = this.routing.anonymousChain.enabled
      ? OVH_CHAIN.map((backend) => ({ kind: "anonymous" as const, id: backend.id, backend }))
      : [];
    if (this.routing.anonymousChain.position === "primary") {
      targets.push(...anonymousTargets);
      if (piTarget) targets.push(piTarget);
    } else {
      if (piTarget) targets.push(piTarget);
      targets.push(...anonymousTargets);
    }

    const attempted: string[] = [];
    const failureKinds: FailureKind[] = [];
    for (const target of targets) {
      const remaining = options.deadlineAt - Date.now();
      if (remaining <= 0) {
        failureKinds.push("TIMEOUT");
        attempted.push(`${target.id}: skipped (task deadline exhausted)`);
        break;
      }
      const gate = this.circuit.inspect(target.id, this.turnCount);
      if (gate.blocked) {
        attempted.push(`${target.id}: skipped (circuit open: ${gate.reason})`);
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
        const text = target.kind === "pi"
          ? await callPiVisionModel(registry, target.selection, prompt, images, {
              signal: callSignal,
              maxTokens: 4096,
            })
          : await callVisionBackend(target.backend, prompt, images, { signal: callSignal });
        this.circuit.clear(target.id);
        return { ok: true, text, backend: target.id };
      } catch (error) {
        const failure = classifyFailure({
          status: error instanceof VisionHttpError ? error.status : undefined,
          message: error instanceof Error ? error.message : String(error),
          retryAfterMs: error instanceof VisionHttpError ? error.retryAfterMs : undefined,
        });
        this.circuit.record(target.id, failure, this.turnCount);
        this.turnMemory.recordAttempt(`${target.id}: ${failure.kind}`);
        attempted.push(`${target.id}: ${failure.kind}`);
        failureKinds.push(failure.kind);
      }
    }
    // 400/413/422 往往是本次参数或负载问题；允许模型修正路径、图片数量或尺寸后重试。
    // 只有环境性失败才短路本轮后续网络调用。
    if (!failureKinds.includes("INVALID_REQUEST")) this.turnMemory.markAllFailed();
    return { ok: false, json: buildFailureJson(failureKinds.length > 0 ? failureKinds : ["OTHER"], attempted) };
  }
}
