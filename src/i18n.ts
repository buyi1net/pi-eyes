export type EyesSetupLanguage = "zh-CN" | "en";

export interface EyesSetupMessages {
  commandDescription: string;
  languageTitle: string;
  languageChinese: string;
  languageEnglish: string;
  back: string;
  scopeTitle: string;
  scopeGlobal: string;
  scopeProject: string;
  strategyTitle: string;
  strategyAutomatic: string;
  strategyFixed: string;
  strategyPublicOnly: string;
  currentConfiguration: (route: string) => string;
  automaticRangeTitle: string;
  automaticRangeAll: string;
  automaticRangeCustom: string;
  automaticCandidatesTitle: (selected: number, available: number) => string;
  automaticCandidatesDone: string;
  modelTitle: string;
  modelUnavailable: string;
  modelsUnavailable: (models: string[]) => string;
  modelStatusAuthenticated: string;
  modelStatusNoAuthRequired: string;
  refreshModels: string;
  refreshComplete: string;
  refreshFailed: (reason: string) => string;
  noUsableVisionModels: string;
  publicFallbackTitle: string;
  publicFallbackEnabled: string;
  publicFallbackDisabled: string;
  atLeastOneBackend: string;
  testTitle: string;
  testQuestion: (model: string) => string;
  testNow: string;
  testSkip: string;
  testPassed: string;
  testFailed: (reason: string) => string;
  testRetry: string;
  testUseAnyway: string;
  confirmTitle: string;
  confirmMessage: (scope: string, route: string, models: string, publicChain: string) => string;
  saveConfiguration: string;
  allAvailableVisionModels: string;
  noSelectedVisionModels: string;
  publicModel: string;
  publicFallbackOn: string;
  publicFallbackOff: string;
  savedGlobal: string;
  savedProject: string;
  saveFailed: (reason: string) => string;
  nonInteractive: string;
}

const ZH_CN: EyesSetupMessages = {
  commandDescription: "配置 Pi Eyes / Configure Pi Eyes",
  languageTitle: "语言 / Language",
  languageChinese: "简体中文",
  languageEnglish: "English",
  back: "← 返回上一步",
  scopeTitle: "配置保存位置",
  scopeGlobal: "全局（所有项目）",
  scopeProject: "当前项目",
  strategyTitle: "视觉路由",
  strategyAutomatic: "自动选择 Pi 视觉模型",
  strategyFixed: "手动指定 Pi 视觉模型",
  strategyPublicOnly: "仅使用免密 OVH 公共链",
  currentConfiguration: (route) => `当前配置：${route}`,
  automaticRangeTitle: "自动选择可以使用哪些 Pi 视觉模型？",
  automaticRangeAll: "所有当前可用的 Pi 视觉模型",
  automaticRangeCustom: "管理候选模型",
  automaticCandidatesTitle: (selected, available) => `管理候选模型（已选 ${selected}/${available}）`,
  automaticCandidatesDone: "完成选择",
  modelTitle: "选择 Pi 视觉模型",
  modelUnavailable: "该 Pi 视觉模型当前不可用，请重新选择。",
  modelsUnavailable: (models) => `这些 Pi 视觉模型已经不可用，请重新确认候选范围：${models.join("、")}`,
  modelStatusAuthenticated: "已认证，可用",
  modelStatusNoAuthRequired: "无需认证，可用",
  refreshModels: "刷新 Pi 模型目录",
  refreshComplete: "Pi 模型目录已刷新。",
  refreshFailed: (reason) => `刷新模型失败：${reason}`,
  noUsableVisionModels: "Pi 当前没有可用的视觉模型。自动模式仍可使用免密 OVH 公共链。",
  publicFallbackTitle: "Pi 视觉模型不可用时，是否使用免密 OVH 公共链？",
  publicFallbackEnabled: "开启免密 OVH 公共链",
  publicFallbackDisabled: "关闭免密 OVH 公共链",
  atLeastOneBackend: "候选模型为空时必须开启免密 OVH 公共链。",
  testTitle: "测试 Pi 视觉模型",
  testQuestion: (model) => `现在测试 ${model} 的连接和图片输入能力吗？`,
  testNow: "立即测试",
  testSkip: "跳过测试并继续",
  testPassed: "Pi 视觉模型测试通过。",
  testFailed: (reason) => `Pi 视觉模型测试失败：${reason}`,
  testRetry: "重新测试",
  testUseAnyway: "仍然使用并继续",
  confirmTitle: "保存配置",
  confirmMessage: (scope, route, models, publicChain) =>
    `保存位置：${scope}\n路由：${route}\nPi 视觉模型：${models}\n免密 OVH 公共链：${publicChain}`,
  saveConfiguration: "保存配置",
  allAvailableVisionModels: "所有当前可用模型",
  noSelectedVisionModels: "未选择",
  publicModel: "不使用",
  publicFallbackOn: "开启",
  publicFallbackOff: "关闭",
  savedGlobal: "Pi Eyes 全局配置已保存。",
  savedProject: "Pi Eyes 当前项目配置已保存。",
  saveFailed: (reason) => `保存配置失败：${reason}`,
  nonInteractive: "/pi-eyes 需要 Pi TUI 或支持扩展对话协议的 RPC 客户端；本次没有写入配置。 /pi-eyes requires Pi TUI or an RPC client with the extension UI protocol; no configuration was written.",
};

const EN: EyesSetupMessages = {
  commandDescription: "Configure Pi Eyes / 配置 Pi Eyes",
  languageTitle: "Language / 语言",
  languageChinese: "简体中文",
  languageEnglish: "English",
  back: "← Back",
  scopeTitle: "Save configuration to",
  scopeGlobal: "Global (all projects)",
  scopeProject: "Current project",
  strategyTitle: "Vision routing",
  strategyAutomatic: "Automatically select a Pi vision model",
  strategyFixed: "Manually select a Pi vision model",
  strategyPublicOnly: "Use the keyless OVH public chain only",
  currentConfiguration: (route) => `Current configuration: ${route}`,
  automaticRangeTitle: "Which Pi vision models may automatic selection use?",
  automaticRangeAll: "All currently available Pi vision models",
  automaticRangeCustom: "Manage candidate models",
  automaticCandidatesTitle: (selected, available) => `Manage candidate models (${selected}/${available} selected)`,
  automaticCandidatesDone: "Finish selection",
  modelTitle: "Choose a Pi vision model",
  modelUnavailable: "This Pi vision model is no longer available. Choose another model.",
  modelsUnavailable: (models) => `These Pi vision models are no longer available. Review the candidate list: ${models.join(", ")}`,
  modelStatusAuthenticated: "Authenticated, available",
  modelStatusNoAuthRequired: "No authentication required, available",
  refreshModels: "Refresh Pi model catalogue",
  refreshComplete: "Pi model catalogue refreshed.",
  refreshFailed: (reason) => `Could not refresh models: ${reason}`,
  noUsableVisionModels: "Pi has no available vision model. Automatic mode can still use the keyless OVH public chain.",
  publicFallbackTitle: "Use the keyless OVH public chain when the Pi vision model is unavailable?",
  publicFallbackEnabled: "Enable the keyless OVH public chain",
  publicFallbackDisabled: "Disable the keyless OVH public chain",
  atLeastOneBackend: "Enable the keyless OVH public chain when no candidate model is selected.",
  testTitle: "Test Pi vision model",
  testQuestion: (model) => `Test ${model}'s connection and image input now?`,
  testNow: "Test now",
  testSkip: "Skip test and continue",
  testPassed: "Pi vision model test passed.",
  testFailed: (reason) => `Pi vision model test failed: ${reason}`,
  testRetry: "Test again",
  testUseAnyway: "Use it anyway and continue",
  confirmTitle: "Save configuration",
  confirmMessage: (scope, route, models, publicChain) =>
    `Scope: ${scope}\nRoute: ${route}\nPi vision models: ${models}\nKeyless OVH public chain: ${publicChain}`,
  saveConfiguration: "Save configuration",
  allAvailableVisionModels: "All currently available models",
  noSelectedVisionModels: "None selected",
  publicModel: "Not used",
  publicFallbackOn: "Enabled",
  publicFallbackOff: "Disabled",
  savedGlobal: "Pi Eyes global configuration saved.",
  savedProject: "Pi Eyes project configuration saved.",
  saveFailed: (reason) => `Could not save configuration: ${reason}`,
  nonInteractive: "/pi-eyes requires Pi TUI or an RPC client with the extension UI protocol; no configuration was written.",
};

export function getEyesSetupMessages(language: EyesSetupLanguage): EyesSetupMessages {
  return language === "en" ? EN : ZH_CN;
}
