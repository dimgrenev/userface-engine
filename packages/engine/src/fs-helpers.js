/**
 * Shared file-reading utilities for CLI and MCP server.
 * Node.js only — not used in browser bundles.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';
const COMPONENT_EXTS = /\.(tsx|jsx|vue|svelte)$/;
const ALL_SOURCE_EXTS = /\.(tsx?|jsx?|css|scss|sass|vue|svelte)$/;
/**
 * Find the most likely entry file inside a component directory.
 * Priority: file whose name matches the directory name > first .tsx > first .jsx > first .vue/.svelte
 */
export function findEntryInDir(dir) {
    const dirName = basename(dir);
    const candidates = readdirSync(dir).filter(f => COMPONENT_EXTS.test(f));
    if (candidates.length === 0)
        return '';
    // Exact match: Button/Button.tsx
    const exact = candidates.find(f => {
        const nameWithoutExt = f.replace(extname(f), '');
        return nameWithoutExt === dirName;
    });
    if (exact)
        return exact;
    // Fallback: prefer .tsx > .jsx > .vue > .svelte
    const priority = ['.tsx', '.jsx', '.vue', '.svelte'];
    for (const ext of priority) {
        const match = candidates.find(f => f.endsWith(ext));
        if (match)
            return match;
    }
    return candidates[0];
}
/**
 * Read all source files from a component directory or a single file's parent directory.
 * Returns { files, entry } where entry is the detected entry-point filename.
 */
export function readComponentFiles(cwd, inputPath) {
    const abs = resolve(cwd, inputPath);
    let dir;
    let entry;
    try {
        const stat = statSync(abs);
        if (stat.isDirectory()) {
            dir = abs;
            entry = findEntryInDir(dir);
        }
        else {
            dir = resolve(abs, '..');
            entry = basename(abs);
        }
    }
    catch (_a) {
        throw new Error(`Path not found: ${abs}`);
    }
    if (!entry) {
        throw new Error(`No component entry file found in ${dir}`);
    }
    const files = readdirSync(dir)
        .filter(f => ALL_SOURCE_EXTS.test(f))
        .filter(f => {
        try {
            return statSync(join(dir, f)).isFile();
        }
        catch (_a) {
            return false;
        }
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
export function discoverComponents(dir) {
    const absDir = resolve(dir);
    let entries;
    try {
        entries = readdirSync(absDir);
    }
    catch (_a) {
        throw new Error(`Cannot read directory: ${absDir}`);
    }
    return entries
        .map(d => join(absDir, d))
        .filter(d => {
        try {
            return statSync(d).isDirectory();
        }
        catch (_a) {
            return false;
        }
    })
        .filter(d => {
        try {
            return readdirSync(d).some(f => COMPONENT_EXTS.test(f));
        }
        catch (_a) {
            return false;
        }
    });
}
