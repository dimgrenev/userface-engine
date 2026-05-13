# FaceUI Assembly Flow

> The step-by-step pipeline for building UI with FaceUI components.

## Pipeline

### 1. Intent → Pattern
- Understand what is being built (form? dashboard? settings page?)
- Select a matching pattern via `pattern_list` / `pattern_get`
- If no pattern matches, use freeform composition with structural rules
- Read the constitution via `library_guide` (section="constitution") for core rules

### 2. Pattern → Skeleton
- Use the pattern's `skeleton` field as a starting point
- Customize: swap components, add/remove sections, adjust props
- Respect pattern `zones` (required zones must be filled)
- Respect pattern `requires` (minimum components) and `forbids` (structural constraints)

### 3. Skeleton → Components
- For each component in the skeleton, read its contract (`component_contract`)
- Set props according to contract defaults and requirements
- Use only valid enum values from the contract
- Follow `usage.whenToUse` / `usage.whenNotToUse` to pick the right component
- Check `usage.alternatives` when unsure which component fits

### 4. Components → Validate
- Run `composition_validate` with the pattern name to check structural compliance
- Run `component_validate` on individual components for contract/a11y checks
- Fix all severity=error violations first
- Address severity=warning violations (target score ≥ 90)
- Re-validate after changes

### 5. Validate → Render
- Materialize via `ui_materialize` or manual code
- Run `component_test` for visual state coverage
- Verify responsive behavior (surface="auto" where applicable)

## Quality Gates

| Gate | Requirement |
|------|-------------|
| No errors | Zero severity=error violations |
| Score | Overall score ≥ 90 |
| Pattern zones | All required pattern zones present |
| A11y | No interactive-in-interactive nesting |
| Contracts | All required props set per contract |
| CTA | At most one accent/primary CTA per action group |
| Text | All visible text through `<Text>` component |
| Spacing | No raw margin/padding — use membrane + container gap |

## Anti-Patterns

| Anti-Pattern | Why it's bad | Fix |
|---|---|---|
| Multiple primary CTAs | Confuses user's attention, no clear next action | Keep one accent Button per action group |
| Interactive in interactive | Breaks screen reader navigation | Move inner interactive outside outer |
| Deep nesting (>6 levels) | Unmaintainable, extract subtree | Split into sub-components |
| Separator overuse | Visual noise, use spacing instead | Replace with gap/margin |
| Card in Card | Unclear visual hierarchy | Flatten to single Card or use sections |
| Bare text nodes | Breaks typography system | Wrap all text in `<Text>` |

## MCP Tools by Step

| Step | Tools |
|------|-------|
| 1. Intent | `pattern_list`, `library_guide` |
| 2. Skeleton | `pattern_get` |
| 3. Components | `component_contract`, `component_composition_guide`, `design_tokens` |
| 4. Validate | `composition_validate`, `component_validate` |
| 5. Render | `ui_materialize`, `component_render`, `component_test` |
