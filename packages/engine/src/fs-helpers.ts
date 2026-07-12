/**
 * Shared file-reading utilities for CLI and MCP server.
 * Node.js only — not used in browser bundles.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';

const COMPONENT_EXTS = /\.(tsx|jsx|vue|svelte)$/;
const ALL_SOURCE_EXTS = /\.(tsx?|jsx?|css|scss|sass|vue|svelte)$/;
const IGNORED_DISCOVERY_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.userface',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'test',
  'tests',
  'fixtures',
  'examples',
]);

function isTestLikeSource(fileName: string): boolean {
  return /\.(test|spec|stories|story)\.(tsx|jsx|vue|svelte)$/.test(fileName);
}

function isComponentSidecarSource(fileName: string): boolean {
  const stem = fileName.replace(COMPONENT_EXTS, '');
  return /\.(props|context|types?)$/i.test(stem)
    || /(?:Utils?|Utilities|Helpers?)$/i.test(stem)
    || /^types?$/i.test(stem);
}

function isComponentEntryCandidate(fileName: string): boolean {
  return COMPONENT_EXTS.test(fileName)
    && !isTestLikeSource(fileName)
    && !isComponentSidecarSource(fileName);
}

export interface ComponentFiles {
  files: Array<{ name: string; content: string }>;
  entry: string;
}

export interface DiscoverComponentsOptions {
  /** Traverse nested directories. Default: false */
  recursive?: boolean;
  /** Maximum depth below the scan root. Direct children are depth 1. Default: 8 */
  maxDepth?: number;
}

export function findEntriesInDir(dir: string): string[] {
  return readdirSync(dir).filter(isComponentEntryCandidate);
}

/**
 * Find the most likely entry file inside a component directory.
 * Priority: file whose name matches the directory name > first .tsx > first .jsx > first .vue/.svelte
 */
export function findEntryInDir(dir: string): string {
  const dirName = basename(dir);
  const candidates = findEntriesInDir(dir);

  if (candidates.length === 0) return '';

  // Exact match: Button/Button.tsx
  const exact = candidates.find(f => {
    const nameWithoutExt = f.replace(extname(f), '');
    return nameWithoutExt === dirName;
  });
  if (exact) return exact;

  // Fallback: prefer .tsx > .jsx > .vue > .svelte
  const priority = ['.tsx', '.jsx', '.vue', '.svelte'];
  for (const ext of priority) {
    const match = candidates.find(f => f.endsWith(ext));
    if (match) return match;
  }

  return candidates[0];
}

/**
 * Read all source files from a component directory or a single file's parent directory.
 * Returns { files, entry } where entry is the detected entry-point filename.
 */
export function readComponentFiles(cwd: string, inputPath: string): ComponentFiles {
  const abs = resolve(cwd, inputPath);
  let dir: string;
  let entry: string;

  try {
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      dir = abs;
      entry = findEntryInDir(dir);
    } else {
      dir = resolve(abs, '..');
      entry = basename(abs);
    }
  } catch {
    throw new Error(`Path not found: ${abs}`);
  }

  if (!entry) {
    throw new Error(`No component entry file found in ${dir}`);
  }

  const files = readdirSync(dir)
    .filter(f => ALL_SOURCE_EXTS.test(f))
    .filter(f => {
      try { return statSync(join(dir, f)).isFile(); } catch { return false; }
    })
    .map(f => ({
      name: f,
      content: readFileSync(join(dir, f), 'utf-8'),
    }));

  return { files, entry };
}

/**
 * Discover component directories inside a given root.
 * A directory is considered a component if it contains at least one .tsx/.jsx/.vue/.svelte file.
 */
export function discoverComponents(dir: string, options: DiscoverComponentsOptions = {}): string[] {
  const absDir = resolve(dir);
  const recursive = options.recursive === true;
  const maxDepth = Math.max(1, options.maxDepth ?? 8);
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    throw new Error(`Cannot read directory: ${absDir}`);
  }

  const components: string[] = [];

  const visit = (currentDir: string, depth: number) => {
    let childNames: string[];
    try {
      childNames = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const childName of childNames) {
      const child = join(currentDir, childName);
      let isDirectory = false;
      try {
        isDirectory = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (!isDirectory) continue;
      if (IGNORED_DISCOVERY_DIRS.has(childName)) continue;

      try {
        if (readdirSync(child).some(isComponentEntryCandidate)) {
          components.push(child);
        }
      } catch {
        // skip unreadable directories
      }

      if (recursive && depth < maxDepth) {
        visit(child, depth + 1);
      }
    }
  };

  if (recursive) {
    visit(absDir, 1);
    return components;
  }

  return entries
    .map(d => join(absDir, d))
    .filter(d => {
      try { return statSync(d).isDirectory(); } catch { return false; }
    })
    .filter(d => !IGNORED_DISCOVERY_DIRS.has(basename(d)))
    .filter(d => {
      try {
        return readdirSync(d).some(isComponentEntryCandidate);
      } catch {
        return false;
      }
    });
}
