# Userface Engine

This repository contains the public engine packages:

- `@userface/engine` - component analysis, face.json contracts, ui@1 validation/materialization, CLI, MCP server, and SDK entry points.
- `userface` - umbrella CLI for installing and validating Userface public packages.

## Development

```sh
pnpm install
pnpm check
```

Common commands:

```sh
pnpm build
pnpm test
pnpm smoke
pnpm run pack:packages
pnpm --dir packages/engine exec userface-engine --help
```

The source of truth is maintained in the private Userface workspace and synced here as a standalone public repo snapshot.
