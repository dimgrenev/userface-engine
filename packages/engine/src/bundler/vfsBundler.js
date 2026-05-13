// Source of truth: VFS bundler used by the browser engine.
// This file is intentionally framework-agnostic and does not depend on Next.js.
//
// NOTE: `transpileBundleWithBabel` resolves Babel standalone from browser (`window.Babel`)
// and from generic runtimes (`globalThis.Babel`) to keep npm/Node usage deterministic.
function hasTypeScriptSyntax(src) {
    try {
        const s = String(src || '');
        // Heuristics: avoid matching common JS object colons; target TS-only patterns.
        return (/\binterface\s+\w+/.test(s) ||
            /\btype\s+\w+\s*=/.test(s) ||
            /\benum\s+\w+/.test(s) ||
            /\bdeclare\s+/.test(s) ||
            /\bimplements\s+\w+/.test(s) ||
            /\breadonly\s+\w+/.test(s) ||
            /\w+\s*\?:\s*[^=]/.test(s) || // optional prop
            /:\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:[,\)\}\n=])/.test(s) // annotation-ish
        );
    }
    catch (_a) {
        return false;
    }
}
function transpileBundleWithBabel(code, babelInstance) {
    var _a, _b;
    try {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        const w = (typeof window !== 'undefined') ? window : null;
        const Babel = babelInstance || (w && w.Babel) || (g && g.Babel) || (g && g.window && g.window.Babel);
        if (!Babel || typeof Babel.transform !== 'function') {
            return { success: false, code, error: 'Babel is not available (cannot transpile TS bundle)' };
        }
        const presetTS = (_a = Babel === null || Babel === void 0 ? void 0 : Babel.availablePresets) === null || _a === void 0 ? void 0 : _a.typescript;
        const presetReact = (_b = Babel === null || Babel === void 0 ? void 0 : Babel.availablePresets) === null || _b === void 0 ? void 0 : _b.react;
        if (!presetTS || !presetReact) {
            return { success: false, code, error: 'Babel presets not available (typescript/react)' };
        }
        const res = Babel.transform(String(code || ''), {
            presets: [
                [presetTS, {
                        isTSX: true,
                        allExtensions: true,
                        allowNamespaces: true,
                        allowDeclareFields: true,
                        onlyRemoveTypeImports: true,
                    }],
                [presetReact, { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' }],
            ],
            sourceType: 'unambiguous',
            filename: 'uf-vfs-bundle.tsx',
            compact: true,
        });
        const out = String((res === null || res === void 0 ? void 0 : res.code) || '');
        if (!out.trim())
            return { success: false, code, error: 'Babel transform produced empty output' };
        return { success: true, code: out };
    }
    catch (e) {
        return { success: false, code, error: (e === null || e === void 0 ? void 0 : e.message) || String(e) };
    }
}
// NOTE:
// These regexes are used only for building the internal dependency graph (VFS-relative imports).
// Non-relative imports are treated as externals (resolved at runtime via __UF_EXTERNALS__/mocks).
const importRe = /^[ \t]*import\s+(?!type\s)(?:[\s\S]*?\sfrom\s+)?['\"]([^'\"]+)['\"];?/gm;
const dynImportRe = /^[ \t]*import\s*\(\s*['\"]([^'\"]+)['\"]\s*\)\s*;?/gm;
const exportFromRe = /^[ \t]*export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['\"]([^'\"]+)['\"];?/gm;
function parseExportSpecifiers(list) {
    try {
        const spec = String(list || '').trim();
        if (!spec)
            return [];
        return spec
            .split(',')
            .map((s) => String(s || '').trim())
            .filter(Boolean)
            .flatMap((s) => {
            // Type-only export: `type Foo` / `type Foo as Bar`
            if (/^type\s+/.test(s))
                return [];
            const m = s.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
            if (m)
                return [{ local: m[1], exported: m[2] }];
            return [{ local: s, exported: s }];
        });
    }
    catch (_a) {
        return [];
    }
}
function stripModuleSyntax(src, opts) {
    const isEntry = !!(opts === null || opts === void 0 ? void 0 : opts.isEntry);
    const exportedNames = new Set();
    let out = String(src || '');
    // IMPORTANT: strip only real import statements (start-of-line), never "import" inside comments/strings.
    out = out
        .replace(/^[ \t]*import\s+type\s+[^\n]*$/gm, '')
        .replace(/^[ \t]*import\s+[^\n]*$/gm, '')
        .replace(/^[ \t]*import\s*\([^)]*\)\s*;?[ \t]*$/gm, '')
        // Re-export forms (index.ts barrels). We don't support module linking, so drop them.
        .replace(/^\s*export\s+\*\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
        .replace(/^\s*export\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
        .replace(/^\s*export\s*\{[^}]*\}\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm, '');
    // Default export: use bracket notation (exports['default']) to prevent react-host.js sanitize()
    // from replacing `exports.default = X` with `window.CurrentComponent = X` globally,
    // which breaks the bundler's CommonJS module system.
    out = out.replace(/\bexport\s+default\s+/g, isEntry ? "window.CurrentComponent = exports['default'] = " : "exports['default'] = ");
    // Capture named exports on declarations (export const Foo = ...).
    out = out.replace(/^\s*export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (m, _kind, name) => {
        if (name)
            exportedNames.add(String(name));
        return m.replace(/^\s*export\s+/, '');
    });
    // Inline named export lists: `export { A, B as C }`
    out = out.replace(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm, (_m, list) => {
        const specs = parseExportSpecifiers(String(list || ''));
        if (!specs.length)
            return '';
        return specs
            .map(({ exported, local }) => {
            const lhs = exported === 'default' ? "exports['default']" : `exports.${exported}`;
            const rhs = local === 'default' ? "exports['default']" : local;
            return `${lhs} = ${rhs};`;
        })
            .join('\n');
    });
    // Remove empty export blocks and export keyword for type/interface declarations.
    out = out
        .replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
        .replace(/\bexport\s+(?=(interface|type)\b)/g, '');
    if (exportedNames.size > 0) {
        const assigns = Array.from(exportedNames)
            .map((name) => name === 'default' ? `exports['default'] = ${name};` : `exports.${name} = ${name};`)
            .join('\n');
        out += `\n${assigns}\n`;
    }
    return out.trim();
}
function joinPath(baseDir, rel) {
    const parts = [];
    const a = baseDir.split('/').filter(Boolean);
    const b = rel.split('/').filter(Boolean);
    for (const p of a)
        parts.push(p);
    for (const p of b) {
        if (p === '.')
            continue;
        if (p === '..') {
            parts.pop();
            continue;
        }
        parts.push(p);
    }
    return parts.join('/');
}
function dirOf(path) { const i = path.lastIndexOf('/'); return i >= 0 ? path.slice(0, i) : ''; }
function isCodeFile(p) {
    return /\.(tsx|ts|jsx|js|mjs|cjs)$/i.test(p);
}
function isIgnorableAssetImport(rel) {
    return /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(rel);
}
// ── Incremental bundling cache ──
// Two-level cache to avoid redundant work on hot-reload:
//   L1: per-file module transform cache (keyed by file path + content hash)
//   L2: Babel transpilation cache (keyed by full pre-babel bundle hash)
// Both are FIFO-pruned to prevent unbounded memory growth.
function simpleHash(s) {
    let h = 0;
    for (let i = 0, len = s.length; i < len; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return 'h' + (h >>> 0).toString(36);
}
const MODULE_CACHE_MAX = 400;
const BABEL_CACHE_MAX = 30;
const moduleTransformCache = new Map();
const babelTranspileCache = new Map();
function pruneMap(map, max) {
    if (map.size <= max)
        return;
    const toDelete = map.size - max;
    const iter = map.keys();
    for (let i = 0; i < toDelete; i++) {
        const k = iter.next().value;
        if (k !== undefined)
            map.delete(k);
    }
}
function parseCssModuleClassMap(cssText) {
    try {
        const text = String(cssText || '');
        // Extract class names; match .foo{ and .foo, and .foo: (pseudo-classes).
        const rx = /\.([A-Za-z0-9_-]+)\s*[{,:]/g;
        const out = {};
        let m;
        while ((m = rx.exec(text))) {
            const key = String(m[1] || '').trim();
            if (!key)
                continue;
            // Identity mapping: CSS is injected globally via resolvedStyles,
            // so class names must match the raw CSS selectors.
            out[key] = key;
        }
        return out;
    }
    catch (_a) {
        return {};
    }
}
function toSafeJsString(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}
function parseValueNamedSpecifiers(list) {
    // Parse `import { A, type B as C } from 'x'`-style lists and return ONLY runtime value bindings.
    // Type-only specifiers must be dropped; otherwise we emit invalid JS like `{ Icon, type IconName }`.
    try {
        const spec = String(list || '').trim();
        if (!spec)
            return [];
        return spec
            .split(',')
            .map((s) => String(s || '').trim())
            .filter(Boolean)
            .flatMap((s) => {
            // TS 4.5+: `type Foo` / `type Foo as Bar`
            if (/^type\s+/.test(s))
                return [];
            const m = s.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
            return [m ? `${m[1]}: ${m[2]}` : s];
        });
    }
    catch (_a) {
        return [];
    }
}
function resolveNonRelativeKey(rel, vfs) {
    try {
        const rawInput = String(rel || '').trim();
        if (!rawInput)
            return null;
        const cleaned = rawInput
            .replace(/^@\//, '')
            .replace(/^userface\//, '')
            .replace(/^\.?\//, '')
            .replace(/\/+/g, '/');
        if (!cleaned)
            return null;
        const candidates = [
            cleaned,
            `${cleaned}.tsx`,
            `${cleaned}.ts`,
            `${cleaned}.jsx`,
            `${cleaned}.js`,
            `${cleaned}.mjs`,
            `${cleaned}.cjs`,
            `${cleaned}/index.tsx`,
            `${cleaned}/index.ts`,
            `${cleaned}/index.jsx`,
            `${cleaned}/index.js`,
            `${cleaned}/index.mjs`,
            `${cleaned}/index.cjs`,
        ];
        for (const c of candidates) {
            if (vfs[c] && typeof vfs[c].content === 'string')
                return c;
        }
        const suffixes = candidates.map((c) => c.replace(/^\/+/, ''));
        const keys = Object.keys(vfs || {});
        for (const key of keys) {
            if (!isCodeFile(key))
                continue;
            for (const suffix of suffixes) {
                if (key === suffix || key.endsWith(`/${suffix}`))
                    return key;
            }
        }
        return null;
    }
    catch (_a) {
        return null;
    }
}
function transformImportsToRequires(params) {
    const { key, resolveKey, vfs } = params;
    let out = String(params.src || '');
    // CSS modules: replace with class map object (identity — CSS injected globally).
    out = out.replace(/^([ \t]*)import\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+\.module\.css)['"][ \t]*;?/gm, (_m, lead, ident, rel) => {
        var _a;
        try {
            const cssKey = joinPath(dirOf(key), rel).replace(/\/+/g, '/');
            const css = ((_a = vfs[cssKey]) === null || _a === void 0 ? void 0 : _a.content) ? String(vfs[cssKey].content) : '';
            const map = parseCssModuleClassMap(css);
            return `${lead}const ${ident} = ${JSON.stringify(map)};`;
        }
        catch (_b) {
            return `${lead}const ${ident} = {};`;
        }
    });
    // Side-effect imports:
    // - assets: drop (styles are injected separately)
    // - external modules: keep as require('module')
    // - relative modules: require(resolvedKey)
    out = out.replace(/^([ \t]*)import\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, rel) => {
        try {
            const r = String(rel || '').trim();
            if (isIgnorableAssetImport(r))
                return lead;
            const isRel = r.startsWith('.');
            const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
            if (!dep)
                return lead;
            return `${lead}require('${toSafeJsString(dep)}');`;
        }
        catch (_a) {
            return lead;
        }
    });
    // import X, {A as B} from '...'
    out = out.replace(/^([ \t]*)import\s+([A-Za-z0-9_$]+)\s*,\s*\{([^}]*)\}\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, defName, named, rel) => {
        const r = String(rel || '').trim();
        if (isIgnorableAssetImport(r))
            return lead;
        const isRel = r.startsWith('.');
        const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
        if (!dep)
            return lead;
        const tmp = `__uf_m_${Math.abs((dep + defName).split('').reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381))}`;
        const destructItems = parseValueNamedSpecifiers(String(named || ''));
        const destruct = destructItems.join(', ');
        const destructLine = destruct ? `\nvar { ${destruct} } = ${tmp};` : '';
        return `${lead}var ${tmp} = require('${toSafeJsString(dep)}');\nvar ${defName} = (${tmp} && ${tmp}.default) ? ${tmp}.default : ${tmp};${destructLine}\n`;
    });
    // import {A as B} from '...'
    out = out.replace(/^([ \t]*)import\s*\{([^}]*)\}\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, named, rel) => {
        const r = String(rel || '').trim();
        if (isIgnorableAssetImport(r))
            return lead;
        const isRel = r.startsWith('.');
        const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
        if (!dep)
            return lead;
        const destructItems = parseValueNamedSpecifiers(String(named || ''));
        if (destructItems.length === 0)
            return lead;
        return `${lead}var { ${destructItems.join(', ')} } = require('${toSafeJsString(dep)}');`;
    });
    // import * as NS from '...'
    out = out.replace(/^([ \t]*)import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, ns, rel) => {
        const r = String(rel || '').trim();
        if (isIgnorableAssetImport(r))
            return lead;
        const isRel = r.startsWith('.');
        const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
        if (!dep)
            return lead;
        return `${lead}var ${ns} = require('${toSafeJsString(dep)}');`;
    });
    // import X from '...'
    out = out.replace(/^([ \t]*)import\s+([A-Za-z0-9_$]+)\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, defName, rel) => {
        const r = String(rel || '').trim();
        if (isIgnorableAssetImport(r))
            return lead;
        const isRel = r.startsWith('.');
        const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
        if (!dep)
            return lead;
        const tmp = `__uf_m_${Math.abs((dep + defName).split('').reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381))}`;
        return `${lead}var ${tmp} = require('${toSafeJsString(dep)}');\nvar ${defName} = (${tmp} && ${tmp}.default) ? ${tmp}.default : ${tmp};`;
    });
    // Drop import type
    out = out.replace(/^[ \t]*import\s+type\s+[^\n]*$/gm, '');
    // Re-export forms (runtime): export * from './rel'
    out = out.replace(/^([ \t]*)export\s+\*\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, rel) => {
        const r = String(rel || '').trim();
        if (isIgnorableAssetImport(r))
            return lead;
        const isRel = r.startsWith('.');
        const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
        if (!dep)
            return lead;
        return `${lead}Object.assign(exports, require('${toSafeJsString(dep)}'));`;
    });
    // export { A as B } from './rel'
    out = out.replace(/^([ \t]*)export\s*\{([^}]*)\}\s+from\s+['"]([^'"]+)['"][ \t]*;?/gm, (_m, lead, named, rel) => {
        const r = String(rel || '').trim();
        if (isIgnorableAssetImport(r))
            return lead;
        const isRel = r.startsWith('.');
        const dep = isRel ? resolveKey(key, r) : (resolveNonRelativeKey(r, vfs) || r);
        if (!dep)
            return lead;
        const tmp = `__uf_m_${Math.abs((dep + String(named || '')).split('').reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381))}`;
        const spec = String(named || '').trim();
        const assigns = spec
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
            // Skip type-only specifiers: `type Foo`, `type Foo as Bar`
            if (/^type\s+/.test(s))
                return '';
            const m = s.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
            const from = m ? m[1] : s;
            const to = m ? m[2] : s;
            // Bracket notation for 'default' to avoid react-host.js sanitize() regex
            const lhs = to === 'default' ? `exports['default']` : `exports.${to}`;
            const rhs = from === 'default' ? `${tmp}['default']` : `${tmp}.${from}`;
            return `${lhs} = ${rhs};`;
        })
            .filter(Boolean)
            .join(' ');
        return `${lead}var ${tmp} = require('${toSafeJsString(dep)}'); ${assigns}`;
    });
    // export type { ... } from './rel' -> drop
    out = out.replace(/^[ \t]*export\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]+['"][ \t]*;?/gm, '');
    return out;
}
function transformExportsToCjs(src, _opts) {
    let out = String(src || '');
    const exportedNames = new Set();
    const namedValueExports = new Set();
    let defaultIdent = null;
    // export default function Name() {}
    out = out.replace(/(^|\n)\s*export\s+default\s+function\s+([A-Za-z0-9_$]+)\s*\(/g, (_m, lead, name) => {
        exportedNames.add('default');
        exportedNames.add(name);
        defaultIdent = String(name || '') || defaultIdent;
        return `${lead}function ${name}(`;
    });
    // export default function () {}
    out = out.replace(/(^|\n)\s*export\s+default\s+function\s*\(/g, (_m, lead) => {
        exportedNames.add('default');
        return `${lead}exports['default'] = function(`;
    });
    // export default class Name {}
    out = out.replace(/(^|\n)\s*export\s+default\s+class\s+([A-Za-z0-9_$]+)\b/g, (_m, lead, name) => {
        exportedNames.add('default');
        exportedNames.add(name);
        defaultIdent = String(name || '') || defaultIdent;
        return `${lead}class ${name}`;
    });
    // export default class {}
    out = out.replace(/(^|\n)\s*export\s+default\s+class\b/g, (_m, lead) => {
        exportedNames.add('default');
        return `${lead}exports['default'] = class`;
    });
    // export default (expr);
    out = out.replace(/(^|\n)\s*export\s+default\s+/g, (_m, lead) => {
        exportedNames.add('default');
        return `${lead}exports['default'] = `;
    });
    // export const foo / export function bar / export class Baz
    out = out.replace(/(^|\n)\s*export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g, (_m, lead, kind, name) => {
        exportedNames.add(name);
        namedValueExports.add(name);
        return `${lead}${kind} ${name}`;
    });
    // export { a, b as c };
    out = out.replace(/(^|\n)\s*export\s*\{([^}]*)\}[ \t]*;?/g, (_m, lead, list) => {
        const spec = String(list || '').trim();
        if (!spec)
            return lead;
        const assigns = spec
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
            // Skip type-only specifiers: `type Foo`, `type Foo as Bar`
            if (/^type\s+/.test(s))
                return '';
            const m = s.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
            const from = m ? m[1] : s;
            const to = m ? m[2] : s;
            exportedNames.add(to);
            // Bracket notation for 'default' to avoid react-host.js sanitize() regex
            return to === 'default' ? `exports['default'] = ${from};` : `exports.${to} = ${from};`;
        })
            .filter(Boolean)
            .join(' ');
        return `${lead}${assigns}`;
    });
    // Strip standalone type-only export blocks: `export type { Foo, Bar };` (no `from` clause).
    // These have no runtime value — drop them entirely before the generic `export type` strip below.
    out = out.replace(/(^|\n)\s*export\s+type\s*\{[^}]*\}[ \t]*;?/g, '$1');
    // TS-only: remove `export` keyword for type/interface/enum; TS/Babel will strip later.
    out = out.replace(/(^|\n)\s*export\s+type\b/g, '$1type');
    out = out.replace(/(^|\n)\s*export\s+interface\b/g, '$1interface');
    out = out.replace(/(^|\n)\s*export\s+enum\b/g, '$1enum');
    // If we had named default function/class, set exports['default'] after declarations.
    // IMPORTANT: bracket notation avoids react-host.js sanitize() regex breakage.
    if (exportedNames.has('default') && defaultIdent && !/exports\[['"]default['"]\]\s*=/.test(out)) {
        out += `\n;try{exports['default'] = ${defaultIdent};}catch(_){}\n`;
    }
    // Bind named runtime exports (export const/function/class) to exports.*
    if (namedValueExports.size > 0) {
        for (const n of Array.from(namedValueExports)) {
            if (!n)
                continue;
            out += `\n;try{ if (!exports.${n}) exports.${n} = ${n}; }catch(_){}\n`;
        }
    }
    return { code: out };
}
export function bundleFromVfs(entryKey, vfs, options = {}) {
    const moduleErrors = [];
    try {
        const visited = new Set();
        const order = [];
        const resolveKey = (fromKey, rel) => {
            const baseDir = dirOf(fromKey);
            const raw = joinPath(baseDir, rel).replace(/\/+/g, '/');
            // Never resolve non-code assets into the JS bundle (CSS modules are handled inline in the source transform).
            if (!isCodeFile(raw) && isIgnorableAssetImport(raw))
                return null;
            const candidates = [
                `${raw}.tsx`,
                `${raw}.ts`,
                `${raw}.jsx`,
                `${raw}.js`,
                `${raw}.mjs`,
                `${raw}.cjs`,
                `${raw}/index.tsx`,
                `${raw}/index.ts`,
                `${raw}/index.jsx`,
                `${raw}/index.js`,
                `${raw}/index.mjs`,
                `${raw}/index.cjs`,
            ];
            // If raw already includes a code extension, check it first.
            if (isCodeFile(raw))
                candidates.unshift(raw);
            for (const c of candidates) {
                if (vfs[c] && typeof vfs[c].content === 'string')
                    return c;
            }
            return null;
        };
        const dfs = (key) => {
            if (visited.has(key))
                return;
            visited.add(key);
            const file = vfs[key];
            if (!file) {
                // Soft error: missing file in VFS — track instead of crashing.
                // Entry file missing is still fatal (caught by outer try/catch).
                if (key === entryKey)
                    throw new Error(`File not found in VFS: ${key}`);
                moduleErrors.push({ module: key, from: '(direct)', message: `File not found in VFS: ${key}` });
                return;
            }
            const src = String(file.content || '');
            // collect relative deps
            const deps = new Set();
            src.replace(importRe, (_m, rel) => { deps.add(rel); return ''; });
            src.replace(exportFromRe, (_m, rel) => { deps.add(rel); return ''; });
            src.replace(dynImportRe, (_m, rel) => { deps.add(rel); return ''; });
            for (const rel of deps) {
                const r = String(rel || '').trim();
                if (!r)
                    continue;
                const isRel = r.startsWith('.');
                const depKey = isRel ? resolveKey(key, r) : resolveNonRelativeKey(r, vfs);
                // Ignore assets (css/svg/fonts/etc). They are either handled by resolvedStyles or not supported.
                if (!depKey) {
                    if (!isRel)
                        continue;
                    if (isIgnorableAssetImport(r))
                        continue;
                    // Soft error: unresolved relative import — skip and continue bundling.
                    moduleErrors.push({ module: r, from: key, message: `Cannot resolve '${r}' from '${key}'` });
                    continue;
                }
                dfs(depKey);
            }
            order.push(key);
        };
        dfs(entryKey);
        // Build a tiny CommonJS-like module system so that imports between VFS files work.
        // L1 cache: per-file module transforms keyed by (path + content hash).
        const modules = order.map((k) => {
            const isEntry = k === entryKey;
            const content = String(vfs[k].content || '');
            const cacheKey = `${k}:${isEntry ? 'e' : 'd'}:${simpleHash(content)}`;
            const cached = moduleTransformCache.get(cacheKey);
            if (cached)
                return cached;
            const raw = transformImportsToRequires({ key: k, src: content, resolveKey, vfs });
            const { code } = transformExportsToCjs(raw, { isEntry });
            const body = stripModuleSyntax(code, { isEntry: false });
            const moduleStr = `__uf_modules['${toSafeJsString(k)}'] = function(module, exports, require){\n${body}\n};\n`;
            moduleTransformCache.set(cacheKey, moduleStr);
            pruneMap(moduleTransformCache, MODULE_CACHE_MAX);
            return moduleStr;
        });
        const reactPrelude = `\n;/* UF VFS Bundler prelude (React globals + named imports compatibility) */\n` +
            `(function(){\n` +
            `  try {\n` +
            `    var React = (typeof window !== 'undefined' && (window.React || window.react)) ? (window.React || window.react) : null;\n` +
            `    if (!React) return;\n` +
            `    window.React = React;\n` +
            `    var d = React;\n` +
            `    window.useState = d.useState;\n` +
            `    window.useEffect = d.useEffect;\n` +
            `    window.useMemo = d.useMemo;\n` +
            `    window.useCallback = d.useCallback;\n` +
            `    window.useRef = d.useRef;\n` +
            `    window.useReducer = d.useReducer;\n` +
            `    window.useLayoutEffect = d.useLayoutEffect;\n` +
            `    window.useContext = d.useContext;\n` +
            `    window.useId = d.useId;\n` +
            `    window.useImperativeHandle = d.useImperativeHandle;\n` +
            `    window.useDeferredValue = d.useDeferredValue;\n` +
            `    window.useTransition = d.useTransition;\n` +
            `    window.createContext = d.createContext;\n` +
            `    window.forwardRef = d.forwardRef;\n` +
            `    window.memo = d.memo;\n` +
            `    window.lazy = d.lazy;\n` +
            `    window.Suspense = d.Suspense;\n` +
            `    window.Fragment = d.Fragment;\n` +
            `    window.Children = d.Children;\n` +
            `    window.cloneElement = d.cloneElement;\n` +
            `    window.isValidElement = d.isValidElement;\n` +
            `    window.createElement = d.createElement;\n` +
            `  } catch (e) {}\n` +
            `})();\n`;
        const modulePrelude = `\n;/* UF VFS Bundler module system */\n` +
            `var __uf_modules = Object.create(null);\n` +
            `var __uf_cache = Object.create(null);\n` +
            `function __uf_require(id){\n` +
            `  if(__uf_cache[id]) return __uf_cache[id].exports;\n` +
            `  var fn = __uf_modules[id];\n` +
            `  if(!fn) {\n` +
            `    // External modules: resolved from host-provided registry (mocks / app externals).\n` +
            `    try {\n` +
            `      var g = (typeof window !== 'undefined') ? window : null;\n` +
            `      if (g) {\n` +
            `        if (id === 'react') return g.React;\n` +
            `        if (id === 'react-dom') return g.ReactDOM;\n` +
            `        if (id === 'react-dom/client') return g.ReactDOMClient || g.ReactDOM;\n` +
            `        if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') {\n` +
            `          var R = g.React || {};\n` +
            `          var ce = R.createElement;\n` +
            `          if (!ce) return {};\n` +
            `          var mk = function(type, props, key){\n` +
            `            var p = (props && typeof props === 'object') ? Object.assign({}, props) : {};\n` +
            `            if (key != null && p.key == null) p.key = key;\n` +
            `            return ce(type, p);\n` +
            `          };\n` +
            `          return { jsx: mk, jsxs: mk, jsxDEV: mk, Fragment: R.Fragment };\n` +
            `        }\n` +
            `        var ex = g.__UF_EXTERNALS__ || g.__MOCK_MODULES__ || g.__UF_MOCK_MODULES__;\n` +
            `        if (ex && ex[id]) return ex[id];\n` +
            `        if (ex && id && id.indexOf('/') > 0) {\n` +
            `          var root = id.split('/')[0];\n` +
            `          if (root && ex[root]) return ex[root];\n` +
            `          if (id.charAt(0) === '@') {\n` +
            `            var p = id.split('/');\n` +
            `            if (p.length > 1) {\n` +
            `              var scoped = p[0] + '/' + p[1];\n` +
            `              if (ex[scoped]) return ex[scoped];\n` +
            `            }\n` +
            `          }\n` +
            `        }\n` +
            `        // Auto-mock for unknown externals (ONLY in explicit mock mode).\n` +
            `        // This prevents crashes for "common cases" when a component imports something we don't ship in the sandbox.\n` +
            `        if (g.__UF_MOCK_MODE__ === true && g.__UF_MOCK_STRICT__ !== true && typeof g.__UF_CREATE_AUTO_MOCK__ === 'function') {\n` +
            `          return g.__UF_CREATE_AUTO_MOCK__(id);\n` +
            `        }\n` +
            `      }\n` +
            `    } catch (e) {}\n` +
            `    throw new Error('Missing module: ' + id + '. External packages need to be pre-bundled or mocked for the sandbox.');\n` +
            `  }\n` +
            `  var module = { exports: {} };\n` +
            `  __uf_cache[id] = module;\n` +
            `  fn(module, module.exports, __uf_require);\n` +
            `  return module.exports;\n` +
            `}\n`;
        const codeBody = reactPrelude + modulePrelude + modules.join('\n');
        const baseName = (() => {
            const file = entryKey.split('/').pop() || entryKey;
            return file.replace(/\.(tsx|ts|jsx|js)$/i, '');
        })();
        const tail = `\n;/* execute entry + expose component */\n` +
            `(function(){\n` +
            `  try {\n` +
            `    var __e = __uf_require('${toSafeJsString(entryKey)}');\n` +
            `    var __base = '${toSafeJsString(baseName)}';\n` +
            `    var __pascal = __base.replace(/(^|[-_\\s]+)([a-z0-9])/g, function(_m, _p, c){ return String(c || '').toUpperCase(); }).replace(/[^A-Za-z0-9]/g, '');\n` +
            `    var __d = (__e && __e.default) ? __e.default : null;\n` +
            `    if (!__d && typeof __e === 'function') { __d = __e; }\n` +
            `    if (!__d && __e && typeof __e === 'object') {\n` +
            `      try {\n` +
            `        if (__e[__base]) __d = __e[__base];\n` +
            `        if (!__d && __e[__pascal]) __d = __e[__pascal];\n` +
            `        if (!__d) {\n` +
            `          var __keys = Object.keys(__e || {});\n` +
            `          var __cands = __keys.filter(function(k){ return typeof __e[k] === 'function'; });\n` +
            `          if (__cands.length === 1) __d = __e[__cands[0]];\n` +
            `        }\n` +
            `      } catch (_e) {}\n` +
            `    }\n` +
            `    var __isComp = function(v){ return !!v && (typeof v === 'function' || (typeof v === 'object' && v.$$typeof)); };\n` +
            `    if (__isComp(__d)) {\n` +
            `      window.CurrentComponent = __d;\n` +
            `      try {\n` +
            `        var __reg = window.__UF_COMPONENTS__ || (window.__UF_COMPONENTS__ = Object.create(null));\n` +
            `        if (__base) __reg[__base] = __d;\n` +
            `        if (__pascal) __reg[__pascal] = __d;\n` +
            `      } catch(_){ }\n` +
            `    }\n` +
            `  } catch (e) { console.error('[UF VFS Bundler] entry failed', e); }\n` +
            `})();\n`;
        const code = codeBody + tail;
        if (hasTypeScriptSyntax(code)) {
            // L2 cache: Babel transpilation (the heaviest step) keyed by pre-babel hash.
            const babelKey = simpleHash(code);
            const cachedBabel = babelTranspileCache.get(babelKey);
            if (cachedBabel) {
                if (!cachedBabel.success) {
                    return { success: false, code: '', filesUsed: order, moduleErrors, error: `bundle_transpile_failed: ${cachedBabel.error || 'unknown'}` };
                }
                return { success: true, code: cachedBabel.code, filesUsed: order, moduleErrors };
            }
            const tr = transpileBundleWithBabel(code, options.Babel);
            babelTranspileCache.set(babelKey, tr);
            pruneMap(babelTranspileCache, BABEL_CACHE_MAX);
            if (!tr.success) {
                return { success: false, code: '', filesUsed: order, moduleErrors, error: `bundle_transpile_failed: ${tr.error || 'unknown'}` };
            }
            return { success: true, code: tr.code, filesUsed: order, moduleErrors };
        }
        return { success: true, code, filesUsed: order, moduleErrors };
    }
    catch (e) {
        return { success: false, code: '', filesUsed: [], moduleErrors, error: (e === null || e === void 0 ? void 0 : e.message) || String(e) };
    }
}
export function needsBundling(source) {
    try {
        if (!source)
            return false;
        // IMPORTANT: Do NOT use .test() on the module-level global regexes — they have the `g` flag,
        // so .test() advances lastIndex and gives alternating true/false results across calls.
        // Use fresh regex instances (without `g`) instead.
        return (/^[ \t]*import\s+(?:type\s+)?(?:[^'"\n;]+)\s+from\s+['"]/m.test(source) ||
            /^[ \t]*import\s*\(\s*['"]/m.test(source) ||
            /^[ \t]*export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+['"]/m.test(source));
    }
    catch (_a) {
        return false;
    }
}
