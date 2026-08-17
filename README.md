# pi-eyes

给 pi 里的纯文本模型装上眼睛。核心思想(移植自 [dsh-vision-router](https://github.com/ysr666/dsh-vision-router)):文本模型当大脑,视觉模型只当眼睛——看图是工具调用,不是整轮切模型,可多步迭代(ground → crop → describe → diff)。

DeepSeek、GLM 等纯文本模型装上本扩展后,可以在对话里直接看图、定位元素、量像素差异、读长截图、矢量化图标。

## 安装

```bash
pi install git:github.com/buyi1net/pi-eyes
```

安装后重启 pi(或 `/reload`)即可,无需其它配置。建议为会话选一个文本模型(如 `deepseek/deepseek-v4-flash`、`zai-coding-cn/glm-5.2`),模型会自主调用下列工具看图。

## 工具(12 个)

| 工具 | 作用 |
|---|---|
| vision_describe | 看图问答,1-4 张,可要求 JSON 结构化 |
| vision_ground | 定位目标,返回原图像素框 + 标注图 |
| vision_detect | 找同类元素,编号清单 + 编号标注图 |
| vision_crop | 裁剪区域存 PNG |
| vision_present | 用系统看图器把图展示给用户 |
| vision_pixel_diff | 逐像素对比:差异率、最差区域、热力图 + 报告 |
| vision_colors | 主色提取(hex + 占比) |
| vision_ocr | 图中文字转写(本地 tesseract 优先,视觉模型兜底) |
| vision_long_screenshot_ocr | 长截图分块转写为 Markdown |
| vision_trace | 位图转 SVG(彩色分色 / 灰度分层) |
| vision_extract_foreground | 纯色背景抠图为透明 PNG |
| vision_html_screenshot | 本地 HTML 无头 Chrome 截图(viewport / fullPage) |

招牌流程:参考图 → 实现 HTML → `vision_html_screenshot` 截图 → `vision_pixel_diff` 度量 → 修复 → 迭代到差异收敛。

## 视觉后端与隐私

- 主力后端:pi 里已配置的 `zai-coding-cn/glm-4.6v`(凭证从 pi 的认证体系现取,本扩展不保存任何密钥);
- 兜底:OVHcloud AI Endpoints 匿名免费层(免 Key,每 IP 每模型 2 次/分钟);
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
