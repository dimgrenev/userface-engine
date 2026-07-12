# Changelog

## Unreleased

- Added the provider-neutral `mergeGateEvidence@1` contract and public
  `@userface/engine/merge-gate` verifier.
- Added `userface merge-gate verify` with plain, JSON, GitHub Actions, and
  GitLab CI output modes. The command fails closed on tampered evidence, stale
  review revisions, inconsistent approvals, changed files, path traversal, and
  symlinks.

All notable changes to `@userface/engine` will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] - 2026-02-19

Initial release.

### Added

- **Core Engine** — `createEngine()` factory with dependency injection, `analyzeComponent()` returning `ComponentSpec` with props/types/framework/diagnostics, `renderFromSpec()` for SSR and live rendering.
- **Prop Extraction** — dual-mode: fast regex (~1ms, browser-safe) via `extractPropsFromCode()` and enriched ts-morph (server-side). String literal union resolution (`'a' | 'b'` → `options: ['a', 'b']`), local type alias resolution, enum extraction.
- **Face System** — `FaceSystem`, `FacesGenerator`, `FacesRenderer`, `FacesManager`. Generate, validate, render, compare, export/import `ComponentFace` specs. Multi-framework: React, Vue, Svelte.
- **Face UI** — declarative face schema v1 composition DSL. `FaceUiDoc` with `$ref` (data binding) and `$action` (event binding). `materializeFaceUiDoc()` with deterministic `nodeId` generation. `FaceUi` React component. `createFaceUiRegistry()` for type → component resolution. Zod schema validation.
- **State Matrix** — `generateStates()` with "one-at-a-time" and "cartesian" strategies. Manual states from `face.json`. Deduplication, `maxStates` cap.
- **VFS Bundler** — `bundleFromVfs()`: multi-file component bundling without webpack/vite. DFS dependency resolution, ES6→CJS transform, CSS Modules inlining, mini module runtime.
- **CLI** — `userface-engine` binary with commands: `analyze`, `states`, `render`, `test`, `connect`, `validate`, `composition-validate`, `diff`, `registry scan`, `materialize`, `mcp-serve`. JSON stdout, logs to stderr.
- **MCP Server** — JSON-RPC 2.0 over stdin/stdout. 8 tools: `component_analyze`, `component_render`, `component_states`, `component_test`, `component_validate`, `component_list`, `ui_materialize`, `composition_validate`. Spec caching with mtime invalidation.
- **Registry System** — `scanRegistry()`: recursive component discovery, face.json parsing, lightweight fallback prop extraction, mtime-based caching. CLI: `registry scan`.
- **Rule Engine** — `RuleEngine` with compiled matchers and conditions, `basePolicyPack` with 12 built-in rules (a11y, structural, contract), `ValidationReport` with scores and budget modes (llm/compact/verbose).
- **Composition Validator** — `validateComposition()`: structural checks (nesting, interactive-in-interactive), contract validation against registry, $ref/$action resolution, pattern compliance (form, dashboard, crud, settings, list-detail).
- **Contract Diffs** — `diffFaces()`: breaking/warning/info classification for face.json changes (removed props, type changes, enum narrowing). CLI: `diff --base --head` with exit code 1 on breaking.
- **Connect (Onboarding)** — `connect` CLI command: auto-detect framework + components dir, generate `userface.config.json`, configure `.cursor/mcp.json`, auto-generate face.json for components.
- **Codegen** — `generateCode()`: materialize face schema v1 documents into React JSX, Vue SFC, or HTML.
- **Recipe Packs** — 5 B2B face schema v1 templates: Dashboard, CRUD Table, Form, Settings, List-Detail. Bundled in `packs/recipes/`.
- **Base Policy Pack** — 15 rules in JSON format: `packs/policies/base/` (a11y, structure, contracts).
- **System Prompt Templates** — `prompts/cursor-rules.md`, `prompts/claude-prompt.md`, `prompts/generic-prompt.md` for AI-IDE integration.
- **Normalization** — `normalizePropDef()`, `normalizeAndDedup()`: canonical `ComponentProp` format from any extractor.
- **SSR Adapters** — React, Vue, Svelte server-side rendering adapters.
- **Code Sanitizer** — `UniversalCodeSanitizer` for safe code execution in sandbox environments.
- **Zod Validator** — runtime prop validation against generated Zod schemas.
- **CI/CD** — GitHub Actions: `ci.yml` (lint, typecheck, engine build, CLI smoke tests, MCP smoke), `engine-release.yml` (npm publish on tag `engine-v*`), `smoke-test.cjs` (ESM/CJS/CLI/types/browser verification).
