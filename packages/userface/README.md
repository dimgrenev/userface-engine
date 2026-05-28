# userface

Buyer-facing CLI for the Userface ecosystem.

This package is the short command surface used in docs and sales material. It
forwards engine-owned commands to `@userface/engine` so users can run one stable
command name:

```sh
npx userface guard --changed --offline --fail-on warning --proof userface-proof.json
```

## Commands

```sh
userface add engine
userface connect --root src/components
userface validate src/components --ci
userface readiness --root .
userface guard --changed --offline --fail-on warning --proof userface-proof.json
userface trust --offline --summary userface-trust.md
userface mcp-serve --root src/components
userface generate EmptyState
```

`userface add engine` installs `@userface/engine` into an existing project.

`userface validate ...` wraps the engine validator and returns an aggregate
CI-friendly report.

Most engine commands, including `connect`, `analyze`, `readiness`, `guard`,
`trust`, `composition-validate`, `materialize`, `proof-schema`, and `mcp-serve`,
forward to the installed `@userface/engine` CLI so public docs can use one
stable `userface` command name.

`userface generate ...` creates a starter component and matching contract in a
local component directory.

## Release note

Publish `@userface/engine` first, then publish `userface`. If the legacy npm
`userface` package line is not yet available, do not publish paid docs that rely
on `npx userface ...`; reclaim the package or temporarily document the
transitional `userface-engine` alias.
