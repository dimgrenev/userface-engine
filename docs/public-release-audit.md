# Public Release Audit

Date: 2026-05-13

Scope: public npm release readiness for `@userface/engine` and the buyer-facing
`userface` CLI.

## Decision

`@userface/engine` and `userface` are the release targets.

`@userface/engine` owns the implementation. `userface` owns the short public
command used in docs and commercial workflows, then forwards engine commands
such as `guard`, `readiness`, `trust`, `proof-schema`, and `mcp-serve`.

If the npm `userface` package line is still occupied by a legacy release, do not
publish paid pages that rely on `npx userface ...`. Reclaim the package line or
temporarily document the transitional `userface-engine` alias.

## Fixed Before Release

- Root test command now runs the full Vitest suite from `vitest.config.ts`.
- Release workflow publishes `@userface/engine` first and `userface` second.
- Publish script accepts explicit package names and defaults to both public
  packages.
- Root `pnpm check` includes packed-tarball smoke for `userface` and the
  transitional `userface-engine` alias.
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
npm view userface version
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
