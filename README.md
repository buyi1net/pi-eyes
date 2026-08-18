# pi-eyes

给 pi 里的纯文本模型装上眼睛。核心思想(移植自 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)):文本模型当大脑,视觉模型只当眼睛——看图是工具调用,不是整轮切模型,可多步迭代(ground → crop → describe → diff)。

DeepSeek、GLM 等纯文本模型装上本扩展后,可以在对话里直接看图、定位元素、量像素差异、读长截图、矢量化图标。

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

安装后重启 pi(或 `/reload`)即可直接使用。建议为会话选一个文本模型(如 `deepseek/deepseek-v4-flash`、`zai-coding-cn/glm-5.2`),模型会自主调用下列工具看图。需要更换辅助视觉模型或匿名链策略时,运行 `/eyes-setup`。

## 配置辅助视觉模型

在 Pi 交互界面输入 `/eyes-setup`,即可使用简体中文/英文向导。它只从 Pi 当前真正可调用的模型中列出声明支持图片输入的模型;辅助视觉模型独立于当前会话的主模型轮换范围,手动输入也必须通过同一可用性检查。除语言首屏外,每一步都把“返回上一步”放在菜单末尾;按 Esc 会取消整个向导且不保存。用户还可以刷新列表,或确认后用插件内置色块图测试所选模型;打开设置页本身不会发送图片。

可选策略为“所选 Pi 模型优先、匿名链兜底”“仅所选 Pi 模型”“仅匿名链”。默认仍是 `zai-coding-cn/glm-4.6v` 优先、匿名链兜底,因此不运行设置也能使用。全局配置位于 `~/.pi/agent/pi-eyes.json`;受信任项目可保存 `<项目>/.pi/pi-eyes.json` 覆盖全局配置。插件只保存 provider/model 标识和策略,不保存密钥;模型调用与认证均走 Pi 自己的模型注册表。

## 工具(12 个)

| 工具 | 作用 |
|---|---|
| vision_describe | 看图问答,1-4 张,可要求 JSON 结构化 |
| vision_ground | 定位目标,返回原图像素框;标注图默认不生成 |
| vision_detect | 找同类元素,编号清单;标注图默认不生成 |
| vision_crop | 裁剪区域存 PNG,再交给分析工具查看 |
| vision_present | 在 pi 工具结果中内联预览,不打开系统看图器 |
| vision_pixel_diff | 逐像素对比:差异率、最差区域、热力图 + 报告 |
| vision_colors | 主色提取(hex + 占比) |
| vision_ocr | 图中文字转写;可自动选择或强制 tesseract/视觉后端 |
| vision_long_screenshot_ocr | 长截图分块、去重,输出 Markdown 与完整性统计 |
| vision_trace | 位图转 SVG(彩色分色 / 灰度分层) |
| vision_extract_foreground | 纯色背景抠图为透明 PNG |
| vision_html_screenshot | 本地 HTML 无头 Chrome 截图(viewport / fullPage) |

招牌流程:参考图 → 实现 HTML → `vision_html_screenshot` 截图 → `vision_pixel_diff` 度量 → 修复 → 迭代到差异收敛。

扩展不会在切换模型时擅自增删 active tools。原生多模态模型可直接看图,纯文本模型用 `vision_describe` 获得语义视觉;ground/detect/crop/pixel_diff/ocr/trace 等专用工具对所有模型保留。用户贴图会按 pi 的图片结构落到会话临时目录,把可调用路径告知纯文本模型,同一会话可跨轮继续使用,会话关闭后自动清理。

## 视觉后端与隐私

- 默认主力后端:Pi 里登记的 `zai-coding-cn/glm-4.6v`(可通过 `/eyes-setup` 换成其它 Pi 视觉模型);
- 默认兜底:OVHcloud AI Endpoints 匿名免费层(免 Key,每 IP 每模型 2 次/分钟,可关闭或设为唯一后端);
- 图片会发送到所选远端视觉模型,使用匿名兜底时还可能发送到 OVH;请勿提交不适合发送到对应服务的敏感图片;
- 看图请求只包含所问图片与问题文本;失败按类别熔断,不会反复重试。

## 可选增强(不装也能用)

- **Chrome / Edge**:vision_html_screenshot 需要(装了自动探测);
- **ImageMagick**(`magick`):webp 格式解码需要;
- **tesseract**(chi_sim+eng):本地 OCR 优先走它(更快、离线),没有则自动走视觉模型。

## 环境要求

- Windows(像素管线使用 PowerShell + GDI+);
- pi 0.84+。

## 许可

MIT。像素算法与工具文案移植自 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)(MIT),在此致谢。
