# Contributing

Thanks for considering a contribution.

## Before You Start

- For small bug fixes, docs updates, translations, or styling tweaks, feel free
  to open a pull request directly.
- For larger feature work, architectural changes, or major UI/UX direction
  changes, please open an issue first so the scope can be aligned.
- Use the issue templates under `.github/ISSUE_TEMPLATE/` so reports and
  proposals include the right context.

## Documentation

- English docs: `README.md`
- Chinese docs: `README.zh-CN.md`

## Local Setup

Requirements:
- Node.js 18+
- npm 9+

Install dependencies:

```bash
npm install
```

Start the dev server:

```bash
npm run dev
```

Build before submitting:

```bash
npm run build
```

## Contribution Workflow

1. Fork the repository
2. Create a focused branch
3. Make your change in small, reviewable commits
4. Run `npm run build`
5. Open a pull request with a clear summary and screenshots if the change is UI-related

## Pull Request Checklist

- The change is scoped and intentional
- The code builds successfully with `npm run build`
- Documentation is updated when behavior changes
- UI changes include before/after notes or screenshots
- Breaking changes are called out explicitly

## Coding Expectations

- Keep changes consistent with the existing architecture
- Do not silently revert unrelated user or maintainer work
- Prefer readable, explicit code over clever shortcuts
- Keep frontend behavior responsive and avoid obvious main-thread regressions
- Preserve attribution where this project builds on upstream ideas

## AI-Assisted Contributions

This repository openly allows AI-assisted contributions, but contributors remain
responsible for the final result.

If AI tools were used in your contribution, please disclose that in the pull
request description together with:
- Which parts were AI-assisted
- What you manually reviewed or rewrote
- Any parts that still need careful human verification

## Licensing

By submitting a contribution, you agree that your work will be licensed under
this repository's MIT License.
