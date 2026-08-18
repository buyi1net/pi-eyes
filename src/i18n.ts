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
  strategyAuto: string;
  strategyPiOnly: string;
  strategyAnonymousOnly: string;
  modelTitle: string;
  modelManual: string;
  modelManualTitle: string;
  modelManualPlaceholder: string;
  modelInvalid: string;
  modelNotVisual: string;
  modelUnavailable: string;
  modelStatusAuthenticated: string;
  modelStatusNoAuthRequired: string;
  modelStatusUnavailable: string;
  refreshModels: string;
  refreshComplete: string;
  refreshFailed: (reason: string) => string;
  noUsableVisionModels: string;
  testTitle: string;
  testQuestion: (model: string) => string;
  testNow: string;
  testSkip: string;
  testPassed: string;
  testFailed: (reason: string) => string;
  testRetry: string;
  testUseAnyway: string;
  confirmTitle: string;
  confirmMessage: (scope: string, strategy: string, model: string) => string;
  saveConfiguration: string;
  anonymousModel: string;
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
  strategyTitle: "辅助视觉模型策略",
  strategyAuto: "自动回退（Pi 模型优先，匿名模型链兜底）",
  strategyPiOnly: "仅使用 Pi 模型",
  strategyAnonymousOnly: "仅使用匿名模型链",
  modelTitle: "选择 Pi 视觉模型",
  modelManual: "手动输入 provider/model",
  modelManualTitle: "输入 Pi 模型",
  modelManualPlaceholder: "provider/model",
  modelInvalid: "没有在 Pi 模型目录中找到这个模型。",
  modelNotVisual: "该模型没有声明图片输入能力。",
  modelUnavailable: "该模型当前不可用，请先在 Pi 中配置对应凭证。",
  modelStatusAuthenticated: "已认证，可用",
  modelStatusNoAuthRequired: "无需认证，可用",
  modelStatusUnavailable: "未认证或不可用",
  refreshModels: "刷新 Pi 模型目录",
  refreshComplete: "Pi 模型目录已刷新。",
  refreshFailed: (reason) => `刷新模型失败：${reason}`,
  noUsableVisionModels: "没有发现可用的 Pi 视觉模型。请返回上一步并选择匿名模型链。",
  testTitle: "测试视觉模型",
  testQuestion: (model) => `现在测试 ${model} 的连接和图片输入能力吗？`,
  testNow: "立即测试",
  testSkip: "跳过测试并继续",
  testPassed: "视觉模型测试通过。",
  testFailed: (reason) => `视觉模型测试失败：${reason}`,
  testRetry: "重新测试",
  testUseAnyway: "仍然使用并继续",
  confirmTitle: "保存配置",
  confirmMessage: (scope, strategy, model) =>
    `保存位置：${scope}\n策略：${strategy}\n模型：${model}`,
  saveConfiguration: "保存配置",
  anonymousModel: "匿名模型链",
  savedGlobal: "Pi Eyes 全局配置已保存。",
  savedProject: "Pi Eyes 当前项目配置已保存。",
  saveFailed: (reason) => `保存配置失败：${reason}`,
  nonInteractive: "/eyes-setup 需要 Pi TUI 或支持扩展对话协议的 RPC 客户端；本次没有写入配置。 /eyes-setup requires Pi TUI or an RPC client with the extension UI protocol; no configuration was written.",
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
  strategyTitle: "Assistant vision model strategy",
  strategyAuto: "Automatic fallback (Pi model first, anonymous chain as fallback)",
  strategyPiOnly: "Pi model only",
  strategyAnonymousOnly: "Anonymous model chain only",
  modelTitle: "Choose a Pi vision model",
  modelManual: "Enter provider/model manually",
  modelManualTitle: "Enter a Pi model",
  modelManualPlaceholder: "provider/model",
  modelInvalid: "This model was not found in Pi's model catalogue.",
  modelNotVisual: "This model does not declare image input support.",
  modelUnavailable: "This model is unavailable. Configure its credentials in Pi first.",
  modelStatusAuthenticated: "Authenticated, available",
  modelStatusNoAuthRequired: "No authentication required, available",
  modelStatusUnavailable: "Unauthenticated or unavailable",
  refreshModels: "Refresh Pi model catalogue",
  refreshComplete: "Pi model catalogue refreshed.",
  refreshFailed: (reason) => `Could not refresh models: ${reason}`,
  noUsableVisionModels: "No usable Pi vision model was found. Go back and choose the anonymous model chain.",
  testTitle: "Test vision model",
  testQuestion: (model) => `Test ${model}'s connection and image input now?`,
  testNow: "Test now",
  testSkip: "Skip test and continue",
  testPassed: "Vision model test passed.",
  testFailed: (reason) => `Vision model test failed: ${reason}`,
  testRetry: "Test again",
  testUseAnyway: "Use it anyway and continue",
  confirmTitle: "Save configuration",
  confirmMessage: (scope, strategy, model) =>
    `Scope: ${scope}\nStrategy: ${strategy}\nModel: ${model}`,
  saveConfiguration: "Save configuration",
  anonymousModel: "Anonymous model chain",
  savedGlobal: "Pi Eyes global configuration saved.",
  savedProject: "Pi Eyes project configuration saved.",
  saveFailed: (reason) => `Could not save configuration: ${reason}`,
  nonInteractive: "/eyes-setup requires Pi TUI or an RPC client with the extension UI protocol; no configuration was written.",
};

export function getEyesSetupMessages(language: EyesSetupLanguage): EyesSetupMessages {
  return language === "en" ? EN : ZH_CN;
}
