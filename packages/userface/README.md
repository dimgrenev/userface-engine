# userface

Staged branded CLI for the Userface ecosystem.

This package is included in the repository for local development and future
publishing. It is not part of the default `@userface/engine` release because the
npm `userface` package already has a legacy 1.x version line.

## Commands

```sh
userface add engine
userface validate src/components --ci
userface generate EmptyState
```

`userface add engine` installs `@userface/engine` into an existing project.

`userface validate ...` wraps the engine validator and returns an aggregate
CI-friendly report.

`userface generate ...` creates a starter component and matching contract in a
local component directory.

## Release Note

Do not publish this package as `0.x` over the existing npm `userface` package.
When the CLI is ready to replace the legacy package, release it intentionally on
a new version line.
