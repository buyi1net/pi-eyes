import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getEyesSetupMessages,
  type EyesSetupLanguage,
  type EyesSetupMessages,
} from "./i18n";

export type SetupScope = "global" | "project";
export type VisionBackendMode = "auto" | "pi-only" | "anonymous-only";

export interface VisionModelRef {
  provider: string;
  id: string;
}

export interface EyesSetupConfig {
  version: 1;
  language: EyesSetupLanguage;
  backend: {
    mode: VisionBackendMode;
    model?: VisionModelRef;
  };
}

export type VisionModelStatus = "authenticated" | "no-auth-required" | "unavailable";

export interface VisionModelCandidate {
  model: Model<Api>;
  status: VisionModelStatus;
}

export interface ModelTestResult {
  ok: boolean;
  message?: string;
}

export interface EyesSetupDependencies {
  loadConfig(ctx: ExtensionCommandContext): Promise<EyesSetupConfig | undefined>;
  saveConfig(
    scope: SetupScope,
    config: EyesSetupConfig,
    ctx: ExtensionCommandContext,
  ): Promise<void>;
  refreshModels?(ctx: ExtensionCommandContext): Promise<void>;
  testModel?(
    model: Model<Api>,
    ctx: ExtensionCommandContext,
  ): Promise<ModelTestResult>;
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}\0${model.id}`;
}

export function discoverVisionModels(ctx: ExtensionCommandContext): VisionModelCandidate[] {
  return ctx.modelRegistry.getAvailable()
    .filter((model) => model.input.includes("image"))
    .map((model): VisionModelCandidate => ({
      model,
      status: ctx.modelRegistry.hasConfiguredAuth(model) ? "authenticated" : "no-auth-required",
    }))
    .sort((a, b) => {
      const statusOrder = { authenticated: 0, "no-auth-required": 1, unavailable: 2 } as const;
      const statusDifference = statusOrder[a.status] - statusOrder[b.status];
      return statusDifference || modelKey(a.model).localeCompare(modelKey(b.model));
    });
}

function formatModelLabel(candidate: VisionModelCandidate, messages: EyesSetupMessages): string {
  const status = candidate.status === "authenticated"
    ? messages.modelStatusAuthenticated
    : candidate.status === "no-auth-required"
      ? messages.modelStatusNoAuthRequired
      : messages.modelStatusUnavailable;
  return `${candidate.model.provider}/${candidate.model.id} — ${status}`;
}

function isCandidateAvailable(candidate: VisionModelCandidate, ctx: ExtensionCommandContext): boolean {
  return discoverVisionModels(ctx).some((item) => modelKey(item.model) === modelKey(candidate.model));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function chooseLanguage(
  ctx: ExtensionCommandContext,
  initial: EyesSetupLanguage,
): Promise<EyesSetupLanguage | undefined> {
  const messages = getEyesSetupMessages(initial);
  const choice = await ctx.ui.select(messages.languageTitle, [
    messages.languageChinese,
    messages.languageEnglish,
  ]);
  if (choice === messages.languageChinese) return "zh-CN";
  if (choice === messages.languageEnglish) return "en";
  return undefined;
}

type StepChoice<T> =
  | { kind: "value"; value: T }
  | { kind: "back" }
  | { kind: "exit" };

async function chooseScope(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<StepChoice<SetupScope>> {
  const options = [messages.scopeGlobal];
  if (ctx.isProjectTrusted()) options.push(messages.scopeProject);
  const choice = await ctx.ui.select(messages.scopeTitle, [
    ...options,
    messages.back,
  ]);
  if (choice === undefined) return { kind: "exit" };
  if (choice === messages.back) return { kind: "back" };
  if (choice === messages.scopeGlobal) return { kind: "value", value: "global" };
  if (choice === messages.scopeProject && ctx.isProjectTrusted()) return { kind: "value", value: "project" };
  return { kind: "exit" };
}

async function chooseStrategy(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<StepChoice<VisionBackendMode>> {
  const choice = await ctx.ui.select(messages.strategyTitle, [
    messages.strategyAuto,
    messages.strategyPiOnly,
    messages.strategyAnonymousOnly,
    messages.back,
  ]);
  if (choice === undefined) return { kind: "exit" };
  if (choice === messages.back) return { kind: "back" };
  if (choice === messages.strategyPiOnly) return { kind: "value", value: "pi-only" };
  if (choice === messages.strategyAnonymousOnly) return { kind: "value", value: "anonymous-only" };
  if (choice === messages.strategyAuto) return { kind: "value", value: "auto" };
  return { kind: "exit" };
}

function findManualModel(
  raw: string,
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): VisionModelCandidate | undefined {
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) {
    ctx.ui.notify(messages.modelInvalid, "error");
    return undefined;
  }
  const provider = raw.slice(0, separator).trim();
  const id = raw.slice(separator + 1).trim();
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) {
    ctx.ui.notify(messages.modelInvalid, "error");
    return undefined;
  }
  if (!model.input.includes("image")) {
    ctx.ui.notify(messages.modelNotVisual, "error");
    return undefined;
  }
  const candidate = discoverVisionModels(ctx).find((item) => modelKey(item.model) === modelKey(model));
  if (!candidate) ctx.ui.notify(messages.modelUnavailable, "warning");
  return candidate;
}

async function chooseModel(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
): Promise<StepChoice<VisionModelCandidate>> {
  while (true) {
    const candidates = discoverVisionModels(ctx);
    const labels = candidates.map((candidate) => formatModelLabel(candidate, messages));
    const options = [...labels, messages.modelManual];
    if (dependencies.refreshModels) options.push(messages.refreshModels);
    options.push(messages.back);

    const choice = await ctx.ui.select(messages.modelTitle, options);
    if (choice === undefined) return { kind: "exit" };
    if (choice === messages.back) return { kind: "back" };

    if (choice === messages.refreshModels && dependencies.refreshModels) {
      try {
        await dependencies.refreshModels(ctx);
        ctx.ui.notify(messages.refreshComplete, "info");
      } catch (error) {
        ctx.ui.notify(messages.refreshFailed(errorText(error)), "error");
      }
      continue;
    }

    let candidate: VisionModelCandidate | undefined;
    if (choice === messages.modelManual) {
      const raw = await ctx.ui.input(messages.modelManualTitle, messages.modelManualPlaceholder);
      if (raw === undefined) return { kind: "exit" };
      candidate = findManualModel(raw.trim(), ctx, messages);
      if (!candidate) continue;
    } else {
      const index = labels.indexOf(choice);
      candidate = index >= 0 ? candidates[index] : undefined;
    }

    if (!candidate || candidate.status === "unavailable") {
      ctx.ui.notify(messages.modelUnavailable, "warning");
      if (!candidates.some((item) => item.status !== "unavailable")) {
        ctx.ui.notify(messages.noUsableVisionModels, "warning");
      }
      continue;
    }
    return { kind: "value", value: candidate };
  }
}

async function runSelectedModelTest(
  candidate: VisionModelCandidate,
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
): Promise<ModelTestResult> {
  if (!dependencies.testModel) return { ok: true };

  let result: ModelTestResult;
  try {
    result = await dependencies.testModel(candidate.model, ctx);
  } catch (error) {
    result = { ok: false, message: errorText(error) };
  }
  if (result.ok) {
    ctx.ui.notify(messages.testPassed, "info");
    return result;
  }

  ctx.ui.notify(messages.testFailed(result.message || messages.modelUnavailable), "error");
  return result;
}

type WizardStep = "language" | "scope" | "strategy" | "model" | "test" | "testFailed" | "review";

export function registerEyesSetup(pi: ExtensionAPI, dependencies: EyesSetupDependencies): void {
  pi.registerCommand("eyes-setup", {
    description: getEyesSetupMessages("zh-CN").commandDescription,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error(getEyesSetupMessages("zh-CN").nonInteractive);

      const current = await dependencies.loadConfig(ctx);
      let language = current?.language ?? "zh-CN";
      let scope: SetupScope | undefined;
      let mode: VisionBackendMode | undefined;
      let candidate: VisionModelCandidate | undefined;
      let testFailure = "";
      let step: WizardStep = "language";
      const history: WizardStep[] = [];

      const next = (nextStep: WizardStep) => {
        history.push(step);
        step = nextStep;
      };
      const back = (): boolean => {
        const previous = history.pop();
        if (!previous) return false;
        step = previous;
        return true;
      };

      while (true) {
        const messages = getEyesSetupMessages(language);

        if (step === "language") {
          const selected = await chooseLanguage(ctx, language);
          if (!selected) return;
          language = selected;
          next("scope");
          continue;
        }

        if (step === "scope") {
          const selected = await chooseScope(ctx, messages);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          scope = selected.value;
          next("strategy");
          continue;
        }

        if (step === "strategy") {
          const selected = await chooseStrategy(ctx, messages);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          mode = selected.value;
          candidate = undefined;
          next(mode === "anonymous-only" ? "review" : "model");
          continue;
        }

        if (step === "model") {
          const selected = await chooseModel(ctx, messages, dependencies);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          candidate = selected.value;
          next(dependencies.testModel ? "test" : "review");
          continue;
        }

        if (step === "test") {
          if (!candidate) {
            if (!back()) return;
            continue;
          }
          if (!isCandidateAvailable(candidate, ctx)) {
            ctx.ui.notify(messages.modelUnavailable, "warning");
            candidate = undefined;
            if (!back()) return;
            continue;
          }
          const label = `${candidate.model.provider}/${candidate.model.id}`;
          const choice = await ctx.ui.select(
            `${messages.testTitle}\n${messages.testQuestion(label)}`,
            [messages.testNow, messages.testSkip, messages.back],
          );
          if (choice === undefined) return;
          if (choice === messages.back) {
            if (!back()) return;
            continue;
          }
          if (choice === messages.testSkip) {
            next("review");
            continue;
          }
          if (choice !== messages.testNow) return;
          const result = await runSelectedModelTest(candidate, ctx, messages, dependencies);
          if (result.ok) {
            next("review");
          } else {
            testFailure = result.message || messages.modelUnavailable;
            next("testFailed");
          }
          continue;
        }

        if (step === "testFailed") {
          if (!candidate) {
            if (!back()) return;
            continue;
          }
          if (!isCandidateAvailable(candidate, ctx)) {
            ctx.ui.notify(messages.modelUnavailable, "warning");
            candidate = undefined;
            while (history.at(-1) !== "strategy" && history.length > 0) history.pop();
            step = "model";
            continue;
          }
          const choice = await ctx.ui.select(
            messages.testFailed(testFailure || messages.modelUnavailable),
            [messages.testRetry, messages.testUseAnyway, messages.back],
          );
          if (choice === undefined) return;
          if (choice === messages.back) {
            if (!back()) return;
            continue;
          }
          if (choice === messages.testUseAnyway) {
            next("review");
            continue;
          }
          if (choice !== messages.testRetry) return;
          const result = await runSelectedModelTest(candidate, ctx, messages, dependencies);
          if (result.ok) {
            next("review");
          } else {
            testFailure = result.message || messages.modelUnavailable;
          }
          continue;
        }

        if (!scope || !mode) {
          if (!back()) return;
          continue;
        }
        if (candidate && !isCandidateAvailable(candidate, ctx)) {
          ctx.ui.notify(messages.modelUnavailable, "warning");
          candidate = undefined;
          while (history.at(-1) !== "strategy" && history.length > 0) history.pop();
          step = "model";
          continue;
        }
        const backend = candidate
          ? { mode, model: { provider: candidate.model.provider, id: candidate.model.id } }
          : { mode };
        const config: EyesSetupConfig = { version: 1, language, backend };
        const scopeLabel = scope === "project" ? messages.scopeProject : messages.scopeGlobal;
        const strategyLabel = mode === "auto"
          ? messages.strategyAuto
          : mode === "pi-only"
            ? messages.strategyPiOnly
            : messages.strategyAnonymousOnly;
        const selectedModel = candidate
          ? `${candidate.model.provider}/${candidate.model.id}`
          : messages.anonymousModel;
        const choice = await ctx.ui.select(
          `${messages.confirmTitle}\n${messages.confirmMessage(scopeLabel, strategyLabel, selectedModel)}`,
          [messages.saveConfiguration, messages.back],
        );
        if (choice === undefined) return;
        if (choice === messages.back) {
          if (!back()) return;
          continue;
        }
        if (choice !== messages.saveConfiguration) return;
        if (candidate && !isCandidateAvailable(candidate, ctx)) {
          ctx.ui.notify(messages.modelUnavailable, "warning");
          candidate = undefined;
          while (history.at(-1) !== "strategy" && history.length > 0) history.pop();
          step = "model";
          continue;
        }

        try {
          await dependencies.saveConfig(scope, config, ctx);
        } catch (error) {
          ctx.ui.notify(messages.saveFailed(errorText(error)), "error");
          continue;
        }
        ctx.ui.notify(scope === "project" ? messages.savedProject : messages.savedGlobal, "info");
        return;
      }
    },
  });
}
