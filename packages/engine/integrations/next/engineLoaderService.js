const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_SCRIPTS = [
    { src: 'https://unpkg.com/react@18/umd/react.development.js', global: 'React' },
    { src: 'https://unpkg.com/react-dom@18/umd/react-dom.development.js', global: 'ReactDOM' },
    { src: 'https://unpkg.com/@babel/standalone@7/babel.min.js', global: 'Babel' },
    { src: 'https://unpkg.com/vue@3/dist/vue.global.js', global: 'Vue', optional: true },
    { src: 'https://unpkg.com/svelte@4/compiler/svelte-compiler.min.js', global: 'Svelte', optional: true },
    { src: '/runtime/engine/prop-extractor.js', global: 'PropExtractor' },
    { src: '/runtime/engine/codeSanitizer.js' },
    { src: '/runtime/engine/engine-adapters.js' },
    { src: '/runtime/engine/userface-engine.js', global: 'UserfaceEngine' },
];
let state = 'idle';
let sharedPromise = null;
let lastError = null;
function withAssetVersion(src) {
    const v = process.env.NEXT_PUBLIC_ASSET_VERSION;
    if (!v)
        return src;
    const sep = src.includes('?') ? '&' : '?';
    return `${src}${sep}v=${encodeURIComponent(v)}`;
}
function hasGlobal(globalName) {
    if (!globalName)
        return true;
    try {
        return typeof window[globalName] !== 'undefined';
    }
    catch (_a) {
        return false;
    }
}
async function waitForGlobal(globalName, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (hasGlobal(globalName))
            return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for global: ${globalName}`);
}
async function loadScriptOnce(baseSrc, globalName, debug, timeoutMs) {
    if (typeof window === 'undefined')
        return;
    if (globalName && hasGlobal(globalName))
        return;
    const selector = `script[data-uf-engine-src="${baseSrc}"]`;
    const existing = document.querySelector(selector);
    // If a tag already exists, don't assume it's loaded: wait for the expected global (or timeout).
    if (existing) {
        if (debug) {
            try {
                console.log('[engine-loader] script tag already present', baseSrc);
            }
            catch (_a) { }
        }
        if (globalName) {
            await waitForGlobal(globalName, timeoutMs);
        }
        return;
    }
    const src = withAssetVersion(baseSrc);
    await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = false;
        s.setAttribute('data-uf-engine-src', baseSrc);
        const timer = window.setTimeout(() => {
            try {
                s.remove();
            }
            catch (_a) { }
            reject(new Error(`Timed out loading engine script: ${baseSrc}`));
        }, timeoutMs);
        s.onload = () => {
            window.clearTimeout(timer);
            if (debug) {
                try {
                    console.log('[engine-loader] loaded', baseSrc);
                }
                catch (_a) { }
            }
            resolve();
        };
        s.onerror = () => {
            window.clearTimeout(timer);
            reject(new Error(`Failed to load engine script: ${baseSrc}`));
        };
        document.head.appendChild(s);
    });
    if (globalName) {
        await waitForGlobal(globalName, timeoutMs);
    }
}
function validateGlobals(scripts) {
    const missing = [];
    for (const s of scripts) {
        if (s.global && !hasGlobal(s.global)) {
            missing.push(s.global);
        }
    }
    if (missing.length > 0) {
        throw new Error(`Engine globals missing after load: ${missing.join(', ')}`);
    }
}
export function getEngineLoaderState() {
    return { state, error: lastError };
}
export async function ensureEngineScriptsLoaded(options = {}) {
    var _a, _b, _c;
    if (typeof window === 'undefined')
        return;
    if (state === 'ready')
        return;
    if (state === 'error' && lastError) {
        // allow retry
        state = 'idle';
        sharedPromise = null;
    }
    if (sharedPromise)
        return sharedPromise;
    const debug = (_a = options.debug) !== null && _a !== void 0 ? _a : false;
    const timeoutMs = Math.max(500, (_b = options.timeoutMs) !== null && _b !== void 0 ? _b : DEFAULT_TIMEOUT_MS);
    const scripts = (_c = options.scripts) !== null && _c !== void 0 ? _c : (options.includeOptionalFrameworks
        ? DEFAULT_SCRIPTS
        : DEFAULT_SCRIPTS.filter((script) => !script.optional));
    state = 'loading';
    sharedPromise = (async () => {
        try {
            for (const item of scripts) {
                try {
                    await loadScriptOnce(item.src, item.global, debug, timeoutMs);
                }
                catch (scriptErr) {
                    if (item.optional) {
                        if (debug) {
                            try { console.warn(`[engine-loader] optional script failed, skipping: ${item.src}`); } catch (_a) { }
                        }
                        continue;
                    }
                    throw scriptErr;
                }
            }
            const requiredScripts = scripts.filter((s) => !s.optional);
            validateGlobals(requiredScripts);
            state = 'ready';
            lastError = null;
        }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String((e === null || e === void 0 ? void 0 : e.message) || e));
            state = 'error';
            lastError = err;
            throw err;
        }
        finally {
            // keep promise for "ready" case, but drop it for "error" so next call can retry
            if (state === 'error') {
                sharedPromise = null;
            }
        }
    })();
    return sharedPromise;
}
