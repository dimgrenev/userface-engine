/**
 * Component Registry — scans a directory tree, discovers components,
 * reads face.json contracts, and falls back to lightweight regex extraction.
 * Supports mtime-based caching for incremental re-scans.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename, relative } from 'node:path';
import { discoverComponents, findEntryInDir } from './fs-helpers';
import { extractPropsFromCode } from './propParsingHelpers';
import { safeParseFaceJsonV2 } from './schemas/face-v2.schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryPropSummary {
  name: string;
  type: string;
  required: boolean;
  options?: string[];
  defaultValue?: string;
}

export interface RegistryEntry {
  name: string;
  /** Absolute path to the component directory */
  path: string;
  /** Relative path from scan root */
  relativePath: string;
  /** Entry file name (e.g. "Button.tsx") */
  entry: string;
  /** Detected framework */
  framework: 'react' | 'vue' | 'svelte' | 'unknown';
  /** Whether a face.json was found */
  hasFaceJson: boolean;
  /** Extracted props summary */
  props: RegistryPropSummary[];
  /** Number of states defined in face.json (0 if no face.json) */
  statesCount: number;
  /** Diagnostics/warnings encountered during scan */
  diagnostics: string[];
}

export interface RegistryIndex {
  /** Absolute path to scan root */
  root: string;
  /** Scan timestamp (ISO) */
  scannedAt: string;
  /** Duration in ms */
  durationMs: number;
  /** All discovered components */
  components: RegistryEntry[];
}

export interface ScanOptions {
  /** Use mtime cache for incremental scan. Default: true */
  cache?: boolean;
  /** Traverse nested component directories. Default: false */
  recursive?: boolean;
  /** Maximum depth below the scan root when recursive is enabled. Direct children are depth 1. Default: 8 */
  maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Internal cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtime: number;
  data: RegistryEntry;
}

const registryCache = new Map<string, CacheEntry>();

function getDirMtime(dir: string): number {
  try {
    let maxMtime = 0;
    for (const f of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, f));
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      } catch { /* skip */ }
    }
    return maxMtime;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

function detectFramework(entry: string): RegistryEntry['framework'] {
  if (/\.vue$/.test(entry)) return 'vue';
  if (/\.svelte$/.test(entry)) return 'svelte';
  if (/\.(tsx|jsx)$/.test(entry)) return 'react';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Face JSON parsing
// ---------------------------------------------------------------------------

const FACE_PATTERNS = (name: string) => [
  `${name}.json`,
  `${name}.face.json`,
  'face.json',
];

function tryReadFaceJson(dir: string, componentName: string): {
  props: RegistryPropSummary[];
  statesCount: number;
  diagnostics: string[];
} | null {
  const diagnostics: string[] = [];

  for (const pattern of FACE_PATTERNS(componentName)) {
    const fp = join(dir, pattern);
    if (!existsSync(fp)) continue;

    try {
      const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
      // Validate through v2 schema (v2 fields are optional, so v1-only files pass)
      const v2Result = safeParseFaceJsonV2(parsed);
      const raw = v2Result.success ? v2Result.data : parsed;

      const props: RegistryPropSummary[] = [];
      const legacyControls = parsed && typeof parsed === 'object' && Array.isArray(parsed.controls)
        ? parsed.controls
        : undefined;
      const rawProps = legacyControls || raw.controls || raw.props || [];

      if (Array.isArray(rawProps)) {
        for (const c of rawProps) {
          if (!c.name) continue;
          const options = normalizeRegistryOptions(c.options);
          props.push({
            name: c.name,
            type: c.type || 'string',
            required: c.required ?? false,
            ...(options ? { options } : {}),
            ...(c.defaultValue !== undefined ? { defaultValue: String(c.defaultValue) } : {}),
          });
        }
      } else if (rawProps && typeof rawProps === 'object') {
        for (const [propName, def] of Object.entries(rawProps)) {
          const d = def as Record<string, any>;
          const options = normalizeRegistryOptions(d.options);
          props.push({
            name: propName,
            type: d.type || 'string',
            required: d.required ?? false,
            ...(options ? { options } : {}),
            ...(d.default !== undefined ? { defaultValue: String(d.default) } : d.defaultValue !== undefined ? { defaultValue: String(d.defaultValue) } : {}),
          });
        }
      }

      const states = raw.states || [];
      return { props, statesCount: Array.isArray(states) ? states.length : 0, diagnostics };
    } catch (e) {
      diagnostics.push(`Failed to parse ${pattern}: ${(e as Error).message}`);
      return { props: [], statesCount: 0, diagnostics };
    }
  }

  return null;
}

function normalizeRegistryOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  return options.map(String);
}

// ---------------------------------------------------------------------------
// Fallback: regex prop extraction
// ---------------------------------------------------------------------------

function fallbackExtractProps(dir: string, entry: string): RegistryPropSummary[] {
  try {
    const code = readFileSync(join(dir, entry), 'utf-8');
    const extracted = extractPropsFromCode(code);
    return extracted.map(p => ({
      name: p.name,
      type: p.type || 'string',
      required: p.required ?? false,
      ...(p.options?.length ? { options: p.options } : {}),
      ...(p.defaultValue !== undefined ? { defaultValue: String(p.defaultValue) } : {}),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Single component scan
// ---------------------------------------------------------------------------

function scanComponent(dir: string, root: string, useCache: boolean): RegistryEntry | null {
  const name = basename(dir);
  const entry = findEntryInDir(dir);
  if (!entry) return null;

  if (useCache) {
    const mtime = getDirMtime(dir);
    const cached = registryCache.get(dir);
    if (cached && cached.mtime === mtime) return cached.data;
  }

  const diagnostics: string[] = [];
  const framework = detectFramework(entry);

  let props: RegistryPropSummary[] = [];
  let statesCount = 0;
  let hasFaceJson = false;

  const faceResult = tryReadFaceJson(dir, name);
  if (faceResult) {
    hasFaceJson = true;
    props = faceResult.props;
    statesCount = faceResult.statesCount;
    diagnostics.push(...faceResult.diagnostics);
  } else {
    props = fallbackExtractProps(dir, entry);
  }

  const result: RegistryEntry = {
    name,
    path: dir,
    relativePath: relative(root, dir),
    entry,
    framework,
    hasFaceJson,
    props,
    statesCount,
    diagnostics,
  };

  if (useCache) {
    registryCache.set(dir, { mtime: getDirMtime(dir), data: result });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a directory for components, returning a registry index.
 * Uses mtime-based caching by default for fast incremental re-scans.
 */
export function scanRegistry(dir: string, options: ScanOptions = {}): RegistryIndex {
  const useCache = options.cache !== false;
  const root = resolve(dir);
  const start = performance.now();

  const componentDirs = discoverComponents(root, {
    recursive: options.recursive === true,
    maxDepth: options.maxDepth,
  });
  const components: RegistryEntry[] = [];

  for (const d of componentDirs) {
    const entry = scanComponent(d, root, useCache);
    if (entry) components.push(entry);
  }

  components.sort((a, b) => a.name.localeCompare(b.name));

  return {
    root,
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - start),
    components,
  };
}

/** Clear the internal registry cache */
export function clearRegistryCache(): void {
  registryCache.clear();
}
