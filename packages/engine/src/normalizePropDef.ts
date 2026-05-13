/**
 * Canonical prop normalization — converts any extractor output to ComponentProp.
 *
 * All extractors (PropExtractor, CoreEngine, tsPropExtractor, advancedPropParser)
 * produce slightly different shapes. This function normalizes them to a single
 * canonical ComponentProp format.
 */

import type { ComponentProp } from './core-engine';

/**
 * Loose input shape accepted by normalizer.
 * Covers all known extractor output formats.
 */
interface RawPropInput {
  name: string;
  type?: string;
  required?: boolean;
  optional?: boolean;
  description?: string;
  defaultValue?: any;
  options?: string[];
  enumValues?: string[];
  fields?: RawPropInput[];
  controlType?: string;
  isInherited?: boolean;
}

/**
 * Normalize a single raw prop definition to the canonical ComponentProp format.
 */
export function normalizePropDef(raw: RawPropInput): ComponentProp {
  const name = String(raw.name || '').trim();
  const type = normalizeType(raw);
  const required = raw.required === true || (raw.optional === false);
  const description = String(raw.description || '');

  const prop: ComponentProp = { name, type, required, description };

  // Default value
  if (raw.defaultValue !== undefined && raw.defaultValue !== null) {
    prop.defaultValue = raw.defaultValue;
  }

  // Options (select type)
  if (raw.options && Array.isArray(raw.options) && raw.options.length > 0) {
    prop.options = raw.options.map(String);
  }

  // Enum values
  if (raw.enumValues && Array.isArray(raw.enumValues) && raw.enumValues.length > 0) {
    prop.enumValues = raw.enumValues.map(String);
  }

  // Nested fields (object types)
  if (raw.fields && Array.isArray(raw.fields) && raw.fields.length > 0) {
    prop.fields = raw.fields.map(normalizePropDef);
  }

  return prop;
}

/**
 * Normalize a batch of props and deduplicate by name.
 * Later entries with the same name are merged (options and defaults preserved).
 */
export function normalizeAndDedup(rawProps: RawPropInput[]): ComponentProp[] {
  const seen = new Map<string, ComponentProp>();

  for (const raw of rawProps) {
    const normalized = normalizePropDef(raw);
    if (!normalized.name) continue;

    const existing = seen.get(normalized.name);
    if (existing) {
      // Merge: prefer options from richer source
      if (normalized.options && !existing.options) existing.options = normalized.options;
      if (normalized.type === 'select' && existing.type !== 'select') existing.type = 'select';
      if (existing.defaultValue === undefined && normalized.defaultValue !== undefined) {
        existing.defaultValue = normalized.defaultValue;
      }
      if (!existing.description && normalized.description) {
        existing.description = normalized.description;
      }
    } else {
      seen.set(normalized.name, normalized);
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function normalizeType(raw: RawPropInput): string {
  const t = String(raw.type || raw.controlType || 'any').trim().toLowerCase();

  // If options are present, it's a select
  if (raw.options && raw.options.length > 0) return 'select';

  // Map common aliases
  switch (t) {
    case 'string': return 'string';
    case 'number': case 'integer': case 'float': return 'number';
    case 'boolean': case 'bool': return 'boolean';
    case 'select': case 'enum': return 'select';
    case 'node': case 'reactnode': case 'react.reactnode': case 'jsx.element': return 'node';
    case 'function': case 'callback': case '(...args: any[]) => any': return 'function';
    case 'array': return 'array';
    case 'object': return 'object';
    case 'any': case 'unknown': return 'any';
    default:
      // Preserve original type if it's a named type (e.g. IconName)
      return raw.type || 'any';
  }
}
