import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const PI_EYES_CONFIG_VERSION = 1 as const;

export type PiEyesLanguage = "auto" | "zh-CN" | "en";
export type AnonymousChainPosition = "fallback" | "primary";

export interface VisionModelSelection {
  provider: string;
  model: string;
}

export interface PiEyesConfigLayer {
  schemaVersion: typeof PI_EYES_CONFIG_VERSION;
  ui?: {
    language?: PiEyesLanguage;
    [key: string]: unknown;
  };
  backend?: {
    selectedModel?: VisionModelSelection | null;
    anonymousChain?: {
      enabled?: boolean;
      position?: AnonymousChainPosition;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ResolvedPiEyesConfig {
  schemaVersion: typeof PI_EYES_CONFIG_VERSION;
  ui: { language: PiEyesLanguage };
  backend: {
    selectedModel: VisionModelSelection | null;
    anonymousChain: { enabled: boolean; position: AnonymousChainPosition };
  };
}

export interface PiEyesConfigPaths {
  globalPath: string;
  projectPath: string;
}

export interface LoadPiEyesConfigOptions extends PiEyesConfigPaths {
  projectTrusted: boolean;
}

export interface LoadedPiEyesConfig {
  config: ResolvedPiEyesConfig;
  globalLayer?: PiEyesConfigLayer;
  projectLayer?: PiEyesConfigLayer;
  warnings: string[];
}

export const DEFAULT_PI_EYES_CONFIG: ResolvedPiEyesConfig = Object.freeze({
  schemaVersion: PI_EYES_CONFIG_VERSION,
  ui: Object.freeze({ language: "auto" }),
  backend: Object.freeze({
    selectedModel: Object.freeze({ provider: "zai-coding-cn", model: "glm-4.6v" }),
    anonymousChain: Object.freeze({ enabled: true, position: "fallback" }),
  }),
});

export function getPiEyesConfigPaths(cwd: string, agentDir: string, configDirName: string): PiEyesConfigPaths {
  return {
    globalPath: join(agentDir, "pi-eyes.json"),
    projectPath: join(cwd, configDirName, "pi-eyes.json"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} 必须是对象`);
  return value;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} 必须是非空字符串`);
  return value;
}

/** 校验已知 v1 字段，同时保留未知字段，避免旧版配置器覆盖新版字段。 */
export function parsePiEyesConfigLayer(value: unknown): PiEyesConfigLayer {
  const root = requireRecord(value, "config");
  if (root.schemaVersion !== PI_EYES_CONFIG_VERSION) {
    throw new Error(`不支持 schemaVersion: ${String(root.schemaVersion)}`);
  }

  if (root.ui !== undefined) {
    const ui = requireRecord(root.ui, "ui");
    if (ui.language !== undefined && ui.language !== "auto" && ui.language !== "zh-CN" && ui.language !== "en") {
      throw new Error('ui.language 必须是 "auto"、"zh-CN" 或 "en"');
    }
  }

  if (root.backend !== undefined) {
    const backend = requireRecord(root.backend, "backend");
    if (backend.selectedModel !== undefined && backend.selectedModel !== null) {
      const selected = requireRecord(backend.selectedModel, "backend.selectedModel");
      requireNonEmptyString(selected.provider, "backend.selectedModel.provider");
      requireNonEmptyString(selected.model, "backend.selectedModel.model");
    }
    if (backend.anonymousChain !== undefined) {
      const anonymous = requireRecord(backend.anonymousChain, "backend.anonymousChain");
      if (anonymous.enabled !== undefined && typeof anonymous.enabled !== "boolean") {
        throw new Error("backend.anonymousChain.enabled 必须是布尔值");
      }
      if (anonymous.position !== undefined && anonymous.position !== "fallback" && anonymous.position !== "primary") {
        throw new Error('backend.anonymousChain.position 必须是 "fallback" 或 "primary"');
      }
    }
  }

  return root as PiEyesConfigLayer;
}

function cloneResolved(config: ResolvedPiEyesConfig): ResolvedPiEyesConfig {
  return {
    schemaVersion: PI_EYES_CONFIG_VERSION,
    ui: { language: config.ui.language },
    backend: {
      selectedModel: config.backend.selectedModel === null ? null : { ...config.backend.selectedModel },
      anonymousChain: { ...config.backend.anonymousChain },
    },
  };
}

function assertHasBackend(config: ResolvedPiEyesConfig): void {
  if (config.backend.selectedModel === null && !config.backend.anonymousChain.enabled) {
    throw new Error("至少必须启用一个视觉后端");
  }
}

/** 从低优先级向高优先级合并；null 表示显式清除 selectedModel。 */
export function resolvePiEyesConfig(
  layers: readonly PiEyesConfigLayer[],
  base: ResolvedPiEyesConfig = DEFAULT_PI_EYES_CONFIG,
): ResolvedPiEyesConfig {
  const result = cloneResolved(base);
  for (const untrustedLayer of layers) {
    const layer = parsePiEyesConfigLayer(untrustedLayer);
    if (layer.ui?.language !== undefined) result.ui.language = layer.ui.language;
    if (layer.backend?.selectedModel !== undefined) {
      result.backend.selectedModel =
        layer.backend.selectedModel === null ? null : { ...layer.backend.selectedModel };
    }
    if (layer.backend?.anonymousChain?.enabled !== undefined) {
      result.backend.anonymousChain.enabled = layer.backend.anonymousChain.enabled;
    }
    if (layer.backend?.anonymousChain?.position !== undefined) {
      result.backend.anonymousChain.position = layer.backend.anonymousChain.position;
    }
  }
  assertHasBackend(result);
  return result;
}

async function readLayer(path: string): Promise<{ layer?: PiEyesConfigLayer; warning?: string }> {
  let primaryError: unknown;
  try {
    const text = await readFile(path, "utf8");
    return { layer: parsePiEyesConfigLayer(JSON.parse(text)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    primaryError = error;
  }

  try {
    const backupText = await readFile(`${path}.bak`, "utf8");
    return {
      layer: parsePiEyesConfigLayer(JSON.parse(backupText)),
      warning: `${path} 无效，已改用备份`,
    };
  } catch {
    const detail = primaryError instanceof Error ? primaryError.message : String(primaryError);
    return { warning: `${path} 无效，已忽略：${detail}` };
  }
}

export async function loadPiEyesConfig(options: LoadPiEyesConfigOptions): Promise<LoadedPiEyesConfig> {
  const warnings: string[] = [];
  let config = cloneResolved(DEFAULT_PI_EYES_CONFIG);

  const global = await readLayer(options.globalPath);
  if (global.warning) warnings.push(global.warning);
  let globalLayer: PiEyesConfigLayer | undefined;
  if (global.layer) {
    try {
      config = resolvePiEyesConfig([global.layer], config);
      globalLayer = global.layer;
    } catch (error) {
      warnings.push(`${options.globalPath} 无效，已忽略：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let projectLayer: PiEyesConfigLayer | undefined;
  if (options.projectTrusted) {
    const project = await readLayer(options.projectPath);
    if (project.warning) warnings.push(project.warning);
    if (project.layer) {
      try {
        config = resolvePiEyesConfig([project.layer], config);
        projectLayer = project.layer;
      } catch (error) {
        warnings.push(`${options.projectPath} 无效，已忽略：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return { config, globalLayer, projectLayer, warnings };
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "auth" ||
    normalized === "authorization" ||
    normalized === "headers" ||
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
}

function sanitizeForWrite(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForWrite);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!sensitiveKey(key) && entry !== undefined) result[key] = sanitizeForWrite(entry);
  }
  return result;
}

function mergeRaw(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    result[key] = isRecord(result[key]) && isRecord(value) ? mergeRaw(result[key] as Record<string, unknown>, value) : value;
  }
  return result;
}

class FutureConfigVersionError extends Error {}

function rejectFutureVersion(raw: Record<string, unknown>, path: string): void {
  if (typeof raw.schemaVersion === "number" && raw.schemaVersion > PI_EYES_CONFIG_VERSION) {
    throw new FutureConfigVersionError(
      `${path} 使用更新的 schemaVersion ${raw.schemaVersion}，当前版本不会覆盖它`,
    );
  }
}

async function readValidRaw(path: string): Promise<{ raw: Record<string, unknown>; backupCurrent: boolean }> {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      const text = await readFile(candidate, "utf8");
      const raw = requireRecord(JSON.parse(text), "config");
      rejectFutureVersion(raw, candidate);
      parsePiEyesConfigLayer(raw);
      return { raw, backupCurrent: candidate === path };
    } catch (error) {
      if (error instanceof FutureConfigVersionError) throw error;
      // 主文件损坏时保留可用备份，不能在下次保存时用损坏内容覆盖它。
    }
  }
  return { raw: {}, backupCurrent: false };
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function savePiEyesConfig(
  path: string,
  update: Record<string, unknown>,
  options: { baseConfig?: ResolvedPiEyesConfig } = {},
): Promise<PiEyesConfigLayer> {
  if (update.schemaVersion !== undefined && update.schemaVersion !== PI_EYES_CONFIG_VERSION) {
    throw new Error(`不支持 schemaVersion: ${String(update.schemaVersion)}`);
  }

  const existing = await readValidRaw(path);
  const cleanExisting = requireRecord(sanitizeForWrite(existing.raw), "config");
  const cleanUpdate = requireRecord(sanitizeForWrite(update), "config");
  const merged = mergeRaw(cleanExisting, cleanUpdate);
  merged.schemaVersion = PI_EYES_CONFIG_VERSION;
  const layer = parsePiEyesConfigLayer(merged);
  resolvePiEyesConfig([layer], options.baseConfig ?? DEFAULT_PI_EYES_CONFIG);

  if (existing.backupCurrent) {
    await atomicWrite(`${path}.bak`, `${JSON.stringify(cleanExisting, null, 2)}\n`);
  }
  await atomicWrite(path, `${JSON.stringify(merged, null, 2)}\n`);
  return layer;
}
