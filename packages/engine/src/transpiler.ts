/// <reference path="../types/global.d.ts" />

// engine/src is treated as ESM ("type":"module"). Use createRequire rooted at process.cwd()
// so Next/server runtimes can resolve optional deps without bare `require` expressions.
import { createRequire } from 'module';

const _req: NodeRequire = (() => {
  try {
    const cwd = (typeof process !== 'undefined' && typeof process.cwd === 'function') ? process.cwd() : '/';
    const baseUrl = new URL(`file://${String(cwd).replace(/\\/g, '/')}/`);
    return createRequire(baseUrl);
  } catch {
    return createRequire(new URL('file:///'));
  }
})();

// Prefer native esbuild in Node; fall back to esbuild-wasm in browser
let nodeEsbuild: any = null;
try {
  nodeEsbuild = _req('esbuild');
} catch {}

// Ленивая загрузка плагинов, чтобы не тянуть ESM в граф сборки API преждевременно
let vuePluginFactory: any = null;
let sveltePluginFactory: any = null;

type Framework = 'react' | 'vue' | 'svelte';
type TargetMode = 'dom' | 'ssr';

type VfsTextFile = { name: string; content: string };

function requireShimForFramework(framework: Framework): string {
  // In sandbox there is no module loader. If esbuild leaves `require("x")` calls (externals),
  // we provide a tiny shim mapping known externals to globals and the sandbox externals registry.
  //
  // SOFT STUB: Instead of throwing on missing modules (which kills the entire IIFE and produces
  // a blank preview), we return a Proxy stub and track missing modules in window.__UF_MISSING_MODULES__.
  // This allows partial rendering: components with some missing deps still render what they can.

  // Shared soft-stub tail: replaces `throw new Error(...)` with a tracked Proxy return.
  const softStubTail = [
    '  // Soft stub: track missing module and return proxy instead of throwing.',
    '  try {',
    '    var _g = (typeof window!=="undefined") ? window : globalThis;',
    '    if (!_g.__UF_MISSING_MODULES__) _g.__UF_MISSING_MODULES__ = {};',
    '    _g.__UF_MISSING_MODULES__[id] = true;',
    '    console.warn("[UF] Missing module: " + id + " — using stub");',
    '    // Trigger async CDN load if available',
    '    try { if (typeof _g.__UF_LOAD_MODULE_CDN__ === "function") _g.__UF_LOAD_MODULE_CDN__(id); } catch(_e){}',
    '    // Return a safe Proxy that acts as both function and object',
    '    var _noop = function(){ return null; };',
    '    _noop.displayName = "UfStub(" + id + ")";',
    '    if (typeof Proxy !== "undefined") {',
    '      var _handler = {',
    '        get: function(_t, _k) {',
    '          if (_k === "__esModule") return true;',
    '          if (_k === "__uf_missing") return true;',
    '          if (_k === "__uf_module") return id;',
    '          if (_k === "default") return _t;',
    '          if (_k === "$$typeof" || _k === "render" || _k === "displayName") return undefined;',
    '          if (typeof _k === "symbol") return undefined;',
    '          return _t;',
    '        },',
    '        apply: function() { return null; }',
    '      };',
    '      return new Proxy(_noop, _handler);',
    '    }',
    '    _noop.__esModule = true;',
    '    _noop.__uf_missing = true;',
    '    _noop.__uf_module = id;',
    '    _noop.default = _noop;',
    '    return _noop;',
    '  } catch(_e2) { return {}; }',
  ].join('\n');

  if (framework === 'vue') {
    return `\n;var require = function(id){\n  if (id === 'vue') {\n    try { var g = (typeof window!=='undefined') ? window : globalThis; return (g && (g.Vue || g.vue)) ? (g.Vue || g.vue) : {}; } catch(e){ return {}; }\n  }\n  try {\n    var g2 = (typeof window!=='undefined') ? window : globalThis;\n    if (g2 && g2.__UF_EXTERNALS__ && g2.__UF_EXTERNALS__[id]) return g2.__UF_EXTERNALS__[id];\n    if (g2 && g2.__UF_EXTERNALS__ && id && id.indexOf('/') > 0) {\n      var ex2 = g2.__UF_EXTERNALS__;\n      var root2 = id.split('/')[0];\n      if (root2 && ex2[root2]) return ex2[root2];\n      if (id.charAt(0) === '@') {\n        var p2 = id.split('/');\n        if (p2.length > 1) {\n          var scoped2 = p2[0] + '/' + p2[1];\n          if (ex2[scoped2]) return ex2[scoped2];\n        }\n      }\n    }\n  } catch(e) {}\n  try {\n    var g3 = (typeof window!=='undefined') ? window : globalThis;\n    if (g3 && g3.__UF_MOCK_MODE__ === true && typeof g3.__UF_CREATE_AUTO_MOCK__ === 'function') return g3.__UF_CREATE_AUTO_MOCK__(id);\n  } catch(e) {}\n${softStubTail}\n};\n`;
  }
  if (framework === 'react') {
    return `\n;var require = function(id){\n  try { var g = (typeof window!=='undefined') ? window : globalThis; } catch(e){ var g = globalThis; }\n  if (id === 'react') {\n    try { return (g && g.React) ? g.React : {}; } catch(e){ return {}; }\n  }\n  if (id === 'react-dom' || id === 'react-dom/client') {\n    try { return (g && (g.ReactDOMClient || g.ReactDOM)) ? (g.ReactDOMClient || g.ReactDOM) : {}; } catch(e){ return {}; }\n  }\n  if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') {\n    try {\n      var R = (g && g.React) ? g.React : {};\n      var ce = R.createElement;\n      if (!ce) return {};\n      var mk = function(type, props, key){\n        var p = (props && typeof props === 'object') ? Object.assign({}, props) : {};\n        if (key != null && p.key == null) p.key = key;\n        return ce(type, p);\n      };\n      return { jsx: mk, jsxs: mk, jsxDEV: mk, Fragment: R.Fragment };\n    } catch(e){ return {}; }\n  }\n  try {\n    if (g && g.__UF_EXTERNALS__ && g.__UF_EXTERNALS__[id]) return g.__UF_EXTERNALS__[id];\n    if (g && g.__UF_EXTERNALS__ && id && id.indexOf('/') > 0) {\n      var ex = g.__UF_EXTERNALS__;\n      var root = id.split('/')[0];\n      if (root && ex[root]) return ex[root];\n      if (id.charAt(0) === '@') {\n        var p = id.split('/');\n        if (p.length > 1) {\n          var scoped = p[0] + '/' + p[1];\n          if (ex[scoped]) return ex[scoped];\n        }\n      }\n    }\n  } catch(e) {}\n  // Optional mock-mode fallback (dev / auditing). In production strict mode, __UF_MOCK_MODE__ should be false.\n  try {\n    if (g && g.__UF_MOCK_MODE__ === true && typeof g.__UF_CREATE_AUTO_MOCK__ === 'function') return g.__UF_CREATE_AUTO_MOCK__(id);\n  } catch(e) {}\n${softStubTail}\n};\n`;
  }
  return `\n`;
}

async function getEsbuild(): Promise<any> {
  if (nodeEsbuild) return nodeEsbuild;
  // If native esbuild failed to load, fall back to esbuild-wasm.
  // IMPORTANT: handle Node vs Browser differently:
  // - Browser: use wasmURL (served by app)
  // - Node: load wasm bytes from the installed package to avoid URL assumptions
  const esbuildWasm = _req('esbuild-wasm');
  if (!(esbuildWasm as any)._initialized) {
    // Deduplicate concurrent init: store the init promise so concurrent callers
    // await the same promise instead of calling initialize() twice (which throws).
    if (!(esbuildWasm as any)._initPromise) {
      (esbuildWasm as any)._initPromise = (async () => {
        if (typeof window !== 'undefined') {
          await esbuildWasm.initialize({ wasmURL: '/runtime/esbuild.wasm' });
        } else {
          const fs = _req('fs') as typeof import('fs');
          const path = _req('path') as typeof import('path');
          const mainJs = _req.resolve('esbuild-wasm');
          const pkgRoot = path.dirname(path.dirname(mainJs));
          const wasmPath = path.join(pkgRoot, 'esbuild.wasm');
          const bytes = await fs.promises.readFile(wasmPath);
          const wasmModule = await WebAssembly.compile(new Uint8Array(bytes));
          await esbuildWasm.initialize({ wasmModule });
        }
        (esbuildWasm as any)._initialized = true;
      })().catch((err) => {
        console.error('[uf:transpiler] esbuild-wasm initialization failed:', err);
        (esbuildWasm as any)._initFailed = true;
        (esbuildWasm as any)._initPromise = null; // allow retry on next call
        throw err; // propagate so callers get a real rejection
      });
    }
    if ((esbuildWasm as any)._initFailed) {
      throw new Error('esbuild-wasm initialization previously failed — retry by reloading');
    }
    await (esbuildWasm as any)._initPromise;
  }
  return esbuildWasm;
}

export async function transpileToIIFE(
  code: string,
  framework: Framework,
  componentName: string,
  mode: TargetMode = 'dom'
): Promise<{ cleanCode: string; isIIFE: true } | { cleanCode: string; isIIFE: false }> {
  const esbuild = await getEsbuild();

  let loader: any = 'tsx';
  const plugins: any[] = [];
  let sourcefile = 'component.tsx';

  if (framework === 'vue') {
    loader = 'ts';
    if (!vuePluginFactory) {
      try {
        const mod = _req('esbuild-plugin-vue');
        vuePluginFactory = mod && (mod.default || mod);
      } catch {}
    }
    if (vuePluginFactory) plugins.push(vuePluginFactory());
    sourcefile = 'component.vue';
  } else if (framework === 'svelte') {
    loader = 'ts';
    if (!sveltePluginFactory) {
      try {
        const mod = _req('esbuild-svelte');
        sveltePluginFactory = mod && (mod.default || mod);
      } catch {}
    }
    if (sveltePluginFactory) {
      plugins.push(
        sveltePluginFactory({
          compilerOptions: {
            generate: mode === 'ssr' ? 'ssr' : 'dom',
            hydratable: true,
            // css handling is internal; avoid unsupported flags across versions
          }
        })
      );
    }
    sourcefile = 'component.svelte';
  }

  try {
    const result = await esbuild.build({
      stdin: {
        contents: code,
        resolveDir: '/',
        sourcefile,
        loader,
      },
      bundle: true,
      write: false,
      platform: 'browser',
      target: 'es2019',
      format: 'iife',
      globalName: '__UF_COMPONENT__',
      logLevel: 'silent',
      plugins,
      define: framework === 'vue' ? {
        '__VUE_OPTIONS_API__': 'true',
        '__VUE_PROD_DEVTOOLS__': 'false'
      } : undefined
    });

    const bundled = result.outputFiles && result.outputFiles[0] ? result.outputFiles[0].text : '';
    if (!bundled) {
      // Надёжный фолбэк, чтобы не допускать зависаний интерфейса
      return { cleanCode: fallbackIIFE(framework, componentName), isIIFE: true } as const;
    }

    const wrapper = `(function(){
${bundled}
  try {
    var m = (typeof __UF_COMPONENT__ !== 'undefined') ? __UF_COMPONENT__ : undefined;
    if (m && m.default) return m.default;
    if (m) return m;
    if (typeof ${componentName} !== 'undefined') return ${componentName};
  } catch (e) {}
  return undefined;
})();`;

    return { cleanCode: wrapper, isIIFE: true };

  } catch (error) {
    if (typeof process !== 'undefined' && process?.env?.USERFACE_ENGINE_DEBUG_TRANSPILE === '1') {
      console.error('esbuild transpilation error:', error);
    }
    // Возвращаем предсказуемый компонент для стабильного превью
    return { cleanCode: fallbackIIFE(framework, componentName), isIIFE: true } as const;
  }
}

/**
 * Server/Node-only: compile an entry file from an in-memory VFS.
 * This is intentionally separated from `transpileToIIFE()` to avoid impacting the current React path.
 *
 * Supports: Vue SFC (.vue) and Svelte (.svelte) with relative imports between VFS files.
 * Returns:
 * - `cleanCode`: executable IIFE which evals to a component constructor/options object (or module-like object).
 * - `styles`: extracted CSS from SFC/Svelte compilation (caller can inject into iframe).
 */
export async function transpileVfsToIIFE(args: {
  files: VfsTextFile[];
  entryPath: string;
  framework: Extract<Framework, 'vue' | 'svelte' | 'react'>;
  mode?: TargetMode;
}): Promise<{ cleanCode: string; styles: string; isIIFE: true }> {
  const esbuild = await getEsbuild();
  const mode = args.mode || 'dom';
  const framework = args.framework;

  // This function is designed for Node. In browser, esbuild-wasm won't be able to resolve node_modules reliably.
  if (typeof window !== 'undefined') {
    throw new Error('transpileVfsToIIFE must run in Node.js');
  }

  const path = _req('path') as typeof import('path');
  const crypto = _req('crypto') as typeof import('crypto');

  const normalizeKey = (p: string): string => {
    const s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    // collapse duplicate slashes
    return s.replace(/\/+/g, '/');
  };

  const entryPath = normalizeKey(args.entryPath);
  const list = Array.isArray(args.files) ? args.files : [];
  const fileMap = new Map<string, string>();
  for (const f of list) {
    const k = normalizeKey(f?.name || '');
    if (!k) continue;
    fileMap.set(k, String(f?.content || ''));
  }
  if (!fileMap.has(entryPath)) {
    throw new Error(`entryPath not found in files: ${entryPath}`);
  }

  const hashId = (s: string) => {
    try {
      return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 8);
    } catch {
      return '00000000';
    }
  };

  const resolveRel = (importer: string, rel: string): string | null => {
    const r = String(rel || '').trim();
    if (!r.startsWith('.')) return null;
    const baseDir = path.posix.dirname(importer);
    const joined = normalizeKey(path.posix.join(baseDir, r));
    const candidates = [
      joined,
      `${joined}.ts`,
      `${joined}.tsx`,
      `${joined}.js`,
      `${joined}.jsx`,
      `${joined}.mjs`,
      `${joined}.cjs`,
      `${joined}.vue`,
      `${joined}.svelte`,
      `${joined}/index.ts`,
      `${joined}/index.tsx`,
      `${joined}/index.js`,
      `${joined}/index.jsx`,
      `${joined}/index.vue`,
      `${joined}/index.svelte`,
    ];
    for (const c of candidates) {
      if (fileMap.has(c)) return c;
    }
    return null;
  };

  const isBareModuleId = (id: string): boolean => {
    const s = String(id || '').trim();
    if (!s) return false;
    if (s.startsWith('.') || s.startsWith('/')) return false;
    if (s.startsWith('http:') || s.startsWith('https:') || s.startsWith('data:')) return false;
    if (s.startsWith('node:')) return false;
    return true;
  };

  const bareModuleRoot = (id: string): string => {
    const s = String(id || '').trim();
    if (!isBareModuleId(s)) return '';
    if (s.startsWith('@')) {
      const parts = s.split('/');
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : s;
    }
    return s.split('/')[0] || s;
  };

  const isForcedExternal = (id: string, forcedBareExternals: Set<string>): boolean => {
    const s = String(id || '').trim();
    if (!isBareModuleId(s)) return false;
    if (forcedBareExternals.has(s)) return true;
    const root = bareModuleRoot(s);
    if (root && forcedBareExternals.has(root)) return true;
    for (const v of forcedBareExternals) {
      const m = String(v || '').trim();
      if (!m) continue;
      if (s === m || s.startsWith(`${m}/`)) return true;
    }
    return false;
  };

  const extractUnresolvedBareImports = (err: any): string[] => {
    const out = new Set<string>();
    const consumeText = (text: string) => {
      const src = String(text || '');
      if (!src) return;
      const rx = /(?:Could not resolve|Cannot resolve)\s+['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(src))) {
        const id = String(m[1] || '').trim();
        if (isBareModuleId(id)) out.add(id);
      }
    };
    try { consumeText(err?.message || ''); } catch {}
    try {
      const errs = Array.isArray(err?.errors) ? err.errors : [];
      for (const e of errs) consumeText(String(e?.text || e?.message || ''));
    } catch {}
    return Array.from(out).sort();
  };

  const entryVirtual = '/' + entryPath;
  const buildOnce = async (forcedBareExternals: Set<string>) => {
    const compiledCssParts: string[] = [];

    const vfsPlugin = {
      name: 'uf-vfs',
      setup(build: any) {
        // Vue runtime is provided in the iframe as a global (`window.Vue`) via `/libs/vue.global.js`.
        // We keep the `vue` module external and shim `require('vue')` in the IIFE wrapper (see below).
        build.onResolve({ filter: /^vue$/ }, () => ({ path: 'vue', external: true }));

        // React runtime is provided in the iframe as globals (`window.React`, `window.ReactDOM`) via `/libs/react*.js`.
        // In React mode we keep `react` and `react-dom*` external (never bundle React itself into user code).
        if (framework === 'react') {
          build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', external: true }));
          build.onResolve({ filter: /^react-dom(?:\/client)?$/ }, (args: any) => ({ path: String(args.path || ''), external: true }));
          // Treat ALL bare imports as externals in React mode. They must be provided by the sandbox externals registry.
          // Keep node_modules resolution intact for vue/svelte paths.
          build.onResolve({ filter: /^[^./][^:]*/ }, (args: any) => ({ path: String(args.path || ''), external: true }));
        }

        // Vue/Svelte resilience path:
        // First compile attempt tries to resolve bare imports normally.
        // If that fails, we retry build with only unresolved bare imports externalized.
        if (framework !== 'react' && forcedBareExternals.size > 0) {
          build.onResolve({ filter: /^[^./].*/, namespace: 'uf-vfs' }, (args: any) => {
            const id = String(args.path || '').trim();
            if (!isForcedExternal(id, forcedBareExternals)) return null;
            return { path: id, external: true };
          });
        }

        // VFS path resolution for relative imports
        // IMPORTANT: scope to our virtual namespace only.
        // Otherwise we break node_modules resolution (Svelte internal code has tons of relative imports).
        build.onResolve({ filter: /^\.\.?\//, namespace: 'uf-vfs' }, (args: any) => {
          const importer = normalizeKey(String(args.importer || ''));
          const rawPath = String(args.path || '');
          const cleaned = rawPath.split('?')[0].split('#')[0];
          const resolved = resolveRel(importer || entryPath, cleaned);
          if (!resolved) {
            return { errors: [{ text: `Cannot resolve '${args.path}' from '${args.importer}'` }] };
          }
          // React mode: treat CSS imports as side-effect only and return empty JS modules (styles are handled separately).
          if (framework === 'react' && /\.css$/i.test(resolved)) {
            return { path: '/' + resolved, namespace: 'uf-css' };
          }
          return { path: '/' + resolved, namespace: 'uf-vfs' };
        });

        if (framework === 'react') {
          build.onLoad({ filter: /.*/, namespace: 'uf-css' }, async (_args: any) => {
            return { contents: `export {};`, loader: 'js', resolveDir: process.cwd() };
          });
        }

        build.onLoad({ filter: /.*/, namespace: 'uf-vfs' }, async (args: any) => {
          const key = normalizeKey(String(args.path || '').replace(/^\/+/, ''));
          const src = String(fileMap.get(key) || '');
          const resolveDir = (() => {
            try {
              // Let esbuild resolve bare imports (e.g. svelte/internal/*) from node_modules.
              return process.cwd();
            } catch {
              return '/';
            }
          })();

          const ext = path.posix.extname(key).toLowerCase();

          // Vue: compile SFC to JS/TS module text using @vue/compiler-sfc (from esbuild-plugin-vue deps).
          if (ext === '.vue') {
            try {
              const sfc = _req('@vue/compiler-sfc');
              const id = hashId(key);
              const parsed = sfc.parse(src, { filename: key });
              const descriptor = parsed && parsed.descriptor ? parsed.descriptor : null;
              const tpl = descriptor && descriptor.template ? descriptor.template.content : '<div></div>';

              // styles
              try {
                const styles = (descriptor && Array.isArray(descriptor.styles)) ? descriptor.styles : [];
                for (const st of styles) {
                  if (!st || !st.content) continue;
                  compiledCssParts.push(String(st.content || ''));
                }
              } catch {}

              // script (supports <script setup> via compileScript)
              const script = sfc.compileScript(descriptor, { id });
              const tplRes = sfc.compileTemplate({
                source: tpl,
                filename: key,
                id,
                // IMPORTANT: we generate ESM code (not `return function render(){}`) because esbuild bundles modules.
                // SSR is controlled via the top-level `ssr` option.
                compilerOptions: { mode: 'module' },
                ssr: mode === 'ssr',
              });
              if (tplRes && tplRes.errors && tplRes.errors.length) {
                throw new Error(String(tplRes.errors[0]?.message || tplRes.errors[0] || 'Vue template compile error'));
              }

              // `script.content` is ESM. We stitch render in and ensure there is exactly ONE default export.
              let scriptText = String(script && script.content ? script.content : '');
              const hasSfcVar = /\bconst\s+__sfc__\b/.test(scriptText) || /\blet\s+__sfc__\b/.test(scriptText) || /\bvar\s+__sfc__\b/.test(scriptText);
              if (hasSfcVar) {
                // Drop `export default __sfc__` (or rewrite other default exports to assign into __sfc__).
                scriptText = scriptText.replace(/\bexport\s+default\s+__sfc__\s*;?/g, '');
                scriptText = scriptText.replace(/\bexport\s+default\s+/g, '__sfc__ = ');
              } else {
                // Create __sfc__ from the default export.
                scriptText = scriptText.replace(/\bexport\s+default\s+/g, 'const __sfc__ = ');
              }

              const renderName = mode === 'ssr' ? 'ssrRender' : 'render';
              const attach =
                mode === 'ssr'
                  ? `\n;try{ __sfc__.ssrRender = ${renderName}; }catch(_){ }\n`
                  : `\n;try{ __sfc__.render = ${renderName}; }catch(_){ }\n`;

              const out =
                `${scriptText}\n` +
                `${String(tplRes && tplRes.code ? tplRes.code : '')}\n` +
                `${attach}` +
                `\nexport default __sfc__;\n`;

              return { contents: out, loader: 'ts', resolveDir };
            } catch (e: any) {
              return { errors: [{ text: e?.message || String(e) }] };
            }
          }

          // Svelte: compile to JS module using svelte/compiler.
          if (ext === '.svelte') {
            try {
              const svelte = _req('svelte/compiler');
              const compiled = svelte.compile(src, {
                filename: key,
                generate: mode === 'ssr' ? 'ssr' : 'dom',
                hydratable: true,
                // Svelte v5: css option is string ("external" | "injected")
                css: 'external',
              });
              try {
                const css = compiled && compiled.css && compiled.css.code ? String(compiled.css.code) : '';
                if (css) compiledCssParts.push(css);
              } catch {}
              const js = compiled && compiled.js && compiled.js.code ? String(compiled.js.code) : '';
              if (!js) throw new Error('Svelte compiler produced empty JS');
              return { contents: js, loader: 'js', resolveDir };
            } catch (e: any) {
              return { errors: [{ text: e?.message || String(e) }] };
            }
          }

          // Regular TS/JS files
          const loader =
            ext === '.tsx' ? 'tsx' :
            ext === '.ts' ? 'ts' :
            ext === '.jsx' ? 'jsx' :
            'js';
          return { contents: src, loader, resolveDir };
        });
      }
    };

    const buildResult = await esbuild.build({
      entryPoints: [entryVirtual],
      bundle: true,
      write: false,
      platform: 'browser',
      target: 'es2019',
      format: 'iife',
      globalName: '__UF_COMPONENT__',
      plugins: [
        vfsPlugin,
        // Seed entry resolution
        {
          name: 'uf-entry-seed',
          setup(build: any) {
            build.onResolve(
              { filter: new RegExp('^' + entryVirtual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') },
              () => ({ path: entryVirtual, namespace: 'uf-vfs' })
            );
          }
        }
      ],
      define: framework === 'vue' ? {
        '__VUE_OPTIONS_API__': 'true',
        '__VUE_PROD_DEVTOOLS__': 'false'
      } : undefined
    });

    const bundled = buildResult.outputFiles && buildResult.outputFiles[0] ? String(buildResult.outputFiles[0].text || '') : '';
    if (!bundled.trim()) throw new Error('esbuild produced empty bundle');
    return { bundled, styles: compiledCssParts.filter(Boolean).join('\n') };
  };

  let buildOut: { bundled: string; styles: string };
  try {
    buildOut = await buildOnce(new Set<string>());
  } catch (e: any) {
    const retryWithExternals = framework !== 'react' ? extractUnresolvedBareImports(e) : [];
    if (retryWithExternals.length === 0) throw e;
    buildOut = await buildOnce(new Set<string>(retryWithExternals));
  }

  const bundled = String(buildOut.bundled || '');

  const requireShim = requireShimForFramework(framework as any);

  const wrapper = `(function(){\n${requireShim}${bundled}\n  try {\n    var m = (typeof __UF_COMPONENT__ !== 'undefined') ? __UF_COMPONENT__ : undefined;\n    if (m && m.default) return m.default;\n    if (m) return m;\n  } catch (e) {}\n  return undefined;\n})();`;

  return { cleanCode: wrapper, isIIFE: true, styles: String(buildOut.styles || '') };
}

function fallbackIIFE(framework: Framework, componentName: string): string {
  if (framework === 'vue') {
    // Возвращаем простой Vue-компонент с render-функцией; Vue будет подключён позже на странице
    return `(
      function(){
        return {
          name: ${JSON.stringify(componentName)},
          props: { _placeholder: { type: String, required: false } },
          render(){
            return (typeof Vue !== 'undefined' && Vue && Vue.h)
              ? Vue.h('div', { 'data-uf-fallback': '1' }, 'Vue Preview')
              : null;
          }
        };
      }
    )();`;
  }
  if (framework === 'svelte') {
    // Минимально совместимый класс под API Svelte компонента в браузере
    return `(
      function(){
        class FallbackSvelteComponent {
          constructor(opts){
            this.$$ = { target: opts && opts.target ? opts.target : null };
            if (this.$$.target) {
              this.$$.target.innerHTML = '<div data-uf-fallback="1">Svelte Preview</div>';
            }
          }
          $destroy(){ if (this.$$.target) this.$$.target.innerHTML = ''; }
          $set(){ /* noop */ }
        }
        return FallbackSvelteComponent;
      }
    )();`;
  }
  // React по умолчанию пойдёт через основной путь; здесь возвращаем пустую функцию
  return `(
    function(){
      return function UFComponent(){ return null };
    }
  )();`;
}
