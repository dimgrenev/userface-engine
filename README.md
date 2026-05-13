# Userface Engine

Public workspace for `@userface/engine`.

`@userface/engine` gives AI-assisted UI tools a typed view of a component library:
component discovery, prop extraction, `face.json` contracts, `ui@1` composition
validation, code generation, registry scanning, and MCP tools.

## Packages

| Package | Status | Purpose |
| --- | --- | --- |
| `@userface/engine` | public release target | Engine SDK, CLI, MCP server, validators, registry, codegen |
| `userface` | staged | Branded helper CLI. Not part of the default engine release because npm `userface` already has a legacy 1.x line. |

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

Useful commands:

```sh
pnpm build
pnpm test
pnpm smoke
pnpm run pack:packages
pnpm --dir packages/engine exec userface-engine --help
```

## Release

The default release path publishes only `@userface/engine`.

```sh
pnpm publish:engine
```

GitHub release workflow:

- tag format: `engine-v<version>`
- example: `engine-v0.1.1`
- required secret: `NPM_TOKEN`

The `userface` package must be released separately after its npm version line is
intentionally reclaimed from the legacy package.

## Repository Policy

The private Userface workspace is the source of truth. This repository is the
standalone public engine snapshot. Public releases should not include app,
billing, desktop, site, or private workspace code.
