export type EngineScriptItem = {
  src: string;
  global?: string;
  /** If true, failure to load this script won't block engine initialization. */
  optional?: boolean;
};

export type EnsureEngineScriptsOptions = {
  debug?: boolean;
  timeoutMs?: number;
  scripts?: EngineScriptItem[];
};

const DEFAULT_TIMEOUT_MS = 12_000;

const DEFAULT_SCRIPTS: EngineScriptItem[] = [
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

type LoaderState = 'idle' | 'loading' | 'ready' | 'error';
let state: LoaderState = 'idle';
let sharedPromise: Promise<void> | null = null;
let lastError: Error | null = null;

function withAssetVersion(src: string): string {
  const v = process.env.NEXT_PUBLIC_ASSET_VERSION;
  if (!v) return src;
  const sep = src.includes('?') ? '&' : '?';
  return `${src}${sep}v=${encodeURIComponent(v)}`;
}

function hasGlobal(globalName?: string): boolean {
  if (!globalName) return true;
  try {
    return typeof (window as any)[globalName] !== 'undefined';
  } catch {
    return false;
  }
}

async function waitForGlobal(globalName: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (hasGlobal(globalName)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for global: ${globalName}`);
}

async function loadScriptOnce(baseSrc: string, globalName: string | undefined, debug: boolean, timeoutMs: number): Promise<void> {
  if (typeof window === 'undefined') return;
  if (globalName && hasGlobal(globalName)) return;

  const selector = `script[data-uf-engine-src="${baseSrc}"]`;
  const existing = document.querySelector(selector) as HTMLScriptElement | null;

  // If a tag already exists, don't assume it's loaded: wait for the expected global (or timeout).
  if (existing) {
    if (debug) {
      try { console.log('[engine-loader] script tag already present', baseSrc); } catch {}
    }
    if (globalName) {
      await waitForGlobal(globalName, timeoutMs);
    }
    return;
  }

  const src = withAssetVersion(baseSrc);
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;
    s.setAttribute('data-uf-engine-src', baseSrc);
    const timer = window.setTimeout(() => {
      try { s.remove(); } catch {}
      reject(new Error(`Timed out loading engine script: ${baseSrc}`));
    }, timeoutMs);
    s.onload = () => {
      window.clearTimeout(timer);
      if (debug) {
        try { console.log('[engine-loader] loaded', baseSrc); } catch {}
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

function validateGlobals(scripts: EngineScriptItem[]): void {
  const missing: string[] = [];
  for (const s of scripts) {
    if (s.global && !hasGlobal(s.global)) {
      missing.push(s.global);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Engine globals missing after load: ${missing.join(', ')}`);
  }
}

export function getEngineLoaderState(): { state: LoaderState; error: Error | null } {
  return { state, error: lastError };
}

export async function ensureEngineScriptsLoaded(options: EnsureEngineScriptsOptions = {}): Promise<void> {
  if (typeof window === 'undefined') return;
  if (state === 'ready') return;
  if (state === 'error' && lastError) {
    // allow retry
    state = 'idle';
    sharedPromise = null;
  }
  if (sharedPromise) return sharedPromise;

  const debug = options.debug ?? false;
  const timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const scripts = options.scripts ?? DEFAULT_SCRIPTS;

  state = 'loading';
  sharedPromise = (async () => {
    try {
      for (const item of scripts) {
        try {
          await loadScriptOnce(item.src, item.global, debug, timeoutMs);
        } catch (scriptErr) {
          if (item.optional) {
            // Non-critical script (Vue, Svelte) — log and continue.
            try { console.warn(`[engine-loader] optional script failed, skipping: ${item.src}`); } catch {}
            continue;
          }
          throw scriptErr;
        }
      }
      // Only validate required globals
      const requiredScripts = scripts.filter((s) => !s.optional);
      validateGlobals(requiredScripts);
      state = 'ready';
      lastError = null;
    } catch (e: any) {
      const err = e instanceof Error ? e : new Error(String(e?.message || e));
      state = 'error';
      lastError = err;
      throw err;
    } finally {
      // keep promise for "ready" case, but drop it for "error" so next call can retry
      if (state === 'error') {
        sharedPromise = null;
      }
    }
  })();

  return sharedPromise;
}
