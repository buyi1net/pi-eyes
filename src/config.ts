import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const PI_EYES_CONFIG_VERSION = 2 as const;

export type PiEyesLanguage = "auto" | "zh-CN" | "en";
export type VisionRouteMode = "automatic" | "fixed" | "public-only";

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
    route?: {
      mode?: VisionRouteMode;
      allowedModels?: VisionModelSelection[] | null;
      fixedModel?: VisionModelSelection;
      [key: string]: unknown;
    };
    ovhPublicChain?: {
      enabled?: boolean;
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
    route: {
      mode: VisionRouteMode;
      allowedModels: VisionModelSelection[] | null;
      fixedModel?: VisionModelSelection;
    };
    ovhPublicChain: { enabled: boolean };
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
  globalConfig: ResolvedPiEyesConfig;
  config: ResolvedPiEyesConfig;
  globalLayer?: PiEyesConfigLayer;
  projectLayer?: PiEyesConfigLayer;
  warnings: string[];
}

export const DEFAULT_PI_EYES_CONFIG: ResolvedPiEyesConfig = Object.freeze({
  schemaVersion: PI_EYES_CONFIG_VERSION,
  ui: Object.freeze({ language: "auto" }),
  backend: Object.freeze({
    route: Object.freeze({ mode: "automatic", allowedModels: null }),
    ovhPublicChain: Object.freeze({ enabled: true }),
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

function parseModelSelection(value: unknown, field: string): VisionModelSelection {
  const selection = requireRecord(value, field);
  return {
    provider: requireNonEmptyString(selection.provider, `${field}.provider`),
    model: requireNonEmptyString(selection.model, `${field}.model`),
  };
}

function validateLanguage(root: Record<string, unknown>): void {
  if (root.ui === undefined) return;
  const ui = requireRecord(root.ui, "ui");
  if (ui.language !== undefined && ui.language !== "auto" && ui.language !== "zh-CN" && ui.language !== "en") {
    throw new Error('ui.language 必须是 "auto"、"zh-CN" 或 "en"');
  }
}

/** 把 v1 层转换成 v2 层；只返回内存结果，不写回配置文件。 */
function migrateV1Layer(root: Record<string, unknown>): PiEyesConfigLayer {
  validateLanguage(root);
  const migrated: Record<string, unknown> = { ...root, schemaVersion: PI_EYES_CONFIG_VERSION };
  if (root.backend === undefined) return migrated as PiEyesConfigLayer;

  const backend = requireRecord(root.backend, "backend");
  const nextBackend: Record<string, unknown> = { ...backend };
  delete nextBackend.selectedModel;
  delete nextBackend.anonymousChain;

  if (backend.selectedModel !== undefined) {
    nextBackend.route = backend.selectedModel === null
      ? { mode: "public-only" }
      : { mode: "fixed", fixedModel: parseModelSelection(backend.selectedModel, "backend.selectedModel") };
  }
  if (backend.anonymousChain !== undefined) {
    const anonymous = requireRecord(backend.anonymousChain, "backend.anonymousChain");
    if (anonymous.enabled !== undefined && typeof anonymous.enabled !== "boolean") {
      throw new Error("backend.anonymousChain.enabled 必须是布尔值");
    }
    if (anonymous.position !== undefined && anonymous.position !== "fallback" && anonymous.position !== "primary") {
      throw new Error('backend.anonymousChain.position 必须是 "fallback" 或 "primary"');
    }
    if (anonymous.enabled !== undefined) nextBackend.ovhPublicChain = { enabled: anonymous.enabled };
    // v2 不再提供“公共链优先、Pi 模型兜底”的混合顺序。旧手写配置若明确
    // 选择 primary，迁为 public-only 才能保留其首选数据流，而不是静默反转为 Pi 优先。
    if (anonymous.position === "primary" && anonymous.enabled !== false) {
      nextBackend.route = { mode: "public-only" };
      nextBackend.ovhPublicChain = { enabled: true };
    }
  }
  migrated.backend = nextBackend;
  return migrated as PiEyesConfigLayer;
}

/** 校验 v2 已知字段并保留未知字段；v1 只在内存中迁移。 */
export function parsePiEyesConfigLayer(value: unknown): PiEyesConfigLayer {
  const root = requireRecord(value, "config");
  if (root.schemaVersion === 1) return migrateV1Layer(root);
  if (root.schemaVersion !== PI_EYES_CONFIG_VERSION) {
    throw new Error(`不支持 schemaVersion: ${String(root.schemaVersion)}`);
  }

  validateLanguage(root);
  if (root.backend !== undefined) {
    const backend = requireRecord(root.backend, "backend");
    if (backend.route !== undefined) {
      const route = requireRecord(backend.route, "backend.route");
      if (
        route.mode !== undefined &&
        route.mode !== "automatic" &&
        route.mode !== "fixed" &&
        route.mode !== "public-only"
      ) {
        throw new Error('backend.route.mode 必须是 "automatic"、"fixed" 或 "public-only"');
      }
      if (route.allowedModels !== undefined && route.allowedModels !== null) {
        if (!Array.isArray(route.allowedModels)) throw new Error("backend.route.allowedModels 必须是数组或 null");
        route.allowedModels.forEach((entry, index) => {
          parseModelSelection(entry, `backend.route.allowedModels[${index}]`);
        });
      }
      if (route.fixedModel !== undefined) parseModelSelection(route.fixedModel, "backend.route.fixedModel");
    }
    if (backend.ovhPublicChain !== undefined) {
      const ovh = requireRecord(backend.ovhPublicChain, "backend.ovhPublicChain");
      if (ovh.enabled !== undefined && typeof ovh.enabled !== "boolean") {
        throw new Error("backend.ovhPublicChain.enabled 必须是布尔值");
      }
    }
  }
  return root as PiEyesConfigLayer;
}

function cloneModels(models: VisionModelSelection[] | null): VisionModelSelection[] | null {
  return models === null ? null : models.map((model) => ({ ...model }));
}

function cloneResolved(config: ResolvedPiEyesConfig): ResolvedPiEyesConfig {
  return {
    schemaVersion: PI_EYES_CONFIG_VERSION,
    ui: { language: config.ui.language },
    backend: {
      route: {
        mode: config.backend.route.mode,
        allowedModels: cloneModels(config.backend.route.allowedModels),
        ...(config.backend.route.fixedModel ? { fixedModel: { ...config.backend.route.fixedModel } } : {}),
      },
      ovhPublicChain: { ...config.backend.ovhPublicChain },
    },
  };
}

function assertHasBackend(config: ResolvedPiEyesConfig): void {
  const route = config.backend.route;
  if (route.mode === "fixed" && !route.fixedModel) {
    throw new Error("fixed 路由必须指定 backend.route.fixedModel");
  }
  if (route.mode === "public-only" && !config.backend.ovhPublicChain.enabled) {
    throw new Error("public-only 路由必须启用 OVH 公共链");
  }
  if (route.mode === "automatic" && route.allowedModels?.length === 0 && !config.backend.ovhPublicChain.enabled) {
    throw new Error("自动候选为空时必须启用 OVH 公共链");
  }
}

/** 从低优先级向高优先级逐字段合并。 */
export function resolvePiEyesConfig(
  layers: readonly PiEyesConfigLayer[],
  base: ResolvedPiEyesConfig = DEFAULT_PI_EYES_CONFIG,
): ResolvedPiEyesConfig {
  const result = cloneResolved(base);
  for (const untrustedLayer of layers) {
    const layer = parsePiEyesConfigLayer(untrustedLayer);
    if (layer.ui?.language !== undefined) result.ui.language = layer.ui.language;
    if (layer.backend?.route?.mode !== undefined) result.backend.route.mode = layer.backend.route.mode;
    if (layer.backend?.route?.allowedModels !== undefined) {
      result.backend.route.allowedModels = cloneModels(layer.backend.route.allowedModels);
    }
    if (layer.backend?.route?.fixedModel !== undefined) {
      result.backend.route.fixedModel = { ...layer.backend.route.fixedModel };
    }
    if (layer.backend?.ovhPublicChain?.enabled !== undefined) {
      result.backend.ovhPublicChain.enabled = layer.backend.ovhPublicChain.enabled;
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
  const globalConfig = cloneResolved(config);

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

  return { globalConfig, config, globalLayer, projectLayer, warnings };
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
      const parsed = parsePiEyesConfigLayer(raw);
      return { raw: parsed as Record<string, unknown>, backupCurrent: candidate === path };
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
