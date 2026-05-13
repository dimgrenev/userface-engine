/**
 * Component Registry — scans a directory tree, discovers components,
 * reads face.json contracts, and falls back to lightweight regex extraction.
 * Supports mtime-based caching for incremental re-scans.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename, relative } from 'node:path';
import { discoverComponents, findEntryInDir } from './fs-helpers';
import { extractPropsFromCode } from './propParsingHelpers';
const registryCache = new Map();
function getDirMtime(dir) {
    try {
        let maxMtime = 0;
        for (const f of readdirSync(dir)) {
            try {
                const st = statSync(join(dir, f));
                if (st.mtimeMs > maxMtime)
                    maxMtime = st.mtimeMs;
            }
            catch ( /* skip */_a) { /* skip */ }
        }
        return maxMtime;
    }
    catch (_b) {
        return 0;
    }
}
// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------
function detectFramework(entry) {
    if (/\.vue$/.test(entry))
        return 'vue';
    if (/\.svelte$/.test(entry))
        return 'svelte';
    if (/\.(tsx|jsx)$/.test(entry))
        return 'react';
    return 'unknown';
}
// ---------------------------------------------------------------------------
// Face JSON parsing
// ---------------------------------------------------------------------------
const FACE_PATTERNS = (name) => [
    `${name}.json`,
    `${name}.face.json`,
    'face.json',
];
function tryReadFaceJson(dir, componentName) {
    var _a, _b;
    const diagnostics = [];
    for (const pattern of FACE_PATTERNS(componentName)) {
        const fp = join(dir, pattern);
        if (!existsSync(fp))
            continue;
        try {
            const raw = JSON.parse(readFileSync(fp, 'utf-8'));
            const props = [];
            const rawProps = raw.controls || raw.props || [];
            if (Array.isArray(rawProps)) {
                for (const c of rawProps) {
                    if (!c.name)
                        continue;
                    props.push(Object.assign(Object.assign({ name: c.name, type: c.type || 'string', required: (_a = c.required) !== null && _a !== void 0 ? _a : false }, (c.options ? { options: c.options } : {})), (c.defaultValue !== undefined ? { defaultValue: String(c.defaultValue) } : {})));
                }
            }
            else if (rawProps && typeof rawProps === 'object') {
                for (const [propName, def] of Object.entries(rawProps)) {
                    const d = def;
                    props.push(Object.assign(Object.assign({ name: propName, type: d.type || 'string', required: (_b = d.required) !== null && _b !== void 0 ? _b : false }, (d.options ? { options: d.options } : {})), (d.default !== undefined ? { defaultValue: String(d.default) } : d.defaultValue !== undefined ? { defaultValue: String(d.defaultValue) } : {})));
                }
            }
            const states = raw.states || [];
            return { props, statesCount: Array.isArray(states) ? states.length : 0, diagnostics };
        }
        catch (e) {
            diagnostics.push(`Failed to parse ${pattern}: ${e.message}`);
            return { props: [], statesCount: 0, diagnostics };
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Fallback: regex prop extraction
// ---------------------------------------------------------------------------
function fallbackExtractProps(dir, entry) {
    try {
        const code = readFileSync(join(dir, entry), 'utf-8');
        const extracted = extractPropsFromCode(code);
        return extracted.map(p => {
            var _a, _b;
            return (Object.assign(Object.assign({ name: p.name, type: p.type || 'string', required: (_a = p.required) !== null && _a !== void 0 ? _a : false }, (((_b = p.options) === null || _b === void 0 ? void 0 : _b.length) ? { options: p.options } : {})), (p.defaultValue !== undefined ? { defaultValue: String(p.defaultValue) } : {})));
        });
    }
    catch (_a) {
        return [];
    }
}
// ---------------------------------------------------------------------------
// Single component scan
// ---------------------------------------------------------------------------
function scanComponent(dir, root, useCache) {
    const name = basename(dir);
    const entry = findEntryInDir(dir);
    if (!entry)
        return null;
    if (useCache) {
        const mtime = getDirMtime(dir);
        const cached = registryCache.get(dir);
        if (cached && cached.mtime === mtime)
            return cached.data;
    }
    const diagnostics = [];
    const framework = detectFramework(entry);
    let props = [];
    let statesCount = 0;
    let hasFaceJson = false;
    const faceResult = tryReadFaceJson(dir, name);
    if (faceResult) {
        hasFaceJson = true;
        props = faceResult.props;
        statesCount = faceResult.statesCount;
        diagnostics.push(...faceResult.diagnostics);
    }
    else {
        props = fallbackExtractProps(dir, entry);
    }
    const result = {
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
export function scanRegistry(dir, options = {}) {
    const useCache = options.cache !== false;
    const root = resolve(dir);
    const start = performance.now();
    const componentDirs = discoverComponents(root);
    const components = [];
    for (const d of componentDirs) {
        const entry = scanComponent(d, root, useCache);
        if (entry)
            components.push(entry);
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
export function clearRegistryCache() {
    registryCache.clear();
}
