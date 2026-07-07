# Userface Engine

Public workspace for `@userface/engine`.

`@userface/engine` gives AI-assisted UI tools a typed view of a component library:
component discovery, prop extraction, `face.json` contracts, face schema composition
validation, code generation, registry scanning, and MCP tools.

## Packages

| Package | Status | Purpose |
| --- | --- | --- |
| `@userface/engine` | public release target | Engine SDK, CLI, MCP server, validators, registry, codegen |
| `userface` | public release target | Buyer-facing umbrella CLI that forwards `userface guard`, `userface readiness`, `userface trust`, and `userface mcp-serve` to the engine package. |

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs:

- package build
- full Vitest suite
- engine smoke test
- `npm pack --dry-run` for publishable packages
- packed-tarball smoke for the buyer-facing `userface` CLI and transitional
  `userface-engine` alias

Useful commands:

```sh
pnpm build
pnpm test
pnpm smoke
pnpm run pack:packages
pnpm run smoke:public-cli
pnpm --dir packages/engine exec userface-engine --help
```

## Release

The default public release path publishes the engine first and the branded
umbrella CLI second, so docs that say `npx userface ...` match the package
surface.

```sh
pnpm publish:public
```

GitHub release workflow:

- tag format: `engine-v<version>`
- example: `engine-v0.1.1`
- required secret: `NPM_TOKEN`

If the legacy npm `userface` package line is not yet available, do not publish
commercial pages that rely on `npx userface ...`; either reclaim the package
first or temporarily document the transitional `userface-engine` alias.

## Repository Policy

The private Userface workspace is the source of truth. This repository is the
standalone public engine snapshot. Public releases should not include app,
billing, desktop, site, or private workspace code.
