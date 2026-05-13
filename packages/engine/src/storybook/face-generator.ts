/**
 * Generate face.json from Storybook stories.
 *
 * Reads a .stories.tsx file, parses it with the CSF parser,
 * converts argTypes to face.json prop definitions and stories
 * to state presets. Merges with engine-detected props when available.
 *
 * @module
 */

import { parseCsfFile } from './csf-parser.js';
import { convertArgTypesToProps, type FacePropDef } from './argtype-converter.js';
import { convertStoriesToStates, type FaceStatePreset } from './story-converter.js';

// ─── Types ───────────────────────────────────────────────────

export interface GeneratedFaceJson {
  /** Component name (PascalCase) */
  name: string;
  /** face.json format version */
  version: 1;
  /** Prop definitions derived from argTypes + engine inference */
  controls: FacePropDef[];
  /** State presets derived from named story exports */
  states: FaceStatePreset[];
  /** Metadata about the generation source */
  meta: {
    generatedFrom: 'storybook';
    storiesPath: string;
    title?: string;
    componentImportPath: string | null;
  };
}

export interface FaceGeneratorOptions {
  /** Component name override (default: inferred from stories title/file) */
  componentName?: string;
  /** Additional props from engine analysis to merge (engine props fill gaps) */
  engineProps?: Array<{ name: string; type: string; required?: boolean; defaultValue?: any; options?: any[] }>;
  /** If true, engine props override storybook argTypes (default: false, storybook wins) */
  preferEngineProps?: boolean;
}

// ─── Main API ────────────────────────────────────────────────

/**
 * Generate a face.json object from Storybook stories source code.
 *
 * Priority: storybook argTypes > engine inference (unless preferEngineProps).
 * Stories become state presets. Default args become prop defaults.
 */
export function generateFaceFromStories(
  storiesSource: string,
  storiesPath: string,
  options: FaceGeneratorOptions = {},
): GeneratedFaceJson {
  const parsed = parseCsfFile(storiesSource, storiesPath);

  // Derive component name
  const name = options.componentName
    || inferComponentNameFromTitle(parsed.title)
    || inferComponentNameFromPath(storiesPath);

  if (!name) {
    throw new Error(
      `Cannot infer component name from stories file "${storiesPath}". ` +
      `Provide componentName in options or add a "title" to the stories default export.`,
    );
  }

  // Convert argTypes → prop definitions
  const storybookProps = convertArgTypesToProps(parsed.argTypes, parsed.defaultArgs);

  // Convert stories → state presets
  const states = convertStoriesToStates(parsed.stories, parsed.defaultArgs);

  // Merge with engine props if provided
  const controls = mergeProps(storybookProps, options.engineProps || [], options.preferEngineProps ?? false);

  return {
    name,
    version: 1,
    controls,
    states,
    meta: {
      generatedFrom: 'storybook',
      storiesPath,
      title: parsed.title,
      componentImportPath: parsed.componentImportPath,
    },
  };
}

/**
 * Serialize a GeneratedFaceJson to a formatted JSON string suitable
 * for writing to disk as face.json.
 */
export function serializeFaceJson(face: GeneratedFaceJson): string {
  // Clean output: omit empty arrays, null values, meta
  const output: Record<string, any> = {
    name: face.name,
    version: face.version,
  };

  if (face.controls.length > 0) {
    output.controls = face.controls.map(c => {
      const entry: Record<string, any> = {
        name: c.name,
        type: c.type,
      };
      if (c.required) entry.required = true;
      if (c.description) entry.description = c.description;
      if (c.defaultValue !== undefined) entry.default = c.defaultValue;
      if (c.options && c.options.length > 0) entry.options = c.options;
      return entry;
    });
  }

  if (face.states.length > 0) {
    output.states = face.states.map(s => ({
      id: s.id,
      name: s.name,
      props: s.props,
    }));
  }

  return JSON.stringify(output, null, 2) + '\n';
}

// ─── Helpers ─────────────────────────────────────────────────

function inferComponentNameFromTitle(title?: string): string {
  if (!title) return '';
  // "Components/Button" → "Button", "Forms/Input" → "Input"
  const parts = title.split('/');
  return parts[parts.length - 1] || '';
}

function inferComponentNameFromPath(storiesPath: string): string {
  // "src/components/Button.stories.tsx" → "Button"
  const fileName = storiesPath.split('/').pop() || '';
  return fileName
    .replace(/\.stories\.(tsx|jsx|ts|js)$/i, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Merge storybook props with engine-detected props.
 * By default storybook wins (has user-authored types); engine fills gaps.
 */
function mergeProps(
  storybookProps: FacePropDef[],
  engineProps: Array<{ name: string; type: string; required?: boolean; defaultValue?: any; options?: any[] }>,
  preferEngine: boolean,
): FacePropDef[] {
  const byName = new Map<string, FacePropDef>();

  // Add storybook props first
  for (const p of storybookProps) {
    byName.set(p.name, p);
  }

  // Merge engine props
  for (const ep of engineProps) {
    const existing = byName.get(ep.name);
    if (!existing) {
      // Engine found a prop not in storybook argTypes — add it
      byName.set(ep.name, {
        name: ep.name,
        type: ep.type || 'string',
        required: ep.required ?? false,
        defaultValue: ep.defaultValue,
        options: ep.options,
      });
    } else if (preferEngine) {
      // Override with engine version
      byName.set(ep.name, {
        name: ep.name,
        type: ep.type || existing.type,
        required: ep.required ?? existing.required,
        description: existing.description,
        defaultValue: ep.defaultValue ?? existing.defaultValue,
        options: ep.options ?? existing.options,
      });
    }
    // else: storybook version already in place, keep it
  }

  return Array.from(byName.values());
}
