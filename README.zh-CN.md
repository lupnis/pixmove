# pixmove

> **Vibe Coding 提示**
> 本仓库是一个有 AI 协助参与的工程项目。
> AI 工具被用于原型设计、实现、重构、调试和文档整理；在生产使用前，
> 仍然需要人工审查与验证。

English documentation: [README.md](./README.md)

## 致敬

`pixmove` 是一个面向浏览器的重新实现，其产品思路、核心算法方向与整体
审美明显受到 [Spu7Nix/obamify](https://github.com/Spu7Nix/obamify) 的启发。

本项目的分配逻辑、形变方向与大量概念基础都来自 `obamify`。
这里并不是官方移植版，也与上游仓库没有从属关系，但会明确承认：
关键思路与核心算法来源于 `obamify` 及其 MIT 许可代码库。

参考链接：
- 上游仓库：<https://github.com/Spu7Nix/obamify>
- 上游许可证：<https://github.com/Spu7Nix/obamify/blob/master/LICENSE>

## 项目简介

`pixmove` 是一个基于 `Vue 3 + Vite + PixiJS + anime.js` 的前端图像重分配与
形变实验。

它允许你上传图片 A 和图片 B，生成带关键帧时间轴的变换动画，在浏览器内
预览，保存本地历史记录，并导出 GIF。

当前项目特性：
- 纯前端运行，不依赖 Rust 后端
- 使用 `Web Worker + WASM` 做分配与模拟计算
- 使用 `PixiJS / WebGL` 做预览与离屏渲染
- 历史记录持久化到 `IndexedDB / localStorage`
- GIF 导出走纯前端编码链路，不依赖 `ffmpeg`

## 功能概览

- 上传原始图像 A / 目标图像 B
- 选择内置模板图像
- 生成接近 `obamify` 思路的 cell reassignment / morph 动画
- 多段关键帧时间轴编辑
- 播放、暂停、停止预览
- 历史记录回放、删除与导出
- 语言、主题与界面偏好设置
- GitHub Pages 自动部署支持

## 技术栈

- `Vue 3`
- `Vite`
- `PixiJS`
- `anime.js`
- `gifenc`
- `IndexedDB + localStorage`
- `Web Worker`
- `AssemblyScript / WASM`

## 快速开始

环境要求：
- Node.js 18+
- npm 9+

安装依赖并启动开发环境：

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

本地预览构建结果：

```bash
npm run preview
```

## 常用脚本

```bash
# 构建 WASM 产物
npm run wasm:build

# 启动开发服务器（会先构建 WASM）
npm run dev

# 生产构建（会先构建 WASM）
npm run build

# 预览 dist 输出
npm run preview
```

## 项目结构

```text
.
|- public/                  # 静态资源
|- scripts/                 # 构建脚本，包括 WASM 构建
|- src/
|  |- components/           # Vue 组件
|  |- composables/          # 渲染/导出/历史/引擎模块
|  |- config/               # YAML 与界面配置
|  |- data/                 # 内置模板和静态数据
|  |- i18n/                 # 国际化文案
|  |- res/                  # 资源文件
|  |- utils/                # 时间轴与格式化工具
|  |- wasm/                 # WASM 源码与生成文件
|  `- workers/              # Worker 逻辑
|- .github/workflows/       # GitHub Actions / Pages 工作流
|- README.md
|- README.zh-CN.md
`- LICENSE
```

## GitHub Pages 部署

仓库包含部署工作流：
[.github/workflows/deploy-pages.yml](./.github/workflows/deploy-pages.yml)。

默认行为：
- 推送到 `main` 或 `master` 时自动构建并部署
- 支持手动触发 `workflow_dispatch`
- 构建时使用相对资源路径，适配 GitHub Pages 的仓库子路径部署

使用前请在仓库设置中确认：
- `Settings -> Pages -> Source` 选择 `GitHub Actions`
- 已开启 Actions 与 Pages 部署权限

## 社区与治理文件

仓库已补齐常见治理与协作文件：
- [LICENSE](./LICENSE)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md)
- [.github/ISSUE_TEMPLATE](./.github/ISSUE_TEMPLATE)

## 许可证

本项目采用 [MIT License](./LICENSE)。
同时也请尊重上游 `obamify` 的 MIT 许可证与来源归属。

## 鸣谢

特别感谢 `obamify` 提供的原始灵感、核心方向与算法审美。

也感谢 `Vue`、`Vite`、`PixiJS`、`anime.js`、`gifenc` 与开源社区。