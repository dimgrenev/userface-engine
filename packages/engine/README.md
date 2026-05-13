# @userface/engine

Component intelligence for AI-assisted UI work.

Userface Engine turns a component library into machine-readable contracts and
tools. It helps an agent discover components, understand their props, validate
`ui@1` compositions, and generate framework code without guessing component APIs.

## Install

```sh
npm install @userface/engine
```

Requirements:

- Node.js 20+
- React 18+ for React analysis/render workflows
- Vue/Svelte dependencies only when using those render paths

## What It Does

| Area | Capability |
| --- | --- |
| Component analysis | Reads component files from a deterministic `entryPath` and extracts props/types |
| Registry | Scans component directories and reports entries, props, `face.json` status, and metadata |
| Contracts | Parses and validates `face.json` / face v2 contracts |
| Composition | Validates `ui@1` trees, registry boundaries, refs/actions, and built-in patterns |
| Codegen | Generates React, Vue, or HTML from `ui@1` documents |
| Quality rules | Runs the base policy pack for a11y, structure, and contract checks |
| MCP | Exposes engine tools to AI IDEs over stdio JSON-RPC |
| Packaging | Ships ESM, CJS, and TypeScript declarations |

## CLI

```sh
npx userface-engine connect --root src/components
npx userface-engine registry scan src/components
npx userface-engine analyze src/components/Button
npx userface-engine validate src/components/Button --mode fast
npx userface-engine states src/components/Button
npx userface-engine composition-validate dashboard.ui.json --registry-dir src/components
npx userface-engine materialize dashboard.ui.json --framework react
npx userface-engine diff --base old.face.json --head new.face.json
npx userface-engine test --dir src/components
npx userface-engine mcp-serve
```

Output rules:

- machine-readable commands write JSON to stdout
- logs and diagnostics go to stderr
- validation exits non-zero only when the selected `--fail-on` threshold is hit

## SDK

```ts
import { createEngine } from '@userface/engine';

const engine = createEngine({
  React,
  ReactDOMServer,
});

const spec = await engine.analyzeComponent(
  [
    {
      name: 'Button.tsx',
      content: `
        export interface ButtonProps {
          variant?: 'primary' | 'secondary';
          disabled?: boolean;
        }
        export function Button(props: ButtonProps) {
          return <button disabled={props.disabled} />;
        }
      `,
    },
  ],
  { entryPath: 'Button.tsx' },
);

const states = engine.generateStates(spec.props);
```

`entryPath` is required. The engine does not guess the main file when called
through the SDK.

## MCP

Cursor config:

```json
{
  "mcpServers": {
    "userface": {
      "command": "npx",
      "args": ["userface-engine", "mcp-serve"]
    }
  }
}
```

Main tools:

| Tool | Purpose |
| --- | --- |
| `component_list` | List components under a directory |
| `component_analyze` | Extract props/types from one component |
| `component_validate` | Run quality rules and return scores/violations |
| `component_render` | Render a component with props |
| `component_states` | Generate representative visual states |
| `component_test` | Render generated states and report failures |
| `composition_validate` | Validate a `ui@1` document |
| `ui_materialize` | Generate React/Vue/HTML from `ui@1` |
| `component_contract` | Read a face v2 contract |
| `component_composition_guide` | Return composition guidance from face v2 |
| `design_tokens` | Read CSS token metadata when available |
| `pattern_list` / `pattern_get` | Inspect built-in composition patterns |
| `assembly_flow` | Return the recommended UI assembly flow |
| `library_guide` | Read local Face UI operating docs when present |

## `face.json`

A contract describes the public API of one component.

```json
{
  "name": "Button",
  "props": {
    "variant": {
      "type": "enum",
      "options": ["primary", "secondary"],
      "default": "primary"
    },
    "disabled": {
      "type": "boolean",
      "default": false
    },
    "children": {
      "type": "node"
    }
  }
}
```

The registry can combine extracted props with manual contracts. Manual contracts
are still the right answer for complex component APIs.

## `ui@1`

`ui@1` is a declarative composition document.

```json
{
  "version": "ui@1",
  "root": {
    "type": "Panel",
    "props": { "title": "Settings" },
    "children": [
      {
        "type": "Input",
        "props": {
          "label": "Name",
          "value": { "$ref": "user.name" }
        }
      },
      {
        "type": "Button",
        "props": { "type": "submit" },
        "children": ["Save"]
      }
    ]
  }
}
```

Use `composition-validate` before codegen.

## Subpath Exports

```ts
import { createEngine } from '@userface/engine';
import { validateFaceUiDoc, generateReactCode } from '@userface/engine/face-ui';
import { bundleFromVfs } from '@userface/engine/bundler';
import { transpileToIIFE } from '@userface/engine/transpiler';
import { ensureEngineReady } from '@userface/engine/integrations/next/engineController';
```

## Known Limits

- Prop extraction is conservative. Complex inherited React types may need a
  manual `face.json`.
- React is the primary validated runtime path. Vue and Svelte adapters exist,
  but should be treated as less mature.
- Browser runtime files are shipped for host apps that already serve the engine
  browser bundle.
- Library sync/auth commands are intentionally not part of the public CLI path
  in this release.

## License

MIT
