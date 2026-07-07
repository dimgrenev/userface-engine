---
description: Userface Engine — UI component workflow for AI agents
globs: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte"]
---

# Userface Engine — Component Workflow

You have access to Userface Engine MCP tools for building and validating UI.

## When building or modifying UI

1. **ALWAYS** call `component_list` first to see available components with their props and contracts
2. Use face.json contracts as the source of truth for component APIs — never invent props
3. Compose UI using **face schema v1** format when building screens or pages
4. Call `composition_validate` to check structural correctness before materializing
5. Call `ui_materialize` to generate framework code from face schema v1
6. Call `component_validate` before committing changes to verify quality

## Rules

- Never invent component props — check `component_list` or `component_analyze` first
- Prefer composition from existing components over creating new ones
- Always validate before finalizing UI changes
- Use `component_states` to understand all visual states before modifying a component
- When adding a new component, generate a `face.json` contract for it

## Available MCP Tools

| Tool | Use when... |
|------|------------|
| `component_list` | You need to see what components exist and their APIs |
| `component_analyze` | You need detailed prop analysis for a specific component |
| `component_validate` | You want to check component quality (a11y, structure, contracts) |
| `composition_validate` | You built a face schema v1 composition and want to verify it |
| `ui_materialize` | You have a face schema v1 document and want React/Vue/HTML code |
| `component_states` | You need to see all visual states of a component |
| `component_test` | You want to run SSR smoke tests on components |

## Workflow Example

```
User: "Build a settings page"
1. component_list({ dir: "src/components" })  → see available components
2. Compose a face schema v1 document using those components
3. composition_validate({ doc, registryDir: "src/components", patterns: ["settings"] })
4. ui_materialize({ doc, framework: "react" })  → get JSX code
5. component_validate each modified component
```
