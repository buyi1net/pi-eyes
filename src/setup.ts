import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  getEyesSetupMessages,
  type EyesSetupLanguage,
  type EyesSetupMessages,
} from "./i18n";

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

export interface EyesSetupState {
  config: EyesSetupConfig;
  projectOverrideActive: boolean;
}

export interface EyesSetupSaveResult {
  projectOverrideActive: boolean;
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
  loadConfig(ctx: ExtensionCommandContext): Promise<EyesSetupState | undefined>;
  saveConfig(
    config: EyesSetupConfig,
    ctx: ExtensionCommandContext,
  ): Promise<EyesSetupSaveResult>;
  refreshModels?(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<void>;
  testModel?(
    model: Model<Api>,
    ctx: ExtensionCommandContext,
    signal?: AbortSignal,
  ): Promise<ModelTestResult>;
}

type ModelPane = "selected" | "available";
type BusyAction = "refresh" | "test" | "save";

const MAX_CONTENT_WIDTH = 110;
const DUAL_PANE_MIN_WIDTH = 96;

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}\0${model.id}`;
}

function refKey(model: VisionModelRef): string {
  return `${model.provider}\0${model.model}`;
}

function modelRef(model: Pick<Model<Api>, "provider" | "id">): VisionModelRef {
  return { provider: model.provider, model: model.id };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function sameKeys(a: VisionModelCandidate[], b: VisionModelCandidate[]): boolean {
  return a.length === b.length && a.every((candidate, index) => (
    modelKey(candidate.model) === modelKey(b[index].model)
  ));
}

function routeLabel(mode: VisionRouteMode, messages: EyesSetupMessages): string {
  if (mode === "automatic") return messages.routeAutomatic;
  if (mode === "fixed") return messages.routeFixed;
  return messages.routePublicOnly;
}

function padLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width));
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function visibleSlice<T>(items: T[], cursor: number, limit = 7): { start: number; items: T[] } {
  const start = Math.max(0, Math.min(cursor - Math.floor(limit / 2), items.length - limit));
  return { start, items: items.slice(start, start + limit) };
}

export function registerEyesSetup(pi: ExtensionAPI, dependencies: EyesSetupDependencies): void {
  pi.registerCommand("pi-eyes", {
    description: getEyesSetupMessages("zh-CN").commandDescription,
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        throw new Error(getEyesSetupMessages("zh-CN").nonInteractive);
      }

      const loaded = await dependencies.loadConfig(ctx);
      const current = loaded?.config;
      let projectOverrideActive = loaded?.projectOverrideActive ?? false;
      let language = current?.language ?? "zh-CN";
      let mode = current?.backend.route.mode ?? "automatic";
      let ovhEnabled = current?.backend.ovhPublicChain.enabled ?? true;
      let candidates = discoverVisionModels(ctx);
      const availableKeys = new Set(candidates.map((candidate) => modelKey(candidate.model)));
      const configuredAllowed = current?.backend.route.allowedModels;
      let autoSelectsAll = configuredAllowed === null || configuredAllowed === undefined;
      const autoSelected = new Set(
        (autoSelectsAll
          ? candidates.map((candidate) => modelKey(candidate.model))
          : configuredAllowed.map(refKey))
          .filter((key) => availableKeys.has(key)),
      );
      let fixedKey = current?.backend.route.fixedModel
        ? refKey(current.backend.route.fixedModel)
        : undefined;
      if (fixedKey && !availableKeys.has(fixedKey)) fixedKey = undefined;
      if (mode === "public-only") ovhEnabled = true;

      await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
        let pane: ModelPane = "selected";
        let selectedCursor = 0;
        let availableCursor = 0;
        let busy: BusyAction | undefined;
        let actionController: AbortController | undefined;
        let detachParentAbort: (() => void) | undefined;
        let status = "";
        let closed = false;

        const messages = () => getEyesSetupMessages(language);
        const chosenKeys = (): Set<string> => {
          if (mode === "automatic") return autoSelected;
          if (mode === "fixed" && fixedKey) return new Set([fixedKey]);
          return new Set();
        };
        const selectedCandidates = (): VisionModelCandidate[] => {
          const selected = chosenKeys();
          return candidates.filter((candidate) => selected.has(modelKey(candidate.model)));
        };
        const availableCandidates = (): VisionModelCandidate[] => {
          const selected = chosenKeys();
          return candidates.filter((candidate) => !selected.has(modelKey(candidate.model)));
        };
        const clampCursors = () => {
          selectedCursor = Math.max(0, Math.min(selectedCursor, selectedCandidates().length - 1));
          availableCursor = Math.max(0, Math.min(availableCursor, availableCandidates().length - 1));
        };
        const refresh = () => {
          clampCursors();
          tui.requestRender();
        };
        const label = (candidate: VisionModelCandidate): string => {
          const suffix = candidate.status === "authenticated"
            ? messages().modelStatusAuthenticated
            : messages().modelStatusNoAuthRequired;
          return `${candidate.model.provider}/${candidate.model.id} · ${suffix}`;
        };
        const replaceCandidates = (next: VisionModelCandidate[], selectNewWhenAllSelected: boolean) => {
          const previousKeys = new Set(candidates.map((candidate) => modelKey(candidate.model)));
          const nextKeys = new Set(next.map((candidate) => modelKey(candidate.model)));
          for (const key of autoSelected) {
            if (!nextKeys.has(key)) autoSelected.delete(key);
          }
          if (selectNewWhenAllSelected && autoSelectsAll) {
            for (const candidate of next) {
              const key = modelKey(candidate.model);
              if (!previousKeys.has(key)) autoSelected.add(key);
            }
          }
          if (fixedKey && !nextKeys.has(fixedKey)) fixedKey = undefined;
          candidates = next;
          clampCursors();
        };
        const selectedForTest = (): VisionModelCandidate | undefined => {
          const list = pane === "selected" ? selectedCandidates() : availableCandidates();
          const cursor = pane === "selected" ? selectedCursor : availableCursor;
          return list[cursor];
        };
        const moveCurrentModel = () => {
          if (mode === "public-only") {
            status = messages().publicOnlyModelHint;
            refresh();
            return;
          }
          if (pane === "selected") {
            const selected = selectedCandidates();
            const candidate = selected[selectedCursor];
            if (!candidate) return;
            const key = modelKey(candidate.model);
            if (mode === "automatic") autoSelected.delete(key);
            else fixedKey = undefined;
            availableCursor = availableCandidates().findIndex((item) => modelKey(item.model) === key);
            if (mode === "automatic") autoSelectsAll = false;
            refresh();
            return;
          }
          const available = availableCandidates();
          const candidate = available[availableCursor];
          if (!candidate) return;
          const key = modelKey(candidate.model);
          if (mode === "automatic") {
            autoSelected.add(key);
            autoSelectsAll = autoSelected.size === candidates.length;
          }
          else fixedKey = key;
          selectedCursor = selectedCandidates().findIndex((item) => modelKey(item.model) === key);
          refresh();
        };
        const cycleMode = () => {
          mode = mode === "automatic" ? "fixed" : mode === "fixed" ? "public-only" : "automatic";
          if (mode === "public-only") ovhEnabled = true;
          status = "";
          refresh();
        };
        const startCancellableAction = (): AbortSignal => {
          const controller = new AbortController();
          const parentSignal = ctx.signal;
          const abortFromParent = () => controller.abort(parentSignal?.reason);
          if (parentSignal?.aborted) abortFromParent();
          else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
          actionController = controller;
          detachParentAbort = () => parentSignal?.removeEventListener("abort", abortFromParent);
          return controller.signal;
        };
        const finishCancellableAction = () => {
          detachParentAbort?.();
          detachParentAbort = undefined;
          actionController = undefined;
        };
        const runRefresh = async () => {
          if (!dependencies.refreshModels) {
            status = messages().refreshUnavailable;
            refresh();
            return;
          }
          busy = "refresh";
          status = messages().refreshRunning;
          refresh();
          const signal = startCancellableAction();
          try {
            await dependencies.refreshModels(ctx, signal);
            signal.throwIfAborted();
            if (closed) return;
            replaceCandidates(discoverVisionModels(ctx), true);
            status = messages().refreshComplete;
          } catch (error) {
            if (closed) return;
            if (signal.aborted) {
              closed = true;
              done(false);
              return;
            }
            status = messages().refreshFailed(errorText(error));
          } finally {
            finishCancellableAction();
            busy = undefined;
            if (!closed) refresh();
          }
        };
        const runTest = async () => {
          if (!dependencies.testModel) {
            status = messages().testUnavailable;
            refresh();
            return;
          }
          const candidate = selectedForTest();
          if (!candidate) {
            status = mode === "fixed" ? messages().fixedModelRequired : messages().emptySelected;
            refresh();
            return;
          }
          const name = `${candidate.model.provider}/${candidate.model.id}`;
          busy = "test";
          status = messages().testRunning(name);
          refresh();
          const signal = startCancellableAction();
          try {
            const result = await dependencies.testModel(candidate.model, ctx, signal);
            signal.throwIfAborted();
            if (closed) return;
            status = result.ok
              ? messages().testPassed(name)
              : messages().testFailed(name, result.message || "unknown error");
          } catch (error) {
            if (closed) return;
            if (signal.aborted) {
              closed = true;
              done(false);
              return;
            }
            status = messages().testFailed(name, errorText(error));
          } finally {
            finishCancellableAction();
            busy = undefined;
            if (!closed) refresh();
          }
        };
        const runSave = async () => {
          const latest = discoverVisionModels(ctx);
          if (!sameKeys(candidates, latest)) {
            replaceCandidates(latest, true);
            status = messages().modelsChanged;
            refresh();
            return;
          }
          const selected = selectedCandidates();
          if (mode === "fixed" && selected.length !== 1) {
            status = messages().fixedModelRequired;
            refresh();
            return;
          }
          if (mode === "automatic" && selected.length === 0 && !ovhEnabled) {
            status = messages().atLeastOneBackend;
            refresh();
            return;
          }
          if (mode === "public-only" && !ovhEnabled) {
            status = messages().publicChainRequired;
            refresh();
            return;
          }
          const effectiveMode = mode === "automatic" && selected.length === 0 && !autoSelectsAll
            ? "public-only"
            : mode;
          const allSelected = selected.length === candidates.length;
          const config: EyesSetupConfig = {
            schemaVersion: 2,
            language,
            backend: {
              route: {
                mode: effectiveMode,
                allowedModels: effectiveMode === "automatic"
                  ? autoSelectsAll || allSelected ? null : selected.map((candidate) => modelRef(candidate.model))
                  : null,
                ...(effectiveMode === "fixed" ? { fixedModel: modelRef(selected[0].model) } : {}),
              },
              ovhPublicChain: { enabled: effectiveMode === "public-only" ? true : ovhEnabled },
            },
          };
          busy = "save";
          status = messages().saveRunning;
          refresh();
          try {
            const result = await dependencies.saveConfig(config, ctx);
            if (closed) return;
            projectOverrideActive = result.projectOverrideActive;
            ctx.ui.notify(
              projectOverrideActive ? messages().savedWithProjectOverride : messages().savedGlobal,
              projectOverrideActive ? "warning" : "info",
            );
            closed = true;
            done(true);
          } catch (error) {
            if (ctx.signal?.aborted) {
              closed = true;
              done(false);
              return;
            }
            status = messages().saveFailed(errorText(error));
            busy = undefined;
            refresh();
          }
        };
        const renderList = (
          list: VisionModelCandidate[],
          cursor: number,
          focused: boolean,
          empty: string,
          width: number,
          limit: number,
        ): string[] => {
          if (list.length === 0) return [theme.fg("dim", truncateToWidth(empty, width))];
          const view = visibleSlice(list, cursor, limit);
          const lines = view.items.map((candidate, index) => {
            const selected = view.start + index === cursor;
            const prefix = selected ? "> " : "  ";
            const text = truncateToWidth(`${prefix}${label(candidate)}`, width);
            return selected && focused ? theme.fg("accent", text) : text;
          });
          if (view.start > 0) lines.unshift(theme.fg("dim", "  ↑"));
          if (view.start + view.items.length < list.length) lines.push(theme.fg("dim", "  ↓"));
          return lines;
        };
        const render = (width: number): string[] => {
          const renderWidth = Math.max(1, width);
          const contentWidth = Math.min(renderWidth, MAX_CONTENT_WIDTH);
          const clip = (text: string) => truncateToWidth(text, contentWidth);
          const copy = messages();
          const selected = selectedCandidates();
          const available = availableCandidates();
          const languageLabel = language === "zh-CN" ? copy.languageChinese : copy.languageEnglish;
          const ovhLabel = ovhEnabled ? copy.enabled : copy.disabled;
          const lines = [
            clip(theme.fg("accent", theme.bold(copy.windowTitle))),
            clip(theme.fg("dim", copy.globalConfiguration)),
          ];
          if (projectOverrideActive) {
            lines.push(clip(theme.fg("warning", copy.projectOverrideWarning)));
          }
          lines.push("");
          if (contentWidth >= 72) {
            lines.push(clip(`${copy.languageLabel}: ${theme.fg("accent", languageLabel)}    ${copy.routeLabel}: ${theme.fg("accent", routeLabel(mode, copy))}    ${copy.ovhLabel}: ${theme.fg("accent", ovhLabel)}`));
          } else {
            lines.push(
              clip(`${copy.languageLabel}: ${theme.fg("accent", languageLabel)}`),
              clip(`${copy.routeLabel}: ${theme.fg("accent", routeLabel(mode, copy))}`),
              clip(`${copy.ovhLabel}: ${theme.fg("accent", ovhLabel)}`),
            );
          }
          lines.push("");
          const selectedTitle = `${pane === "selected" ? ">" : " "} ${copy.selectedModels} (${selected.length})`;
          const availableTitle = `${pane === "available" ? ">" : " "} ${copy.availableModels} (${available.length})`;
          const dualPane = contentWidth >= DUAL_PANE_MIN_WIDTH;
          const separatorWidth = dualPane ? 3 : 0;
          const leftWidth = dualPane ? Math.floor((contentWidth - separatorWidth) / 2) : contentWidth;
          const rightWidth = dualPane ? Math.max(1, contentWidth - separatorWidth - leftWidth) : contentWidth;
          const listLimit = dualPane ? 7 : 4;
          const selectedLines = renderList(selected, selectedCursor, pane === "selected", copy.emptySelected, leftWidth, listLimit);
          const availableLines = renderList(available, availableCursor, pane === "available", copy.emptyAvailable, rightWidth, listLimit);
          if (dualPane) {
            const separator = theme.fg("dim", " │ ");
            lines.push(
              `${theme.fg(pane === "selected" ? "accent" : "muted", padLine(selectedTitle, leftWidth))}${separator}${theme.fg(pane === "available" ? "accent" : "muted", padLine(availableTitle, rightWidth))}`,
            );
            const rows = Math.max(selectedLines.length, availableLines.length, 1);
            for (let index = 0; index < rows; index += 1) {
              lines.push(`${padLine(selectedLines[index] || "", leftWidth)}${separator}${padLine(availableLines[index] || "", rightWidth)}`);
            }
          } else {
            lines.push(clip(theme.fg(pane === "selected" ? "accent" : "muted", selectedTitle)), ...selectedLines, "");
            lines.push(clip(theme.fg(pane === "available" ? "accent" : "muted", availableTitle)), ...availableLines);
          }
          lines.push("", status ? clip(theme.fg(busy ? "warning" : "muted", status)) : "");
          lines.push(
            clip(theme.fg("dim", copy.helpNavigation)),
            clip(theme.fg("dim", copy.helpActions)),
          );
          return lines;
        };
        const handleInput = (data: string) => {
          if (busy) {
            if (busy !== "save" && matchesKey(data, Key.escape)) {
              actionController?.abort(new DOMException("Cancelled", "AbortError"));
              closed = true;
              done(false);
            }
            return;
          }
          if (matchesKey(data, Key.escape)) {
            closed = true;
            done(false);
            return;
          }
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
            pane = pane === "selected" ? "available" : "selected";
            status = "";
            refresh();
            return;
          }
          if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
            const delta = matchesKey(data, Key.up) ? -1 : 1;
            if (pane === "selected") selectedCursor += delta;
            else availableCursor += delta;
            status = "";
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
            status = "";
            moveCurrentModel();
            return;
          }
          if (matchesKey(data, "m")) {
            cycleMode();
            return;
          }
          if (matchesKey(data, "l")) {
            language = language === "zh-CN" ? "en" : "zh-CN";
            status = "";
            refresh();
            return;
          }
          if (matchesKey(data, "o")) {
            if (mode === "public-only") status = messages().publicChainRequired;
            else {
              ovhEnabled = !ovhEnabled;
              status = "";
            }
            refresh();
            return;
          }
          if (matchesKey(data, Key.ctrl("r"))) {
            void runRefresh();
            return;
          }
          if (matchesKey(data, Key.ctrl("t"))) {
            void runTest();
            return;
          }
          if (matchesKey(data, Key.ctrl("s"))) void runSave();
        };

        return { render, handleInput, invalidate: () => {} };
      });

      ctx.signal?.throwIfAborted();
    },
  });
}
