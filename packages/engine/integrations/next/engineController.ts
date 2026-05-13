import { ensureEngineScriptsLoaded } from './engineLoaderService';
import { bundleFromVfs } from '../../src/bundler/vfsBundler';

export interface UserfaceRenderResult {
  type?: string;
  data?: any;
  error?: string | null;
}

export interface UserfaceEngine {
  ready?: boolean;
  analyzeComponent?: (
    files: Array<{ name: string; content: string }>,
    options?: { entryPath?: string }
  ) => Promise<any>;
  renderFromSpec?: (name: string, props: any, mode?: 'ssr' | 'live') => Promise<UserfaceRenderResult>;
  getComponentSpec?: (name: string) => any;
}

let cachedEngine: any = null;
let ensurePromise: Promise<any> | null = null;

const DEFAULT_DEBUG = true;

interface EnsureOptions {
  debug?: boolean;
}

export async function ensureEngineReady(options: EnsureOptions = {}): Promise<UserfaceEngine> {
  const debug = options.debug ?? DEFAULT_DEBUG;

  if (cachedEngine && typeof cachedEngine.renderFromSpec === 'function') {
    // Ensure the cached engine always uses the latest VFS bundler.
    try {
      (cachedEngine as any).bundler = (entryPath: string, vfs: Record<string, any>, _opts?: any) => {
        return bundleFromVfs(String(entryPath || ''), vfs as any);
      };
    } catch {}
    return cachedEngine;
  }

  if (ensurePromise) {
    return ensurePromise;
  }

  if (typeof window === 'undefined') {
    throw new Error('UserfaceEngine is only available in the browser runtime');
  }

  const g = window as any;

  const resolveExisting = (): any | null => {
    if (g.engine && typeof g.engine.renderFromSpec === 'function') {
      if (!g.engine.ready) {
        g.engine.ready = true;
      }
      // Если движок создан \"по умолчанию\" (из public/runtime/engine/userface-engine.js),
      // он может иметь устаревший bundler. Форсируем актуальный bundler на VFS,
      // чтобы алиасы (@/userface/...) и локальные файлы всегда резолвились правильно.
      try {
        (g.engine as any).bundler = (entryPath: string, vfs: Record<string, any>, _opts?: any) => {
          return bundleFromVfs(String(entryPath || ''), vfs as any);
        };
      } catch {}
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
    } catch {}
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
      if (typeof g.UserfaceEngine !== 'function') return true;
      if (typeof g.React === 'undefined') return true;
      if (typeof g.ReactDOM === 'undefined') return true;
      if (typeof g.Babel === 'undefined') return true;
      if (typeof g.PropExtractor === 'undefined') return true;
      return false;
    } catch {
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
    let engine: any;
    try {
      engine = new UserfaceEngineCtor({
        React: g.React,
        Babel: g.Babel,
        Vue: g.Vue,
        Svelte: g.Svelte,
        PropExtractor: g.PropExtractor,
        debug,
        // npm-ready: inject bundler instead of relying on window globals
        bundler: (entryPath: string, vfs: Record<string, any>, _opts?: any) => {
          return bundleFromVfs(String(entryPath || ''), vfs as any);
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
    } catch (initErr) {
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
    } catch {}

    if (engine.adaptersReady && typeof engine.adaptersReady.then === 'function') {
      try {
        await engine.adaptersReady;
      } catch {
        // ignore adapter readiness errors in browser — fallback adapters cover us
      }
    }

    return engine as UserfaceEngine;
  }).finally(() => {
    ensurePromise = null;
  });

  return ensurePromise!;
}

export async function analyzeComponentWithEngine(
  engine: UserfaceEngine,
  files: Array<{ name: string; content: string; type?: string }>,
  options: { entryPath: string }
): Promise<any> {
  if (!engine || typeof engine.analyzeComponent !== 'function') {
    throw new Error('Engine does not support analyzeComponent');
  }
  const entryPath = (() => { try { return String(options?.entryPath || ''); } catch { return ''; } })();
  if (!entryPath) {
    throw new Error('entryPath is required for analyzeComponentWithEngine');
  }
  const normalized = files.map(f => ({
    name: f.name,
    content: f.content,
  }));
  return engine.analyzeComponent(normalized as any, { entryPath } as any);
}

export async function renderComponentWithEngine(
  engine: UserfaceEngine,
  specName: string,
  props: Record<string, any>,
  mode: 'live' | 'ssr' = 'live'
): Promise<UserfaceRenderResult> {
  if (!engine || typeof engine.renderFromSpec !== 'function') {
    throw new Error('Engine does not support renderFromSpec');
  }
  return engine.renderFromSpec(specName, props, mode);
}

export function resetCachedEngine(): void {
  cachedEngine = null;
  ensurePromise = null;
}
