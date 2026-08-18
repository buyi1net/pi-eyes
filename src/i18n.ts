export type EyesSetupLanguage = "zh-CN" | "en";

export interface EyesSetupMessages {
  commandDescription: string;
  windowTitle: string;
  globalConfiguration: string;
  projectOverrideWarning: string;
  savedWithProjectOverride: string;
  languageLabel: string;
  languageChinese: string;
  languageEnglish: string;
  routeLabel: string;
  routeAutomatic: string;
  routeFixed: string;
  routePublicOnly: string;
  ovhLabel: string;
  enabled: string;
  disabled: string;
  selectedModels: string;
  availableModels: string;
  emptySelected: string;
  emptyAvailable: string;
  modelStatusAuthenticated: string;
  modelStatusNoAuthRequired: string;
  help: string;
  refreshRunning: string;
  refreshComplete: string;
  refreshUnavailable: string;
  refreshFailed: (reason: string) => string;
  testRunning: (model: string) => string;
  testPassed: (model: string) => string;
  testUnavailable: string;
  testFailed: (model: string, reason: string) => string;
  saveRunning: string;
  savedGlobal: string;
  saveFailed: (reason: string) => string;
  fixedModelRequired: string;
  atLeastOneBackend: string;
  publicChainRequired: string;
  publicOnlyModelHint: string;
  modelsChanged: string;
  nonInteractive: string;
}

const ZH_CN: EyesSetupMessages = {
  commandDescription: "配置 Pi Eyes / Configure Pi Eyes",
  windowTitle: "Pi Eyes 视觉配置",
  globalConfiguration: "配置会保存到 Pi 全局目录，对所有项目生效。",
  projectOverrideWarning: "当前项目存在旧的项目级覆盖；这里仍只修改全局配置，当前项目继续以旧覆盖为准。",
  savedWithProjectOverride: "Pi Eyes 全局配置已保存；当前项目仍由旧的项目级配置覆盖。",
  languageLabel: "界面语言",
  languageChinese: "简体中文",
  languageEnglish: "English",
  routeLabel: "视觉路由",
  routeAutomatic: "自动选择",
  routeFixed: "固定模型",
  routePublicOnly: "仅公共链",
  ovhLabel: "免密 OVH 公共链",
  enabled: "开启",
  disabled: "关闭",
  selectedModels: "已选模型",
  availableModels: "可选模型",
  emptySelected: "（未选择 Pi 视觉模型）",
  emptyAvailable: "（没有其它可用模型）",
  modelStatusAuthenticated: "已认证",
  modelStatusNoAuthRequired: "无需认证",
  help: "Tab/←→ 切换列表  ↑↓ 定位  Enter/Space 移动模型  M 路由  O 公共链  L 语言  Ctrl+R 刷新  Ctrl+T 测试  Ctrl+S 保存  Esc 退出",
  refreshRunning: "正在刷新 Pi 模型目录……",
  refreshComplete: "Pi 模型目录已刷新。",
  refreshUnavailable: "当前环境不支持刷新 Pi 模型目录。",
  refreshFailed: (reason) => `刷新模型失败：${reason}`,
  testRunning: (model) => `正在测试 ${model}……`,
  testPassed: (model) => `${model} 测试通过。`,
  testUnavailable: "当前环境不支持模型测试。",
  testFailed: (model, reason) => `${model} 测试失败：${reason}`,
  saveRunning: "正在保存全局配置……",
  savedGlobal: "Pi Eyes 全局配置已保存。",
  saveFailed: (reason) => `保存配置失败：${reason}`,
  fixedModelRequired: "固定模型模式必须从右侧选择一个 Pi 视觉模型。",
  atLeastOneBackend: "没有已选模型时必须开启免密 OVH 公共链。",
  publicChainRequired: "仅公共链模式必须开启免密 OVH 公共链。",
  publicOnlyModelHint: "仅公共链模式不使用 Pi 视觉模型；按 M 切换路由后再选择。",
  modelsChanged: "Pi 可用模型已经变化，请核对左右列表后再次保存。",
  nonInteractive: "/pi-eyes 只能在 Pi TUI 中打开；本次没有写入配置。 /pi-eyes is available only in the Pi TUI; no configuration was written.",
};

const EN: EyesSetupMessages = {
  commandDescription: "Configure Pi Eyes / 配置 Pi Eyes",
  windowTitle: "Pi Eyes vision settings",
  globalConfiguration: "Settings are saved globally for every Pi project.",
  projectOverrideWarning: "This project has a legacy project override. This screen still changes only the global settings; the project keeps using its override.",
  savedWithProjectOverride: "Pi Eyes global settings saved; this project is still using its legacy project override.",
  languageLabel: "Language",
  languageChinese: "简体中文",
  languageEnglish: "English",
  routeLabel: "Vision route",
  routeAutomatic: "Automatic",
  routeFixed: "Fixed model",
  routePublicOnly: "Public chain only",
  ovhLabel: "Keyless OVH public chain",
  enabled: "On",
  disabled: "Off",
  selectedModels: "Selected models",
  availableModels: "Available models",
  emptySelected: "(No Pi vision model selected)",
  emptyAvailable: "(No other model available)",
  modelStatusAuthenticated: "authenticated",
  modelStatusNoAuthRequired: "no authentication required",
  help: "Tab/←→ panes  ↑↓ navigate  Enter/Space move  M route  O public chain  L language  Ctrl+R refresh  Ctrl+T test  Ctrl+S save  Esc exit",
  refreshRunning: "Refreshing the Pi model catalogue…",
  refreshComplete: "Pi model catalogue refreshed.",
  refreshUnavailable: "Model refresh is not available in this environment.",
  refreshFailed: (reason) => `Could not refresh models: ${reason}`,
  testRunning: (model) => `Testing ${model}…`,
  testPassed: (model) => `${model} passed the vision test.`,
  testUnavailable: "Model testing is not available in this environment.",
  testFailed: (model, reason) => `${model} failed the vision test: ${reason}`,
  saveRunning: "Saving global settings…",
  savedGlobal: "Pi Eyes global settings saved.",
  saveFailed: (reason) => `Could not save settings: ${reason}`,
  fixedModelRequired: "Fixed model mode requires one Pi vision model from the right list.",
  atLeastOneBackend: "Enable the keyless OVH public chain when no model is selected.",
  publicChainRequired: "Public chain only mode requires the keyless OVH public chain.",
  publicOnlyModelHint: "Public chain only mode does not use Pi vision models. Press M before selecting one.",
  modelsChanged: "Pi's available models changed. Review both lists, then save again.",
  nonInteractive: "/pi-eyes is available only in the Pi TUI; no configuration was written.",
};

export function getEyesSetupMessages(language: EyesSetupLanguage): EyesSetupMessages {
  return language === "en" ? EN : ZH_CN;
}
