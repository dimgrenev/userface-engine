# Engine Package Agent Rules

Scope: `packages/engine/**`.

## Mission

Keep engine contracts, package exports, browser runtime, and public runtime sync
safe while reducing complexity in small verified steps.

## Local Rules

1. Do not edit `public/runtime/**` from this package unless the task explicitly
   allows public runtime changes.
2. Do not delete or rename JS siblings beside TS files until their role is
   proven by package exports, runtime references, and build scripts.
3. Treat `src/browser/**`, `src/prop-extractor.js`, and
   `public/runtime/engine/**` as a sync graph, not independent files.
4. Do not change `scripts/build-public.cjs`, `scripts/build-npm.cjs`, or
   `package.json` exports without a package/runtime verification plan.
5. Do not run build or sync commands that may write files unless the task
   explicitly allows them.
6. Prefer audit, tests, small internal extractions, or documentation before
   changing runtime loader behavior.

## Required Checks

Before engine changes:

1. `git status --short`
2. targeted `rg` for touched symbols and paths
3. package export check in `package.json`
4. public runtime sync impact check

After safe non-runtime changes:

1. `git status --short`
2. repeat targeted `rg`
3. run only the narrow check allowed by the task

## Stop Conditions

Stop if:

1. A touched file participates in `build-public.cjs` and the task did not allow
   public runtime work.
2. A JS/TS sibling relationship is `uncertain`.
3. A change can affect `@userface/engine` package exports.
4. A check command modifies files unexpectedly.

## Current No-Touch Areas

1. `src/browser/**`
2. `src/core-engine.*`
3. `src/userface-engine.js`
4. `src/prop-extractor.js`
5. `integrations/next/engineLoaderService.*`
6. `integrations/next/engineController.*`
7. `scripts/build-public.cjs`
8. `scripts/build-npm.cjs`
