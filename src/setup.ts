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
  const available = ctx.modelRegistry.getAvailable().filter((model) => model.input.includes("image"));
  const availableKeys = new Set(available.map(modelKey));
  const models = new Map<string, Model<Api>>();

  for (const model of ctx.modelRegistry.getAll()) {
    if (model.input.includes("image")) models.set(modelKey(model), model);
  }
  for (const model of available) models.set(modelKey(model), model);

  return [...models.values()]
    .map((model): VisionModelCandidate => ({
      model,
      status: !availableKeys.has(modelKey(model))
        ? "unavailable"
        : ctx.modelRegistry.hasConfiguredAuth(model)
          ? "authenticated"
          : "no-auth-required",
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
  if (choice === undefined) return undefined;
  return choice === messages.languageEnglish ? "en" : "zh-CN";
}

async function chooseScope(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<SetupScope | undefined> {
  const options = [messages.scopeGlobal];
  if (ctx.isProjectTrusted()) options.push(messages.scopeProject);
  const choice = await ctx.ui.select(messages.scopeTitle, options);
  if (choice === undefined) return undefined;
  return choice === messages.scopeProject ? "project" : "global";
}

async function chooseStrategy(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
): Promise<VisionBackendMode | undefined> {
  const choice = await ctx.ui.select(messages.strategyTitle, [
    messages.strategyAuto,
    messages.strategyPiOnly,
    messages.strategyAnonymousOnly,
  ]);
  if (choice === undefined) return undefined;
  if (choice === messages.strategyPiOnly) return "pi-only";
  if (choice === messages.strategyAnonymousOnly) return "anonymous-only";
  return "auto";
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
  return discoverVisionModels(ctx).find((candidate) => modelKey(candidate.model) === modelKey(model));
}

async function chooseModel(
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
): Promise<VisionModelCandidate | undefined> {
  while (true) {
    const candidates = discoverVisionModels(ctx);
    const labels = candidates.map((candidate) => formatModelLabel(candidate, messages));
    const options = [...labels, messages.modelManual];
    if (dependencies.refreshModels) options.push(messages.refreshModels);

    const choice = await ctx.ui.select(messages.modelTitle, options);
    if (choice === undefined) return undefined;

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
      if (raw === undefined) continue;
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
    return candidate;
  }
}

async function testSelectedModel(
  candidate: VisionModelCandidate,
  ctx: ExtensionCommandContext,
  messages: EyesSetupMessages,
  dependencies: EyesSetupDependencies,
): Promise<boolean> {
  if (!dependencies.testModel) return true;
  const label = `${candidate.model.provider}/${candidate.model.id}`;
  const shouldTest = await ctx.ui.confirm(messages.testTitle, messages.testQuestion(label));
  if (!shouldTest) return true;

  let result: ModelTestResult;
  try {
    result = await dependencies.testModel(candidate.model, ctx);
  } catch (error) {
    result = { ok: false, message: errorText(error) };
  }
  if (result.ok) {
    ctx.ui.notify(messages.testPassed, "info");
    return true;
  }

  ctx.ui.notify(messages.testFailed(result.message || messages.modelUnavailable), "error");
  return ctx.ui.confirm(messages.testTitle, messages.saveAfterFailedTest);
}

export function registerEyesSetup(pi: ExtensionAPI, dependencies: EyesSetupDependencies): void {
  pi.registerCommand("eyes-setup", {
    description: getEyesSetupMessages("zh-CN").commandDescription,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) throw new Error(getEyesSetupMessages("zh-CN").nonInteractive);

      const current = await dependencies.loadConfig(ctx);
      const language = await chooseLanguage(ctx, current?.language ?? "zh-CN");
      if (!language) return;
      const messages = getEyesSetupMessages(language);

      const scope = await chooseScope(ctx, messages);
      if (!scope) return;
      const mode = await chooseStrategy(ctx, messages);
      if (!mode) return;

      const candidate = mode === "anonymous-only"
        ? undefined
        : await chooseModel(ctx, messages, dependencies);
      if (mode !== "anonymous-only" && !candidate) return;
      if (candidate && !(await testSelectedModel(candidate, ctx, messages, dependencies))) return;

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
      const confirmed = await ctx.ui.confirm(
        messages.confirmTitle,
        messages.confirmMessage(scopeLabel, strategyLabel, selectedModel),
      );
      if (!confirmed) return;

      try {
        await dependencies.saveConfig(scope, config, ctx);
      } catch (error) {
        ctx.ui.notify(messages.saveFailed(errorText(error)), "error");
        throw error;
      }
      ctx.ui.notify(scope === "project" ? messages.savedProject : messages.savedGlobal, "info");
    },
  });
}
