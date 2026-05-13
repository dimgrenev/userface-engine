/**
 * State Matrix — generates all meaningful visual states for a component
 * from its prop definitions and face.json v2 contracts.
 *
 * Strategy: "one-at-a-time" (default)
 *   For each prop with enumerable values, generate a state where only
 *   that prop differs from default. This produces sum(options_per_prop)
 *   states instead of product(options_per_prop).
 *
 * v2 Enhancement:
 *   When a face.json v2 is provided, behavior-driven states are auto-generated
 *   (open/closed for overlays, focused for navigation items, etc.)
 *
 * Public API: generateStates(props, options?)
 */

import type { ComponentProp } from './core-engine';
import type { FaceJsonV2 } from './schemas/face-v2.schema';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StateEntry {
  /** Human-readable state name, e.g. 'variant=accent', 'disabled=true', 'default' */
  name: string;
  /** Full prop set for this state */
  props: Record<string, any>;
  /** Priority: 1 = primary, 2 = combinatorial, 3 = edge case */
  priority?: number;
}

export interface GenerateStatesOptions {
  /** Manually authored states (from face.json `states` field). Merged with defaults. */
  manualStates?: Record<string, Record<string, any>>;
  /** Maximum number of states to return (default 100). Manual states have priority. */
  maxStates?: number;
  /** Generation strategy (default 'one-at-a-time'). */
  strategy?: 'one-at-a-time' | 'cartesian';
  /** face.json v2 data for behavior-driven state generation. */
  faceV2?: FaceJsonV2;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Produce a default value for a prop based on its type. */
function defaultForType(prop: ComponentProp): any {
  if (prop.defaultValue !== undefined && prop.defaultValue !== null) {
    return prop.defaultValue;
  }
  switch (prop.type) {
    case 'string':  return '';
    case 'number':  return 0;
    case 'boolean': return false;
    case 'select':
    case 'enum':
      return (prop.options && prop.options.length > 0) ? prop.options[0] : '';
    case 'array':
      return [];
    case 'object':
      return {};
    case 'node':
    case 'function':
    case 'any':
      return undefined;
    default:
      // Named types (e.g. IconName) or unknown — skip
      return undefined;
  }
}

/** Build a default-state object from all props. */
function buildDefaultState(props: ComponentProp[]): Record<string, any> {
  const state: Record<string, any> = {};
  for (const prop of props) {
    const val = defaultForType(prop);
    if (val !== undefined) {
      state[prop.name] = val;
    }
  }
  return state;
}

/** Canonical JSON key for dedup (sorted keys). */
function stateKey(props: Record<string, any>): string {
  const keys = Object.keys(props).sort();
  return keys.map(k => `${k}=${JSON.stringify(props[k])}`).join('|');
}

// ---------------------------------------------------------------------------
// v2: Behavior-driven state generation
// ---------------------------------------------------------------------------

function generateBehaviorStates(
  face: FaceJsonV2,
  defaultState: Record<string, any>,
): StateEntry[] {
  const states: StateEntry[] = [];
  const b = face.behavior;
  const aria = face.aria;

  // Overlay components: generate open/closed states
  if (b?.focusTrap || b?.scrollLock || aria?.modal) {
    // Has "open" prop → generate open and closed
    if ('open' in defaultState || 'defaultOpen' in defaultState) {
      states.push({
        name: 'Open',
        props: { ...defaultState, open: true },
        priority: 1,
      });
      states.push({
        name: 'Closed',
        props: { ...defaultState, open: false },
        priority: 1,
      });
    }
  }

  // Dismissable overlays: disabled state
  if (b?.dismissOnEscape !== undefined || b?.dismissOnClickOutside !== undefined) {
    if ('disabled' in defaultState) {
      states.push({
        name: 'Disabled',
        props: { ...defaultState, disabled: true },
        priority: 2,
      });
    }
  }

  // Roving focus components: orientation variants
  if (b?.rovingFocus) {
    if ('orientation' in defaultState) {
      states.push({
        name: 'Vertical',
        props: { ...defaultState, orientation: 'vertical' },
        priority: 2,
      });
      states.push({
        name: 'Horizontal',
        props: { ...defaultState, orientation: 'horizontal' },
        priority: 2,
      });
    }
  }

  // Drag-to-dismiss: show handle variant
  if (b?.dragToDismiss && 'open' in defaultState) {
    states.push({
      name: 'Open (Draggable)',
      props: { ...defaultState, open: true },
      priority: 1,
    });
  }

  return states;
}

// ---------------------------------------------------------------------------
// One-at-a-time generation
// ---------------------------------------------------------------------------

function generateOneAtATime(
  props: ComponentProp[],
  defaultState: Record<string, any>,
): StateEntry[] {
  const states: StateEntry[] = [];

  for (const prop of props) {
    if (prop.type === 'boolean') {
      // Two values: true and false. Only generate the one that differs from default.
      const def = defaultState[prop.name];
      if (def !== true) {
        states.push({
          name: `${prop.name}=true`,
          props: { ...defaultState, [prop.name]: true },
        });
      }
      if (def !== false) {
        states.push({
          name: `${prop.name}=false`,
          props: { ...defaultState, [prop.name]: false },
        });
      }
    } else if ((prop.type === 'select' || prop.type === 'enum') && prop.options && prop.options.length > 0) {
      const def = defaultState[prop.name];
      for (const opt of prop.options) {
        if (opt === def) continue; // skip default value
        states.push({
          name: `${prop.name}=${opt}`,
          props: { ...defaultState, [prop.name]: opt },
        });
      }
    }
    // string, number, node, function, named types — skip (can't enumerate)
  }

  return states;
}

// ---------------------------------------------------------------------------
// Cartesian generation (capped, used only when explicitly requested)
// ---------------------------------------------------------------------------

function generateCartesian(
  props: ComponentProp[],
  defaultState: Record<string, any>,
  maxStates: number,
): StateEntry[] {
  // Collect enumerables
  const axes: Array<{ name: string; values: any[] }> = [];
  for (const prop of props) {
    if (prop.type === 'boolean') {
      axes.push({ name: prop.name, values: [true, false] });
    } else if ((prop.type === 'select' || prop.type === 'enum') && prop.options && prop.options.length > 0) {
      axes.push({ name: prop.name, values: prop.options });
    }
  }

  if (axes.length === 0) return [];

  // Total combos check
  let total = 1;
  for (const a of axes) {
    total *= a.values.length;
    if (total > maxStates * 2) break; // early bail
  }

  const states: StateEntry[] = [];
  const indices = new Array(axes.length).fill(0);

  for (let i = 0; i < Math.min(total, maxStates); i++) {
    const override: Record<string, any> = {};
    const parts: string[] = [];
    for (let j = 0; j < axes.length; j++) {
      override[axes[j].name] = axes[j].values[indices[j]];
      parts.push(`${axes[j].name}=${axes[j].values[indices[j]]}`);
    }
    states.push({
      name: parts.join(', '),
      props: { ...defaultState, ...override },
    });

    // Increment indices (odometer style)
    for (let j = axes.length - 1; j >= 0; j--) {
      indices[j]++;
      if (indices[j] < axes[j].values.length) break;
      indices[j] = 0;
    }
  }

  return states;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Generate all meaningful visual states for a component.
 *
 * @param props - Component prop definitions (from ComponentSpec.props)
 * @param options - Optional settings: manual states, max limit, strategy, face.json v2
 * @returns Array of named states, each with a full prop set
 */
export function generateStates(
  props: ComponentProp[],
  options?: GenerateStatesOptions,
): StateEntry[] {
  const maxStates = options?.maxStates ?? 100;
  const strategy = options?.strategy ?? 'one-at-a-time';
  const manualStates = options?.manualStates;
  const faceV2 = options?.faceV2;

  const defaultState = buildDefaultState(props);
  const seen = new Set<string>();
  const result: StateEntry[] = [];

  // Helper: add if not duplicate
  const add = (entry: StateEntry): boolean => {
    const key = stateKey(entry.props);
    if (seen.has(key)) return false;
    seen.add(key);
    result.push(entry);
    return true;
  };

  // 1. Default state always first
  add({ name: 'default', props: { ...defaultState }, priority: 1 });

  // 2. Manual states (high priority, added before auto-gen)
  if (manualStates) {
    for (const [stateName, overrides] of Object.entries(manualStates)) {
      add({ name: stateName, props: { ...defaultState, ...overrides }, priority: 1 });
    }
  }

  // 3. v2 behavior-driven states (P1 priority, after manual)
  if (faceV2) {
    const behaviorStates = generateBehaviorStates(faceV2, defaultState);
    for (const entry of behaviorStates) {
      if (result.length >= maxStates) break;
      add(entry);
    }
  }

  // 4. Auto-generated states (P2)
  const auto = strategy === 'cartesian'
    ? generateCartesian(props, defaultState, maxStates)
    : generateOneAtATime(props, defaultState);

  for (const entry of auto) {
    if (result.length >= maxStates) break;
    add(entry);
  }

  return result.slice(0, maxStates);
}
