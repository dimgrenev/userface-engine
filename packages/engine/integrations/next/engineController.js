import { ensureEngineScriptsLoaded } from './engineLoaderService.js';
import { bundleFromVfs } from '../../dist/esm/bundler/vfsBundler.js';
let cachedEngine = null;
let ensurePromise = null;
const DEFAULT_DEBUG = true;
export async function ensureEngineReady(options = {}) {
    var _a;
    const debug = (_a = options.debug) !== null && _a !== void 0 ? _a : DEFAULT_DEBUG;
    if (cachedEngine && typeof cachedEngine.renderFromSpec === 'function') {
        // Ensure the cached engine always uses the latest VFS bundler.
        try {
            cachedEngine.bundler = (entryPath, vfs, _opts) => {
                return bundleFromVfs(String(entryPath || ''), vfs);
            };
        }
        catch (_b) { }
        return cachedEngine;
    }
    if (ensurePromise) {
        return ensurePromise;
    }
    if (typeof window === 'undefined') {
        throw new Error('UserfaceEngine is only available in the browser runtime');
    }
    const g = window;
    const resolveExisting = () => {
        if (g.engine && typeof g.engine.renderFromSpec === 'function') {
            if (!g.engine.ready) {
                g.engine.ready = true;
            }
            // Если движок создан \"по умолчанию\" (из public/runtime/engine/userface-engine.js),
            // он может иметь устаревший bundler. Форсируем актуальный bundler на VFS,
            // чтобы алиасы (@/userface/...) и локальные файлы всегда резолвились правильно.
            try {
                g.engine.bundler = (entryPath, vfs, _opts) => {
                    return bundleFromVfs(String(entryPath || ''), vfs);
                };
            }
            catch (_a) { }
            return g.engine;
        }
        return null;
    };
    const maybeExisting = resolveExisting();
    if (maybeExisting) {
        cachedEngine = maybeExisting;
        // Back-compat: some consumers rely on engineReady event to cancel "missing engine" timeouts.
        // If the engine already exists, still broadcast once.
        try {
            if (!g.__UF_ENGINE_READY_DISPATCHED__) {
                g.__UF_ENGINE_READY_DISPATCHED__ = true;
                window.dispatchEvent(new CustomEvent('engineReady', { detail: { engine: cachedEngine } }));
            }
        }
        catch (_c) { }
        return cachedEngine;
    }
    // Make ensureEngineReady self-sufficient:
    // load ALL required runtime globals, not only UserfaceEngine.
    //
    // Why: in our app, `public/runtime/engine/userface-engine.js` can be loaded earlier (or via caching/HMR),
    // while `/libs/react*` and `/libs/babel` might not be on `window` yet.
    // If we skip loading here, the ctor can throw and we end up with a stale "Engine is not available" overlay.
    const needsRuntimeScripts = (() => {
        try {
            if (typeof g.UserfaceEngine !== 'function')
                return true;
            if (typeof g.React === 'undefined')
                return true;
            if (typeof g.ReactDOM === 'undefined')
                return true;
            if (typeof g.Babel === 'undefined')
                return true;
            if (typeof g.PropExtractor === 'undefined')
                return true;
            return false;
        }
        catch (_a) {
            return true;
        }
    })();
    if (needsRuntimeScripts) {
        await ensureEngineScriptsLoaded({ debug });
    }
    const UserfaceEngineCtor = g.UserfaceEngine;
    if (typeof UserfaceEngineCtor !== 'function') {
        throw new Error('EngineLoader_not_ready: UserfaceEngine is not loaded yet');
    }
    ensurePromise = Promise.resolve().then(async () => {
        let engine;
        try {
            engine = new UserfaceEngineCtor({
                React: g.React,
                Babel: g.Babel,
                Vue: g.Vue,
                Svelte: g.Svelte,
                PropExtractor: g.PropExtractor,
                debug,
                // npm-ready: inject bundler instead of relying on window globals
                bundler: (entryPath, vfs, _opts) => {
                    return bundleFromVfs(String(entryPath || ''), vfs);
                },
                externals: [
                    'react',
                    'react-dom',
                    'react-dom/client',
                    'react/jsx-runtime',
                    'react/jsx-dev-runtime',
                    'next/router',
                    'next/navigation',
                    'next/link',
                    'next/image',
                    'next/head',
                    'components',
                    'userface',
                ],
            });
        }
        catch (initErr) {
            // Engine construction failed: clear cache so next call retries from scratch
            cachedEngine = null;
            ensurePromise = null;
            throw initErr;
        }
        engine.ready = true;
        g.engine = engine;
        cachedEngine = engine;
        // Back-compat: notify listeners (Render/Playground/CleanRenderer) that engine is ready.
        try {
            g.__UF_ENGINE_READY_DISPATCHED__ = true;
            window.dispatchEvent(new CustomEvent('engineReady', { detail: { engine } }));
        }
        catch (_a) { }
        if (engine.adaptersReady && typeof engine.adaptersReady.then === 'function') {
            try {
                await engine.adaptersReady;
            }
            catch (_b) {
                // ignore adapter readiness errors in browser — fallback adapters cover us
            }
        }
        return engine;
    }).finally(() => {
        ensurePromise = null;
    });
    return ensurePromise;
}
export async function analyzeComponentWithEngine(engine, files, options) {
    if (!engine || typeof engine.analyzeComponent !== 'function') {
        throw new Error('Engine does not support analyzeComponent');
    }
    const entryPath = (() => { try {
        return String((options === null || options === void 0 ? void 0 : options.entryPath) || '');
    }
    catch (_a) {
        return '';
    } })();
    if (!entryPath) {
        throw new Error('entryPath is required for analyzeComponentWithEngine');
    }
    const normalized = files.map(f => ({
        name: f.name,
        content: f.content,
    }));
    return engine.analyzeComponent(normalized, { entryPath });
}
export async function renderComponentWithEngine(engine, specName, props, mode = 'live') {
    if (!engine || typeof engine.renderFromSpec !== 'function') {
        throw new Error('Engine does not support renderFromSpec');
    }
    return engine.renderFromSpec(specName, props, mode);
}
export function resetCachedEngine() {
    cachedEngine = null;
    ensurePromise = null;
}
