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
export type VisionRouteMode = "automatic" | "fixed" | "public-only";

export interface VisionModelRef {
  provider: string;
  model: string;
}

export interface EyesSetupConfig {
  schemaVersion: 2;
  language: EyesSetupLanguage;
  backend: {
    route: {
      mode: VisionRouteMode;
      allowedModels: VisionModelRef[] | null;
      fixedModel?: VisionModelRef;
    };
    ovhPublicChain: {
      enabled: boolean;
    };
  };
}

export type VisionModelStatus = "authenticated" | "no-auth-required";

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

function refKey(model: VisionModelRef): string {
  return `${model.provider}\0${model.model}`;
}

function modelRef(model: Pick<Model<Api>, "provider" | "id">): VisionModelRef {
  return { provider: model.provider, model: model.id };
}

export function discoverVisionModels(ctx: ExtensionCommandContext): VisionModelCandidate[] {
  return ctx.modelRegistry.getAvailable()
    .filter((model) => model.input.includes("image"))
    .map((model): VisionModelCandidate => ({
      model,
      status: ctx.modelRegistry.hasConfiguredAuth(model) ? "authenticated" : "no-auth-required",
    }))
    .sort((a, b) => {
      const statusOrder = { authenticated: 0, "no-auth-required": 1 } as const;
      return statusOrder[a.status] - statusOrder[b.status]
        || modelKey(a.model).localeCompare(modelKey(b.model));
    });
}

function formatModelLabel(candidate: VisionModelCandidate, messages: EyesSetupMessages): string {
  const status = candidate.status === "authenticated"
    ? messages.modelStatusAuthenticated
    : messages.modelStatusNoAuthRequired;
  return `${candidate.model.provider}/${candidate.model.id} — ${status}`;
}

function isCandidateAvailable(candidate: VisionModelCandidate, ctx: ExtensionCommandContext): boolean {
  return discoverVisionModels(ctx).some((item) => modelKey(item.model) === modelKey(candidate.model));
}

function unavailableAllowedModels(
  allowedModels: VisionModelRef[] | null,
  ctx: ExtensionCommandContext,
): VisionModelRef[] {
  if (allowedModels === null) return [];
  const available = new Set(discoverVisionModels(ctx).map((candidate) => modelKey(candidate.model)));
  return allowedModels.filter((model) => !available.has(refKey(model)));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(error: unknown, ctx: ExtensionCommandContext): boolean {
  return ctx.signal.aborted;
}

type StepChoice<T> =
  | { kind: "value"; value: T }
  | { kind: "back" }
  | { kind: "exit" };

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

async function chooseScope(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<StepChoice<SetupScope>> {
  const options = [messages.scopeGlobal];
  if (ctx.isProjectTrusted()) options.push(messages.scopeProject);
  const choice = await ctx.ui.select(messages.scopeTitle, [...options, messages.back]);
  if (choice === undefined) return { kind: "exit" };
  if (choice === messages.back) return { kind: "back" };
  if (choice === messages.scopeGlobal) return { kind: "value", value: "global" };
  if (choice === messages.scopeProject && ctx.isProjectTrusted()) {
    return { kind: "value", value: "project" };
  }
  return { kind: "exit" };
}

function routeLabel(mode: VisionRouteMode, messages: EyesSetupMessages): string {
  if (mode === "automatic") return messages.strategyAutomatic;
  if (mode === "fixed") return messages.strategyFixed;
  return messages.strategyPublicOnly;
}

async function chooseRoute(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  current: EyesSetupConfig | undefined,
): Promise<StepChoice<VisionRouteMode>> {
  const currentLabel = current
    ? messages.currentConfiguration(routeLabel(current.backend.route.mode, messages))
    : undefined;
  const title = currentLabel ? `${messages.strategyTitle}\n${currentLabel}` : messages.strategyTitle;
  const choice = await ctx.ui.select(title, [
    messages.strategyAutomatic,
    messages.strategyFixed,
    messages.strategyPublicOnly,
    messages.back,
  ]);
  if (choice === undefined) return { kind: "exit" };
  if (choice === messages.back) return { kind: "back" };
  if (choice === messages.strategyAutomatic) return { kind: "value", value: "automatic" };
  if (choice === messages.strategyFixed) return { kind: "value", value: "fixed" };
  if (choice === messages.strategyPublicOnly) return { kind: "value", value: "public-only" };
  return { kind: "exit" };
}

async function chooseAutomaticRange(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<StepChoice<"all" | "custom">> {
  const choice = await ctx.ui.select(messages.automaticRangeTitle, [
    messages.automaticRangeAll,
    messages.automaticRangeCustom,
    messages.back,
  ]);
  if (choice === undefined) return { kind: "exit" };
  if (choice === messages.back) return { kind: "back" };
  if (choice === messages.automaticRangeAll) return { kind: "value", value: "all" };
  if (choice === messages.automaticRangeCustom) return { kind: "value", value: "custom" };
  return { kind: "exit" };
}

async function refreshModels(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
): Promise<void> {
  if (!dependencies.refreshModels) return;
  try {
    await dependencies.refreshModels(ctx);
    ctx.signal.throwIfAborted();
    ctx.ui.notify(messages.refreshComplete, "info");
  } catch (error) {
    if (isCancellation(error, ctx)) throw error;
    ctx.ui.notify(messages.refreshFailed(errorText(error)), "error");
  }
}

async function manageAutomaticCandidates(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
  initial: VisionModelRef[] | null,
): Promise<StepChoice<VisionModelRef[] | null>> {
  let initialized = false;
  const selected = new Set<string>();

  while (true) {
    const candidates = discoverVisionModels(ctx);
    const availableKeys = new Set(candidates.map((candidate) => modelKey(candidate.model)));
    if (!initialized) {
      const initialKeys = initial === null ? availableKeys : new Set(initial.map(refKey));
      for (const key of initialKeys) {
        if (availableKeys.has(key)) selected.add(key);
      }
      initialized = true;
    } else {
      for (const key of selected) {
        if (!availableKeys.has(key)) selected.delete(key);
      }
    }

    const labels = candidates.map((candidate) => {
      const marker = selected.has(modelKey(candidate.model)) ? "[x]" : "[ ]";
      return `${marker} ${formatModelLabel(candidate, messages)}`;
    });
    const options = [...labels, messages.automaticCandidatesDone, messages.automaticRangeAll];
    if (dependencies.refreshModels) options.push(messages.refreshModels);
    options.push(messages.back);

    const title = candidates.length === 0
      ? `${messages.automaticCandidatesTitle(0, 0)}\n${messages.noUsableVisionModels}`
      : messages.automaticCandidatesTitle(selected.size, candidates.length);
    const choice = await ctx.ui.select(title, options);
    if (choice === undefined) return { kind: "exit" };
    if (choice === messages.back) return { kind: "back" };
    if (choice === messages.automaticRangeAll) return { kind: "value", value: null };
    if (choice === messages.automaticCandidatesDone) {
      return {
        kind: "value",
        value: candidates
          .filter((candidate) => selected.has(modelKey(candidate.model)))
          .map((candidate) => modelRef(candidate.model)),
      };
    }
    if (choice === messages.refreshModels && dependencies.refreshModels) {
      await refreshModels(ctx, messages, dependencies);
      continue;
    }
    const index = labels.indexOf(choice);
    if (index < 0) return { kind: "exit" };
    const key = modelKey(candidates[index].model);
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
  }
}

async function chooseFixedModel(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
): Promise<StepChoice<VisionModelCandidate>> {
  while (true) {
    const candidates = discoverVisionModels(ctx);
    const labels = candidates.map((candidate) => formatModelLabel(candidate, messages));
    const options = [...labels];
    if (dependencies.refreshModels) options.push(messages.refreshModels);
    options.push(messages.back);
    const title = candidates.length === 0
      ? `${messages.modelTitle}\n${messages.noUsableVisionModels}`
      : messages.modelTitle;
    const choice = await ctx.ui.select(title, options);
    if (choice === undefined) return { kind: "exit" };
    if (choice === messages.back) return { kind: "back" };
    if (choice === messages.refreshModels && dependencies.refreshModels) {
      await refreshModels(ctx, messages, dependencies);
      continue;
    }
    const index = labels.indexOf(choice);
    if (index < 0) return { kind: "exit" };
    return { kind: "value", value: candidates[index] };
  }
}

async function choosePublicFallback(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<StepChoice<boolean>> {
  const choice = await ctx.ui.select(messages.publicFallbackTitle, [
    messages.publicFallbackEnabled,
    messages.publicFallbackDisabled,
    messages.back,
  ]);
  if (choice === undefined) return { kind: "exit" };
  if (choice === messages.back) return { kind: "back" };
  if (choice === messages.publicFallbackEnabled) return { kind: "value", value: true };
  if (choice === messages.publicFallbackDisabled) return { kind: "value", value: false };
  return { kind: "exit" };
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
    ctx.signal.throwIfAborted();
  } catch (error) {
    if (isCancellation(error, ctx)) throw error;
    result = { ok: false, message: errorText(error) };
  }
  if (result.ok) {
    ctx.ui.notify(messages.testPassed, "info");
    return result;
  }
  ctx.ui.notify(messages.testFailed(result.message || messages.modelUnavailable), "error");
  return result;
}

type WizardStep =
  | "language"
  | "scope"
  | "strategy"
  | "automaticRange"
  | "automaticCandidates"
  | "model"
  | "test"
  | "testFailed"
  | "publicFallback"
  | "review";

export function registerEyesSetup(pi: ExtensionAPI, dependencies: EyesSetupDependencies): void {
  pi.registerCommand("pi-eyes", {
    description: getEyesSetupMessages("zh-CN").commandDescription,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error(getEyesSetupMessages("zh-CN").nonInteractive);

      const current = await dependencies.loadConfig(ctx);
      let language = current?.language ?? "zh-CN";
      let scope: SetupScope | undefined;
      let mode: VisionRouteMode | undefined;
      let allowedModels = current?.backend.route.allowedModels ?? null;
      let candidate: VisionModelCandidate | undefined;
      let publicFallbackEnabled = current?.backend.ovhPublicChain.enabled ?? true;
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
      const returnTo = (target: WizardStep) => {
        const index = history.lastIndexOf(target);
        history.length = index < 0 ? 0 : index;
        step = target;
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
          const selected = await chooseRoute(ctx, messages, current);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          mode = selected.value;
          if (mode === "automatic") next("automaticRange");
          else if (mode === "fixed") next("model");
          else {
            publicFallbackEnabled = true;
            next("review");
          }
          continue;
        }

        if (step === "automaticRange") {
          const selected = await chooseAutomaticRange(ctx, messages);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          if (selected.value === "all") {
            allowedModels = null;
            next("publicFallback");
          } else {
            next("automaticCandidates");
          }
          continue;
        }

        if (step === "automaticCandidates") {
          const selected = await manageAutomaticCandidates(ctx, messages, dependencies, allowedModels);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          allowedModels = selected.value;
          next("publicFallback");
          continue;
        }

        if (step === "model") {
          const selected = await chooseFixedModel(ctx, messages, dependencies);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          candidate = selected.value;
          next(dependencies.testModel ? "test" : "publicFallback");
          continue;
        }

        if (step === "test") {
          if (!candidate) {
            returnTo("model");
            continue;
          }
          if (!isCandidateAvailable(candidate, ctx)) {
            ctx.ui.notify(messages.modelUnavailable, "warning");
            candidate = undefined;
            returnTo("model");
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
            next("publicFallback");
            continue;
          }
          if (choice !== messages.testNow) return;
          const result = await runSelectedModelTest(candidate, ctx, messages, dependencies);
          if (result.ok) next("publicFallback");
          else {
            testFailure = result.message || messages.modelUnavailable;
            next("testFailed");
          }
          continue;
        }

        if (step === "testFailed") {
          if (!candidate || !isCandidateAvailable(candidate, ctx)) {
            ctx.ui.notify(messages.modelUnavailable, "warning");
            candidate = undefined;
            returnTo("model");
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
            next("publicFallback");
            continue;
          }
          if (choice !== messages.testRetry) return;
          const result = await runSelectedModelTest(candidate, ctx, messages, dependencies);
          if (result.ok) next("publicFallback");
          else testFailure = result.message || messages.modelUnavailable;
          continue;
        }

        if (step === "publicFallback") {
          const selected = await choosePublicFallback(ctx, messages);
          if (selected.kind === "exit") return;
          if (selected.kind === "back") {
            if (!back()) return;
            continue;
          }
          if (!selected.value && mode === "automatic" && allowedModels?.length === 0) {
            ctx.ui.notify(messages.atLeastOneBackend, "warning");
            continue;
          }
          publicFallbackEnabled = selected.value;
          next("review");
          continue;
        }

        if (!scope || !mode) {
          if (!back()) return;
          continue;
        }
        if (mode === "fixed" && (!candidate || !isCandidateAvailable(candidate, ctx))) {
          ctx.ui.notify(messages.modelUnavailable, "warning");
          candidate = undefined;
          returnTo("model");
          continue;
        }
        const staleAllowed = mode === "automatic" ? unavailableAllowedModels(allowedModels, ctx) : [];
        if (staleAllowed.length > 0) {
          ctx.ui.notify(
            messages.modelsUnavailable(staleAllowed.map((model) => `${model.provider}/${model.model}`)),
            "warning",
          );
          const stale = new Set(staleAllowed.map(refKey));
          allowedModels = allowedModels?.filter((model) => !stale.has(refKey(model))) ?? null;
          returnTo("automaticCandidates");
          continue;
        }

        const route = {
          mode,
          allowedModels,
          ...(mode === "fixed" && candidate ? { fixedModel: modelRef(candidate.model) } : {}),
        };
        const config: EyesSetupConfig = {
          schemaVersion: 2,
          language,
          backend: {
            route,
            ovhPublicChain: { enabled: mode === "public-only" ? true : publicFallbackEnabled },
          },
        };
        const scopeLabel = scope === "project" ? messages.scopeProject : messages.scopeGlobal;
        const modelLabel = mode === "automatic"
          ? allowedModels === null
            ? messages.allAvailableVisionModels
            : allowedModels.length === 0
              ? messages.noSelectedVisionModels
              : allowedModels.map((model) => `${model.provider}/${model.model}`).join(", ")
          : mode === "fixed" && candidate
            ? `${candidate.model.provider}/${candidate.model.id}`
            : messages.publicModel;
        const publicLabel = config.backend.ovhPublicChain.enabled
          ? messages.publicFallbackOn
          : messages.publicFallbackOff;
        const choice = await ctx.ui.select(
          `${messages.confirmTitle}\n${messages.confirmMessage(
            scopeLabel,
            routeLabel(mode, messages),
            modelLabel,
            publicLabel,
          )}`,
          [messages.saveConfiguration, messages.back],
        );
        if (choice === undefined) return;
        if (choice === messages.back) {
          if (!back()) return;
          continue;
        }
        if (choice !== messages.saveConfiguration) return;

        if (mode === "fixed" && (!candidate || !isCandidateAvailable(candidate, ctx))) {
          ctx.ui.notify(messages.modelUnavailable, "warning");
          candidate = undefined;
          returnTo("model");
          continue;
        }
        const staleBeforeSave = mode === "automatic" ? unavailableAllowedModels(allowedModels, ctx) : [];
        if (staleBeforeSave.length > 0) {
          ctx.ui.notify(
            messages.modelsUnavailable(staleBeforeSave.map((model) => `${model.provider}/${model.model}`)),
            "warning",
          );
          const stale = new Set(staleBeforeSave.map(refKey));
          allowedModels = allowedModels?.filter((model) => !stale.has(refKey(model))) ?? null;
          returnTo("automaticCandidates");
          continue;
        }

        try {
          await dependencies.saveConfig(scope, config, ctx);
        } catch (error) {
          if (isCancellation(error, ctx)) throw error;
          ctx.ui.notify(messages.saveFailed(errorText(error)), "error");
          continue;
        }
        ctx.ui.notify(scope === "project" ? messages.savedProject : messages.savedGlobal, "info");
        return;
      }
    },
  });
}
