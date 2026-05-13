# Public Release Audit

Date: 2026-05-13

Scope: `@userface/engine` public npm release readiness.

## Decision

`@userface/engine` is the release target.

The `userface` package is staged but not part of the default release. The npm
name already has a legacy `1.0.82` latest version, so releasing the staged
`0.1.x` CLI as `latest` would create a confusing and unsafe package history.

## Fixed Before Release

- Root test command now runs the full Vitest suite from `vitest.config.ts`.
- Engine release workflow publishes only `@userface/engine`.
- Publish script accepts explicit package names and defaults to the engine only.
- Next integration export now resolves to JavaScript, with TypeScript
  declarations included.
- Smoke test verifies the Next integration subpath through package exports.
- Public CLI help no longer advertises unfinished library/auth workflows.
- Experimental library/auth commands no longer create mock tokens.
- `keytar` moved to optional dependencies because it is only needed for
  experimental secure token storage.
- README files rewritten around real commands, real exports, and known limits.
- `userface validate` tests no longer depend on an external `face-ui-react`
  package path.

## Release Checklist

Run locally before tagging:

```sh
pnpm install
pnpm check
npm view @userface/engine version
```

Tag:

```sh
git tag engine-v0.1.1
git push origin engine-v0.1.1
```

GitHub Actions requirement:

- `NPM_TOKEN` secret exists in `dimgrenev/userface-engine`

## Current Known Limits

- React is the primary validated runtime path.
- Vue and Svelte support is present but less mature.
- Complex inherited React prop types may require manual `face.json`.
- Browser runtime integration assumes the host app serves the browser bundle.
- Library sync/auth workflows remain out of the public CLI surface.
