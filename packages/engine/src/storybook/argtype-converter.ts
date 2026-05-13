/**
 * Convert Storybook argTypes to face.json prop definitions.
 */

import type { CsfArgType } from './csf-parser.js';

// ─── Types ───────────────────────────────────────────────────

export interface FacePropDef {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  options?: unknown[];
}

// ─── Control → type mapping ──────────────────────────────────

const CONTROL_TYPE_MAP: Record<string, string> = {
  select: 'enum',
  'inline-radio': 'enum',
  radio: 'enum',
  check: 'enum',
  'inline-check': 'enum',
  'multi-select': 'enum',
  boolean: 'boolean',
  text: 'string',
  number: 'number',
  range: 'number',
  color: 'string',
  date: 'string',
  object: 'object',
  file: 'string',
};

// ─── Main API ────────────────────────────────────────────────

/**
 * Convert Storybook argTypes + default args into an array of face.json
 * prop definitions.
 */
export function convertArgTypesToProps(
  argTypes: Record<string, CsfArgType>,
  defaultArgs: Record<string, unknown> = {},
): FacePropDef[] {
  const props: FacePropDef[] = [];

  for (const [name, argType] of Object.entries(argTypes)) {
    const type = resolveType(argType);
    const defaultValue =
      argType.defaultValue !== undefined
        ? argType.defaultValue
        : defaultArgs[name] !== undefined
          ? defaultArgs[name]
          : undefined;

    const prop: FacePropDef = {
      name,
      type,
      required: defaultValue === undefined,
    };

    if (argType.description) prop.description = argType.description;
    if (defaultValue !== undefined) prop.defaultValue = defaultValue;
    if (argType.options && argType.options.length > 0)
      prop.options = argType.options;

    props.push(prop);
  }

  // Also include any defaultArgs keys not in argTypes
  for (const [name, value] of Object.entries(defaultArgs)) {
    if (argTypes[name]) continue; // already handled

    const prop: FacePropDef = {
      name,
      type: inferTypeFromValue(value),
      required: false,
      defaultValue: value,
    };

    props.push(prop);
  }

  return props;
}

// ─── Helpers ─────────────────────────────────────────────────

function resolveType(argType: CsfArgType): string {
  if (argType.control) {
    const mapped = CONTROL_TYPE_MAP[argType.control];
    if (mapped) return mapped;
  }

  // If options are present, it's an enum
  if (argType.options && argType.options.length > 0) return 'enum';

  // Infer from defaultValue
  if (argType.defaultValue !== undefined) {
    return inferTypeFromValue(argType.defaultValue);
  }

  return 'string'; // safe default
}

function inferTypeFromValue(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'object';
  return 'string';
}
