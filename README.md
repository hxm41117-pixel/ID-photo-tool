# 极简实用证件照与格式转换工具（纯前端离线版）

基于 **React + Vite + TypeScript + Tailwind CSS** 构建的纯静态单页 Web 应用（SPA）。所有图像处理、AI 抠图、DPI 写入、指定 KB 压缩、六寸排版、目录索引图绘制与 ZIP 打包全部在用户浏览器本地完成，零后端、零 API 密钥、零图片上传。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 提取本地 AI 抠图模型与 WASM 至 public/bg-removal-assets/
npm run prepare:models

# 3. 本地开发预览
npm run dev

# 4. 打包生成纯静态 dist 文件夹（可直接拖拽部署到 Cloudflare Pages / 腾讯云 EdgeOne Pages）
npm run build
```

## 核心特性

1. **纯本地免费高精度 AI 抠图 + 全图封闭空隙去底 + 18px 发丝深层去色溢（`cleanEdgeSpill`）**：
   - `predev` / `prebuild` 自动同步 `@imgly/background-removal-data` 的 WASM 内核与高精度 `medium`（FP16）人像分割模型至 `public/imgly-assets/`，运行时优先从 `${window.location.origin}/imgly-assets/` 本地加载，本地异常时自动降级至官方/jsDelivr 备用镜像，并提供 Toast 状态与报错提示。
   - 纯色底快速换底在四角泛洪填充基础上增加**全局颜色距离扫描**，自动清除发丝与肩颈之间的封闭蓝/红底空隙且保护人脸肤色。
   - `cleanEdgeSpill` 覆盖距离任意透明像素 **`18px`** 保护带，针对非肤色暗部发丝强行压低蓝色/红色溢出通道至 `Math.min(r, g)`（默认强度 `80%`），彻底消除蓝底转红底/白底后发丝内部的蓝色反光。
2. **极简 1-2-3 线性步骤流（PC 双栏 / 移动端原生修图布局）**：
   - **PC 端（`>= 768px`）**：左侧纯粹构图预览（底部默认折叠「抠图方式与边缘微调」），右侧按「1. 选择使用场景 → 2. 确认背景底色 → 3. 导出与打包」三步走；自定义规格支持 `300 DPI` / `350 DPI` 快捷切换与 **`72 ~ 600` 自定义 DPI 数字输入**（实时写入 JFIF 元数据）。
   - **移动端（`< 768px`）**：顶部 `sticky top-0` 吸顶预览台（`36vh ~ 40vh`）+ 中部三标签切换控制台（`① 场景与尺寸` / `② 背景底色` / `③ 抠图微调`）+ 底部悬浮操作栏与底部抽屉弹窗（Bottom Sheet）出图，切换任意底色或尺寸时无需滚动即可实时看见顶部预览变化。
3. **极简图片转格式**：仅保留目标格式（JPG/PNG/WebP）与文件体积控制（保持原画质 / 指定 KB 上限自动二分法压缩），透明图转 JPG 自动底层填白。

## 部署说明

- `dist/` 目录中已自动包含 `bg-removal-assets/`（量化人像分割 ONNX 模型分片与 WASM 内核，单片均 ≤ 4 MB，完全满足 Cloudflare Pages 单文件 25 MB 上限）。
- 运行时通过相对路径 `./bg-removal-assets/` 加载，不访问任何海外默认 CDN。
