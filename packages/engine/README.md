# @userface/engine

AI-native UI infrastructure: give your AI agent real component contracts so it stops hallucinating props.

## The problem

You ask an AI agent to "build a settings page." It invents prop names, nests interactive elements inside each other, ignores your design system. You spend more time fixing than you'd spend writing from scratch.

## What this does

Userface Engine sits between AI code generation and your UI components. Instead of guessing, the agent uses real contracts.

- **Registry** — scans your project, discovers components, reads `face.json` contracts
- **Validation** — 15 rules checking a11y, structure, and contract compliance (0-100 score)
- **Composition** — validates `ui@1` documents (nesting, required props, unknown types)
- **Codegen** — materializes `ui@1` into React JSX, Vue SFC, or HTML
- **Contract Diffs** — detects breaking changes between `face.json` versions
- **MCP Server** — 8 tools exposed via Model Context Protocol for AI-IDE integration
- **State Matrix** — generates all meaningful visual states for a component

## Quick Start

```bash
# Install
npm install @userface/engine

# Set up your project (auto-detect framework, generate configs)
npx userface connect

# Or just start the MCP server directly
npx userface-engine mcp-serve
```

After setup, restart your AI-IDE. The agent discovers your components through MCP.

## CLI

```bash
# Scan all components → registry with props
npx userface-engine registry scan ./src/components

# Validate quality (score + violations + fix hints)
npx userface-engine validate ./src/components/Button --mode fast

# Validate ui@1 composition structure
npx userface-engine composition-validate dashboard.ui.json

# Generate React JSX from ui@1
npx userface-engine materialize settings.ui.json --framework react

# Detect breaking changes in contracts
npx userface-engine diff --base v1/face.json --head v2/face.json

# Analyze a single component
npx userface-engine analyze ./src/components/Button

# Generate visual states
npx userface-engine states ./src/components/Button

# SSR smoke test + a11y audit
npx userface-engine test --dir ./src/components

# Start MCP server for AI-IDE
npx userface-engine mcp-serve
```

All commands output JSON to stdout. Logs go to stderr.

## MCP Tools

8 tools via Model Context Protocol (JSON-RPC 2.0 over stdin/stdout):

| Tool | What it does |
|------|-------------|
| `component_list` | List all components with props, types, and metadata |
| `component_analyze` | Deep analysis of a single component |
| `component_validate` | Quality gate: score + violations + fix hints |
| `composition_validate` | Validate ui@1 document structure and contracts |
| `ui_materialize` | Generate React/Vue/HTML from ui@1 |
| `component_states` | Generate all visual states for a component |
| `component_test` | SSR smoke test + a11y audit |
| `component_render` | Render with specific props |

### Cursor Setup

Add to `.cursor/mcp.json`:

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

## face.json — Component Contracts

A machine-readable description of what a component accepts:

```json
{
  "name": "Button",
  "props": {
    "variant": {
      "type": "enum",
      "options": ["default", "destructive", "outline", "ghost"],
      "default": "default"
    },
    "size": {
      "type": "enum",
      "options": ["default", "sm", "lg", "icon"],
      "default": "default"
    },
    "disabled": { "type": "boolean", "default": false },
    "children": { "type": "node", "required": true }
  }
}
```

The registry reads these contracts and exposes them to the AI agent. No more guessing.

## ui@1 — Declarative Composition

```json
{
  "version": "ui@1",
  "root": {
    "type": "Panel",
    "props": { "title": "Settings" },
    "children": [
      { "type": "Input", "props": { "label": "Name", "value": { "$ref": "user.name" } } },
      { "type": "Button", "props": { "type": "submit" }, "children": ["Save"] }
    ]
  }
}
```

`materialize` turns this into real React JSX. `composition-validate` checks it against your registry.

## Included Packs

### Recipe Packs
5 B2B ui@1 templates: Dashboard, CRUD Table, Form, Settings, List-Detail.

### Base Policy Pack
15 rules: a11y (button-type, input-label, img-alt), structural (modal-onclose, no-nested-interactive), contract (no-props, excessive-props, select-options).

### System Prompts
AI-IDE instructions: `prompts/cursor-rules.md`, `prompts/claude-prompt.md`, `prompts/generic-prompt.md`.

## Known Limitations

- **Prop extraction**: The regex extractor returns 0 props for complex patterns (forwardRef + ComponentPropsWithoutRef). Write `face.json` manually or use the ts-morph extractor on the server.
- **SSR test**: Returns empty results for components without extractable props (use face.json).
- **Framework support**: React is primary. Vue and Svelte SSR adapters exist but are less tested.

## GitHub Action

```yaml
  with:
    components-dir: src/components
    fail-on: error
```

## License

MIT
