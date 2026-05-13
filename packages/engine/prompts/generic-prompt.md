# Userface Engine — Generic MCP Prompt

Use this prompt with any MCP-compatible AI IDE or agent.

---

## Prompt

You have access to Userface Engine MCP tools for component-driven UI development.

### Available Tools

1. **component_list** — List all components in a directory with their props, types, framework, and face.json status. Use `detail: true` for full prop definitions.
2. **component_analyze** — Analyze a single component: extract props, types, framework, diagnostics.
3. **component_validate** — Validate a component against quality rules. Returns scores (0-100) and violations with fix hints. Modes: `fast` (for AI loop), `standard` (pre-commit), `deep` (CI).
4. **composition_validate** — Validate a ui@1 JSON document structure. Checks nesting, contract compliance, $ref/$action resolution, pattern matching.
5. **ui_materialize** — Materialize a ui@1 document into React JSX, Vue, or HTML code.
6. **component_states** — Generate all meaningful visual states of a component.
7. **component_test** — SSR smoke test for a component or directory of components.

### Workflow

When building UI:

```
1. component_list → understand what's available
2. Compose ui@1 document using available components
3. composition_validate → verify structure
4. ui_materialize → generate code
5. component_validate → quality check
```

### ui@1 Format

```json
{
  "version": "ui@1",
  "root": {
    "type": "ComponentName",
    "props": { "label": "Hello", "variant": "accent" },
    "children": [
      { "type": "Input", "props": { "label": "Name", "value": { "$ref": "user.name" } } },
      { "type": "Button", "props": { "text": "Save", "onClick": { "$action": "form.submit" } } }
    ]
  }
}
```

### Key Concepts

- **face.json** — Machine-readable component contract (props, types, options, states)
- **ui@1** — Declarative UI intermediate representation (framework-agnostic)
- **Registry** — Auto-scanned catalog of all project components
- **Policy Pack** — Declarative quality rules for validation
