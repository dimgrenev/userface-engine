/**
 * Convert parsed Storybook stories to face.json state presets.
 */

import type { CsfStory } from './csf-parser.js';
import { storyNameToDisplayName } from './csf-parser.js';

// ─── Types ───────────────────────────────────────────────────

export interface FaceStatePreset {
  id: string;
  name: string;
  props: Record<string, unknown>;
  source: 'storybook';
}

// ─── Main API ────────────────────────────────────────────────

/**
 * Convert an array of parsed CSF stories into face.json state presets.
 * Each story becomes a preset with merged args (default + story-specific).
 */
export function convertStoriesToStates(
  stories: CsfStory[],
  defaultArgs: Record<string, unknown> = {},
): FaceStatePreset[] {
  return stories.map((story) => ({
    id: toKebabCase(story.name),
    name: storyNameToDisplayName(story.name),
    props: { ...defaultArgs, ...story.args },
    source: 'storybook' as const,
  }));
}

// ─── Helpers ─────────────────────────────────────────────────

/** Convert PascalCase/camelCase to kebab-case */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
