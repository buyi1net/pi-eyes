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
  piVisionModelKey,
  selectAutomaticPiVisionModel,
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
  route: {
    mode: "automatic" | "fixed" | "public-only";
    allowedModels: PiVisionModelSelection[] | null;
    fixedModel?: PiVisionModelSelection;
  };
  ovhPublicChain: { enabled: boolean };
}

const DEFAULT_ROUTING: VisionRoutingConfig = {
  route: { mode: "automatic", allowedModels: null },
  ovhPublicChain: { enabled: true },
};

type BackendTarget =
  | { kind: "pi"; id: string; selection: PiVisionModelSelection }
  | { kind: "public"; id: string; backend: VisionBackend };

export class VisionChain {
  readonly circuit = new VisionCircuit();
  readonly turnMemory = new TurnMemory();
  private turnCount = 0;
  private routing: VisionRoutingConfig = DEFAULT_ROUTING;
  private stickyAutomaticModel?: PiVisionModelSelection;
  private readonly failedAutomaticModels = new Set<string>();

  setRouting(config: VisionRoutingConfig): void {
    if (config.route.mode === "fixed" && !config.route.fixedModel) {
      throw new Error("fixed 路由必须指定 fixedModel");
    }
    if (config.route.mode === "public-only" && !config.ovhPublicChain.enabled) {
      throw new Error("public-only 路由必须启用 OVH 公共链");
    }
    this.routing = {
      route: {
        mode: config.route.mode,
        allowedModels: config.route.allowedModels?.map((model) => ({ ...model })) ?? null,
        ...(config.route.fixedModel ? { fixedModel: { ...config.route.fixedModel } } : {}),
      },
      ovhPublicChain: { ...config.ovhPublicChain },
    };
    this.stickyAutomaticModel = undefined;
    this.failedAutomaticModels.clear();
  }

  /** 一次 agent run 记一轮:清上一轮的失败短路与无效请求熔断。 */
  beginTurn(): void {
    this.turnCount += 1;
    this.turnMemory.newTurn(this.turnCount);
  }

  private selectPiTarget(
    registry: PiVisionModelRegistry,
    currentModel?: PiVisionModelSelection,
  ): PiVisionModelSelection | undefined {
    if (this.routing.route.mode === "fixed") return this.routing.route.fixedModel;
    if (this.routing.route.mode === "public-only") return undefined;

    if (this.stickyAutomaticModel) {
      const availableSticky = selectAutomaticPiVisionModel(registry, {
        allowedModels: [this.stickyAutomaticModel],
        excludedModels: this.failedAutomaticModels,
      });
      if (availableSticky) return availableSticky;
      this.stickyAutomaticModel = undefined;
    }
    const selected = selectAutomaticPiVisionModel(registry, {
      currentModel,
      allowedModels: this.routing.route.allowedModels,
      excludedModels: this.failedAutomaticModels,
    });
    this.stickyAutomaticModel = selected;
    return selected;
  }

  /**
   * 向视觉链提一次问。deadlineAt 是整个工具任务(可能含多次 ask)的共享截止,
   * 单后端再叠加 per-call 上限;本轮已全失败时直接短路。
   */
  async ask(
    registry: PiVisionModelRegistry,
    images: ImagePart[],
    prompt: string,
    options: {
      signal?: AbortSignal;
      deadlineAt: number;
      perCallMs?: number;
      currentModel?: PiVisionModelSelection;
    },
  ): Promise<VisionAnswer> {
    options.signal?.throwIfAborted();
    if (this.turnMemory.allFailed) {
      return { ok: false, json: buildFailureJson(["OTHER"], this.turnMemory.attempts) };
    }

    const targets: BackendTarget[] = [];
    const piSelection = this.selectPiTarget(registry, options.currentModel);
    if (piSelection) {
      targets.push({
        kind: "pi",
        id: `${piSelection.provider}/${piSelection.modelId}`,
        selection: piSelection,
      });
    }
    if (this.routing.ovhPublicChain.enabled) {
      targets.push(...OVH_CHAIN.map((backend) => ({ kind: "public" as const, id: backend.id, backend })));
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
        options.signal.throwIfAborted();
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
        // 用户取消必须立即终止整个链，不能把同一图片继续发给公共兜底。
        if (options.signal?.aborted) options.signal.throwIfAborted();
        const failure = classifyFailure({
          status: error instanceof VisionHttpError ? error.status : undefined,
          message: error instanceof Error ? error.message : String(error),
          retryAfterMs: error instanceof VisionHttpError ? error.retryAfterMs : undefined,
        });
        this.circuit.record(target.id, failure, this.turnCount);
        if (
          target.kind === "pi" &&
          this.routing.route.mode === "automatic" &&
          failure.kind !== "INVALID_REQUEST"
        ) {
          this.failedAutomaticModels.add(piVisionModelKey(target.selection.provider, target.selection.modelId));
          this.stickyAutomaticModel = undefined;
        }
        this.turnMemory.recordAttempt(`${target.id}: ${failure.kind}`);
        attempted.push(`${target.id}: ${failure.kind}`);
        failureKinds.push(failure.kind);
      }
    }
    // 自动模式每个请求只试一个 Pi 模型；该候选失败后，下次调用可换下一个。
    const automaticCanTryAnotherModel =
      this.routing.route.mode === "automatic" && targets.some((target) => target.kind === "pi");
    // 400/413/422 往往是本次参数或负载问题，允许调用方修正后重试。
    if (!failureKinds.includes("INVALID_REQUEST") && !automaticCanTryAnotherModel) this.turnMemory.markAllFailed();
    return { ok: false, json: buildFailureJson(failureKinds.length > 0 ? failureKinds : ["OTHER"], attempted) };
  }
}
