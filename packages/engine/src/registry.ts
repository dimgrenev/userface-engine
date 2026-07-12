/**
 * Component Registry — scans a directory tree, discovers components,
 * reads face.json contracts, and falls back to lightweight regex extraction.
 * Supports mtime-based caching for incremental re-scans.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename, extname, relative } from 'node:path';
import { discoverComponents, findEntriesInDir } from './fs-helpers';
import { extractPropsFromCode } from './propParsingHelpers';
import { safeParseFaceJsonV2 } from './schemas/face-v2.schema';
import { getComponentFaceJsonFileNames } from './faceJsonPaths';

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

function componentNameFromEntry(entry: string, dir?: string): string {
  const name = basename(entry, extname(entry));
  return name.toLowerCase() === 'index' && dir ? basename(dir) : name;
}

function isIndexEntry(entry: string): boolean {
  return basename(entry, extname(entry)).toLowerCase() === 'index';
}

// ---------------------------------------------------------------------------
// Face JSON parsing
// ---------------------------------------------------------------------------

function tryReadFaceJson(dir: string, componentName: string): {
  props: RegistryPropSummary[];
  statesCount: number;
  diagnostics: string[];
} | null {
  const diagnostics: string[] = [];

  for (const pattern of getComponentFaceJsonFileNames(componentName)) {
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

function scanComponentEntry(
  dir: string,
  root: string,
  useCache: boolean,
  entry: string,
  relativePathMode: 'directory' | 'entry',
): RegistryEntry | null {
  const name = componentNameFromEntry(entry, dir);

  if (useCache) {
    const mtime = getDirMtime(dir);
    const cached = registryCache.get(`${dir}::${entry}`);
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
    relativePath: relativePathMode === 'entry'
      ? join(relative(root, dir), entry)
      : relative(root, dir),
    entry,
    framework,
    hasFaceJson,
    props,
    statesCount,
    diagnostics,
  };

  if (useCache) {
    registryCache.set(`${dir}::${entry}`, { mtime: getDirMtime(dir), data: result });
  }

  return result;
}

function scanComponentDir(dir: string, root: string, useCache: boolean): RegistryEntry[] {
  const entries = findEntriesInDir(dir);
  if (entries.length === 0) return [];

  const concreteEntries = entries.filter((entry) => !isIndexEntry(entry));
  const indexEntry = entries.find(isIndexEntry);
  if (concreteEntries.length === 0 && indexEntry) {
    const component = scanComponentEntry(dir, root, useCache, indexEntry, 'directory');
    return component ? [component] : [];
  }
  const exactEntry = concreteEntries.find((entry) => componentNameFromEntry(entry, dir) === basename(dir));
  if (exactEntry && concreteEntries.length === 1) {
    const component = scanComponentEntry(dir, root, useCache, exactEntry, 'directory');
    return component ? [component] : [];
  }

  return concreteEntries
    .map((entry) => scanComponentEntry(dir, root, useCache, entry, concreteEntries.length === 1 ? 'directory' : 'entry'))
    .filter((entry): entry is RegistryEntry => Boolean(entry));
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

  for (const entry of findEntriesInDir(root).filter((candidate) => !isIndexEntry(candidate))) {
    const component = scanComponentEntry(root, root, useCache, entry, 'entry');
    if (component) components.push(component);
  }

  for (const d of componentDirs) {
    components.push(...scanComponentDir(d, root, useCache));
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
