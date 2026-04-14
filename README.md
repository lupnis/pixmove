# pixmove

> **Vibe Coding Notice**
> This repository is an AI-assisted engineering project.
> AI tools were used during prototyping, implementation, refactoring, debugging,
> and documentation. Human review is still required before production use.

For Simplified Chinese documentation, see [README.zh-CN.md](./README.zh-CN.md).

## Tribute

`pixmove` is a browser-first reinterpretation inspired by
[Spu7Nix/obamify](https://github.com/Spu7Nix/obamify).

The assignment and morph direction, plus much of the conceptual groundwork,
come from `obamify`. This project is not an official port and is not affiliated
with the upstream repository, but it intentionally acknowledges that the key
idea and algorithmic taste originate there.

References:
- Upstream repository: <https://github.com/Spu7Nix/obamify>
- Upstream license: <https://github.com/Spu7Nix/obamify/blob/master/LICENSE>

## Overview

`pixmove` is a frontend image reassignment and morph experiment built with
`Vue 3 + Vite + PixiJS + anime.js`.

It lets you upload image A and image B, generate a keyframed transformation,
preview the animation in-browser, store local history, and export GIF files.

Current project characteristics:
- Frontend-only runtime, no Rust backend required
- `Web Worker + WASM` assisted assignment and simulation
- `PixiJS / WebGL` preview and offscreen rendering
- History persistence with `IndexedDB / localStorage`
- Pure frontend GIF export without `ffmpeg`

## Features

- Upload source image A and target image B
- Select built-in template images
- Generate `obamify`-inspired cell reassignment and morph animation
- Edit a multi-segment keyframe timeline
- Play, pause, and stop preview
- Replay, delete, and export history records
- Configure language, theme, and UI preferences
- Deploy automatically to GitHub Pages

## Tech Stack

- `Vue 3`
- `Vite`
- `PixiJS`
- `anime.js`
- `gifenc`
- `IndexedDB + localStorage`
- `Web Worker`
- `AssemblyScript / WASM`

## Quick Start

Requirements:
- Node.js 18+
- npm 9+

Install dependencies and start local development:

```bash
npm install
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Scripts

```bash
# Build WASM artifacts
npm run wasm:build

# Start dev server (builds WASM first)
npm run dev

# Production build (builds WASM first)
npm run build

# Preview dist output
npm run preview
```

## Project Layout

```text
.
|- public/                  # static assets
|- scripts/                 # build scripts, including WASM build
|- src/
|  |- components/           # Vue components
|  |- composables/          # render/export/history/engine modules
|  |- config/               # YAML and UI configuration
|  |- data/                 # built-in templates and static data
|  |- i18n/                 # translations
|  |- res/                  # bundled resources
|  |- utils/                # timeline and formatting helpers
|  |- wasm/                 # WASM source and generated output
|  `- workers/              # worker logic
|- .github/workflows/       # GitHub Actions / Pages workflows
|- README.md
|- README.zh-CN.md
`- LICENSE
```

## GitHub Pages

The repository contains a deployment workflow at
[.github/workflows/deploy-pages.yml](./.github/workflows/deploy-pages.yml).

Default behavior:
- Deploy automatically on pushes to `main` or `master`
- Support manual runs via `workflow_dispatch`
- Build with relative asset paths so deployment works under repository subpaths

Before using GitHub Pages, ensure in repository settings that:
- `Settings -> Pages -> Source` is set to `GitHub Actions`
- Actions and Pages deployment are enabled

## Community Files

The repository includes the commonly expected governance and contribution files:
- [LICENSE](./LICENSE)
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md)
- [SECURITY.md](./SECURITY.md)
- [SUPPORT.md](./SUPPORT.md)
- [.github/PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md)
- [.github/ISSUE_TEMPLATE](./.github/ISSUE_TEMPLATE)

## License

This project is released under the [MIT License](./LICENSE).
Please also preserve attribution to upstream `obamify` where this project builds
on its ideas and algorithmic direction.

## Acknowledgements

Special thanks to `obamify` for the original inspiration, core direction,
and algorithmic taste.

Thanks as well to `Vue`, `Vite`, `PixiJS`, `anime.js`, `gifenc`, and the wider
open-source ecosystem.
