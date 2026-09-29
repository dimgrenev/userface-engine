# @userface/engine

Component intelligence for AI-assisted UI work.

Userface Engine turns a component library into machine-readable contracts and
tools. It helps an agent discover components, understand their props, validate
face schema v1 compositions, and generate framework code without guessing component APIs.

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
| Composition | Validates face schema v1 trees, registry boundaries, refs/actions, and built-in patterns |
| Codegen | Generates React, Vue, or HTML from face schema v1 documents |
| Quality rules | Runs the base policy pack for a11y, structure, and contract checks |
| MCP | Exposes engine tools to AI IDEs over stdio JSON-RPC |
| Packaging | Ships ESM, CJS, and TypeScript declarations |

## CLI

```sh
npx userface connect --root src/components
npx userface registry scan src/components
npx userface analyze src/components/Button
npx userface validate src/components/Button --mode fast
npx userface states src/components/Button
npx userface composition-validate dashboard.ui.json --registry-dir src/components
npx userface materialize dashboard.ui.json --framework react
npx userface diff --base old.face.json --head new.face.json
npx userface merge-gate verify userface.merge-gate.json --root .
npx userface test --dir src/components
npx userface mcp-serve
```

`userface-engine` remains available as a backward-compatible alias, but public
docs and generated help should use `userface`.

Output rules:

- machine-readable commands write JSON to stdout
- logs and diagnostics go to stderr
- validation exits non-zero only when the selected `--fail-on` threshold is hit

### Version-bound merge gate

The Userface app exports `userface.merge-gate.json` from the current ChangeSet
review. The public Engine verifies the evidence envelope, subject revision,
review policy and decisions, then hashes every changed file in the CI checkout.
It exits `0` only when that exact checkout is merge eligible.

GitHub Actions:

```yaml
name: Userface merge gate
on: [pull_request]
permissions:
  contents: read
jobs:
  userface-merge-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx --yes @userface/engine@0.1.0 merge-gate verify userface.merge-gate.json --root . --format github
```

GitLab CI:

```yaml
userface_merge_gate:
  image: node:22
  stage: test
  script:
    - npx --yes @userface/engine@0.1.0 merge-gate verify userface.merge-gate.json --root . --format json --output userface-merge-gate-report.json
  artifacts:
    when: always
    paths:
      - userface-merge-gate-report.json
```

Configure the resulting job as a required check. No GitHub or GitLab token is
passed to the desktop app; the CI provider derives pass/fail from the verifier's
process exit code.

For an enterprise review policy, set `requireSignedMergeGate: true` and expose
the organization-pinned Ed25519 public key as a protected CI variable:

```sh
USERFACE_MERGE_GATE_PUBLIC_KEY="$PINNED_PUBLIC_KEY" \
npx --yes @userface/engine@0.1.0 merge-gate verify \
  userface.merge-gate.json \
  --root . \
  --require-signature
```

The verifier then rejects unsigned evidence, unknown keys, and altered
signatures. Keep the private signing key outside the repository.

Hosted provider adapters can verify the same evidence without checking out the
repository. They resolve each reviewed path at the PR base and head commits,
then call the provider-neutral API:

```ts
import {
  verifyUserfaceMergeGateEvidenceAgainstFileStates,
} from '@userface/engine/merge-gate';

const result = verifyUserfaceMergeGateEvidenceAgainstFileStates(evidence, {
  baseFileStates,
  headFileStates,
  requireBaseFileStates: true,
  trustedPublicKeys,
});
```

Each state is `missing`, `file` with its SHA-256/size, `symlink`, `non_regular`,
`too_large`, or `unreadable`. Missing state, wrong hash, unavailable base state,
symlink, oversized file, and non-regular objects fail closed. The Engine does
not perform network requests or receive provider credentials.

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
  { entryPath: 'Button.tsx', exportName: 'Button' },
);

const states = engine.generateStates(spec.props);
const rendered = await engine.renderFromSpec(spec.name, { disabled: true }, 'ssr');
```

`entryPath` is required. In Node, `exportName` selects the exact source export,
including named exports and relative reexports; use `'default'` for a default
export. Its props are analyzed with the existing AST parser. Different exports
have distinct spec IDs and retain their captured input files. Include their
relative dependencies in `files`. Omitted/null `exportName` retains the legacy
spec ID and default selection. Explicit selection never falls back to a neighbour.

SSR returns static `data.html`, without CDN scripts or browser execution of the
server bundle. It uses the supplied framework runtime; unavailable SSR imports
and component errors reject with `UF400`. A successful null component is valid.
The React SSR resolver accepts the injected React and ReactDOMServer APIs, not
arbitrary project packages. For live preview, `'live'` returns `componentCode`
and captured files without executing the component on the server. Its host must
provide the preview runtime and external dependencies before evaluating it.
An SSR failure is not proof that the same component cannot render in a browser.
The synchronous React SSR adapter diagnoses native async roots (including
memo/forwardRef wrappers) before invoking them; use the browser path for these
components. This API does not provide an asynchronous SSR renderer.

## MCP

Cursor config:

```json
{
  "mcpServers": {
    "userface": {
      "command": "npx",
      "args": ["userface", "mcp-serve"]
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
| `composition_validate` | Validate a face schema v1 document |
| `ui_materialize` | Generate React/Vue/HTML from face schema v1 |
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

## Face Schema V1

Face schema v1 is a declarative composition document.

```json
{
  "schema": "face",
  "schema-version": 1,
  "root": {
    "type": "Card",
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
import { discoverSourceComponentExports, discoverStorybookExports } from '@userface/engine/source';
import { AdvancedPropParser } from '@userface/engine/prop-analysis';
import { decodeFaceJsonContract, resolveFaceJsonPreviewProps } from '@userface/engine/face-contract';
import { FaceUi } from '@userface/engine/face-ui/react';
```

`/source` inspects exports with the TypeScript AST without executing project code;
reexport resolution uses a supplied module reader. `/face-contract` preserves the
supported Face props/state semantics without importing Node or React. The narrow
`/face-ui/react` export supplies the ESM renderer for browser preview bundles;
Node build tools may resolve this public entry instead of locating package internals.

`/prop-analysis` provides instance-owned AST metadata analysis, separate from
runtime rendering. Pass the source snapshot and an explicit export:

```ts
const parser = new AdvancedPropParser();
const props = parser.parse('Button.tsx', {
  'Button.tsx': { content: 'export function Button(p: {label:string}) { return null; }' },
}, 'react', 'Button');
parser.dispose();
```

For a catalog, `parser.parseMany([{ fileName: 'Button.tsx', exportName: 'Button' }],
files)` captures the inputs once and reuses the in-memory TypeScript project.
It returns a prop list for each target, in the same order. Updating or removing
a captured type declaration invalidates the corresponding snapshot cache.

Pass `format: 'source' | 'story'` on a batch target when its format is explicit.
Source analysis ignores story annotations even in a `.stories` file; story
analysis works in ordinary filenames and requires an existing named export.
Omitting the format preserves legacy filename inference. Results are cached
separately by format; story literal options retain strings, numbers and booleans.

`generateStates` accepts `StateMatrixProp` inputs whose options can be strings,
numbers or booleans. It preserves those literal values and explicit null defaults;
existing `ComponentProp` inputs with string options remain compatible.

The default filesystem is in memory: omitted imports are not read from the host.
Include imported type declarations in the snapshot. `onDiagnostic` reports
recoverable parser failures; returned metadata and caches are detached between
calls. `root`, `allowFileSystem` and `tsConfigFilePath` explicitly opt a legacy
host into disk-backed analysis. The API never executes the component or turns
metadata defaults into runtime props. It does not change the older
`createEngine().analyzeComponent` contract or promise complete type inference.

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

`@userface/engine/face-ui/model` provides browser-safe document types,
`materializeFaceUiDoc`, and the existing node patch operations (`setNodeProp`,
`unsetNodeProp`, etc.). It does not import filesystem validation or the source
analyzer. Use it for inspectors; the full `/face-ui` entry remains available.
