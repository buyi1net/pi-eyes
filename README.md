# pi-eyes

pi-eyes v0.3.0 为 Pi Agent 提供按需视觉能力。DeepSeek、GLM 等纯文本模型继续负责推理与编程,需要看图时再调用辅助视觉模型或本地 `vision_*` 工具,无需切换整轮对话模型。工具会把文字、坐标、颜色、差异统计或文件路径返回给主模型,支持连续分析和迭代验证。

用户可以直接粘贴图片或提供本机可读路径。会话贴图保存在临时目录中,可跨轮使用并在会话结束后清理;图片预览以内联结果返回,不会打开系统看图器。

默认从 Pi 当前可用的视觉模型中自动选择,并开启免密 OVH 公共链兜底,不内置指定模型。通过 `/pi-eyes` 可以限制自动候选范围、固定一个 Pi 视觉模型或只使用公共链;认证由 Pi 管理,插件不保存 API key。原生多模态模型也能继续使用定位、裁剪、OCR、像素差异和矢量化等专用工具,插件不会擅自增删用户启用的工具。

## 环境要求

- Windows、Linux 或 macOS(`sharp` 为主像素后端,Windows 可回退到 PowerShell + GDI+);
- Pi Agent TUI。

## 使用方法

```bash
# 安装
pi install git:github.com/buyi1net/pi-eyes

# 验证
pi list

# 启用或禁用包内资源
pi config

# 更新
pi update git:github.com/buyi1net/pi-eyes

# 卸载
pi remove git:github.com/buyi1net/pi-eyes
```

安装后重启 pi(或 `/reload`)即可直接使用。

## 配置向导

在 Pi 交互界面输入 `/pi-eyes`,即可使用简体中文/英文向导。可选策略为:

1. 自动选择 Pi 视觉模型(默认):使用全部当前可用模型,或管理一个多选候选范围;
2. 手动指定 Pi 视觉模型:固定使用一个当前可用模型;
3. 仅使用免密 OVH 公共链。

向导只列出 Pi 当前可用且声明支持图片输入的模型。自动和手动模式可独立开启或关闭免密 OVH 公共链;除语言首屏外,每页菜单末尾可返回上一步,按 Esc 取消整个流程且不保存。插件只保存 provider/model 标识和策略,不保存密钥;模型调用与认证均走 Pi 自己的模型注册表。

## 工具列表

12 个工具既可单独调用,也可由主模型按任务需要组合成连续工作流。

| 工具 | 作用与用法 |
|---|---|
| `vision_describe` | 理解或比较 1-4 张图片并回答问题,适合分析截图、照片以及裁剪后的局部细节,也可返回 JSON 结构化结果 |
| `vision_ground` | 定位单个目标并返回原图像素坐标,通常配合 `crop → describe` 寻找和复核按钮、图标或界面区域 |
| `vision_detect` | 找出全部同类元素并返回编号与坐标,适合批量定位按钮、卡片、图标等重复目标 |
| `vision_crop` | 把指定区域裁剪为独立 PNG,用于放大细节、缩小分析范围后再交给描述或 OCR 工具 |
| `vision_present` | 在 Pi 工具结果中内联展示生成物或中间图片,供用户预览且不会打开系统看图器 |
| `vision_pixel_diff` | 逐像素比较两张图片并输出差异率、最差区域、热力图和报告,用于 UI 还原后的差异定位与迭代验收 |
| `vision_colors` | 提取图片主色、十六进制色值及占比,用于分析参考图配色并辅助还原页面或设计稿 |
| `vision_ocr` | 转写单张截图、票据、表格或局部图片中的文字,可自动选择或强制使用本地 Tesseract/视觉后端 |
| `vision_long_screenshot_ocr` | 分块识别长截图并去除重叠文本,用于把聊天记录、长文档或整页截图输出为 Markdown 和完整性统计 |
| `vision_trace` | 按彩色分色或灰度分层把位图转成 SVG,适合矢量化图标、Logo 和简单图形 |
| `vision_extract_foreground` | 去除纯色背景并输出透明 PNG,用于提取图标或素材并可继续交给 `vision_trace` 矢量化 |
| `vision_html_screenshot` | 用本机无头 Chrome/Edge 截取 HTML 视口或完整页面,生成前端实现截图后可交给 `vision_pixel_diff` 迭代验证 |

## 可选增强(不装也能用)

- **Chrome / Edge**:vision_html_screenshot 需要(装了自动探测);
- **tesseract**(chi_sim+eng):本地 OCR 优先走它(更快、离线),没有则自动走视觉模型。

PNG、JPEG、WebP 和 GIF 由随插件安装的 `sharp` 处理,不需要额外安装 ImageMagick。

## 视觉后端与隐私

- 默认 Pi 后端:从当前可用且声明支持图片输入的模型中稳定选择,成功模型在当前会话内保持不变;
- 默认兜底:OVHcloud AI Endpoints 免密公共链(无需 API key,可关闭或设为唯一后端;具体配额以服务方当前说明为准);
- 图片会发送到所选远端视觉模型,使用公共链时还可能发送到 OVH。免密不表示图片不出网或请求无法关联来源;请勿提交不适合发送到对应服务的敏感图片;
- 看图请求只包含所问图片与问题文本;失败按类别熔断,不会反复重试。

## 外部参考

dsh-vision-router：“文本模型当大脑、视觉模型当眼睛”的核心设计思想。

- 上游项目:[ysr666/dsh-vision-router](https://github.com/ysr666/dsh-vision-router);
- 对照版本:[commit `7c0ac17a252a9b56a3d363a0a26f33709e277309`](https://github.com/ysr666/dsh-vision-router/commit/7c0ac17a252a9b56a3d363a0a26f33709e277309);
- 核验日期:2026-08-17;
- 上游许可:[MIT License](https://github.com/ysr666/dsh-vision-router/blob/7c0ac17a252a9b56a3d363a0a26f33709e277309/LICENSE)。

## 开源协议

pi-eyes 的自有代码以 MIT License 发布。
