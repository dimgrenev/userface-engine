import type {
  EngineAnalyzeFile,
  EngineEntryPathOptions,
  EngineRenderMode,
  EngineRenderResult,
  UfErrorPayload,
} from './public-types';

import { CoreEngine, type ComponentProp } from './core-engine';
import { BabelTransformer, ZodValidator, ReactRenderer, VueRenderer, SvelteRenderer } from './adapters/core-adapters';
import { generateStates as _generateStates, type StateEntry, type GenerateStatesOptions } from './stateMatrix';

export type CreateEngineOptions = {
  Babel?: any;
  zodPropsValidator?: any;
  React?: any;
  ReactDOMServer?: any;
  Vue?: any;
  VueServerRenderer?: any;
  Svelte?: any;
  debug?: boolean;
};

export type EngineInstance = {
  analyzeComponent: (files: EngineAnalyzeFile[], options: EngineEntryPathOptions) => Promise<any>;
  renderFromSpec: (specId: string, props: any, mode?: EngineRenderMode) => Promise<EngineRenderResult>;
  generateStates: (props: ComponentProp[], options?: GenerateStatesOptions) => StateEntry[];
  getDiagnostics: () => any;
};

function toUfErrorPayload(e: any, fallback: Partial<UfErrorPayload> = {}): UfErrorPayload {
  const message = String(e?.message || e || 'Unknown error');
  const code = String(e?.code || e?.uf?.code || fallback.code || 'UF400');
  const phase = String(e?.phase || e?.uf?.phase || fallback.phase || 'unknown');
  const owner = String(e?.owner || e?.uf?.owner || fallback.owner || 'engine');
  const details = e?.details || e?.uf?.details || fallback.details;
  return { code: code as any, phase, owner, message, details };
}

/**
 * npm-friendly engine constructor.
 * - No reliance on window.* as API
 * - Uses dependency injection for runtimes
 */
export function createEngine(options: CreateEngineOptions = {}): EngineInstance {
  const transformer = new BabelTransformer(options.Babel || null);
  const validator = new ZodValidator(options.zodPropsValidator || null);
  const renderers = {
    react: new ReactRenderer(options.React || null, options.ReactDOMServer || null),
    vue: new VueRenderer(options.Vue || undefined, options.VueServerRenderer || undefined),
    svelte: new SvelteRenderer(options.Svelte || undefined),
  };

  const core = new CoreEngine({ transformer, validator, renderers } as any);
  const debug = !!options.debug;
  const diagnostics: any = { debug, createdAt: Date.now() };

  return {
    async analyzeComponent(files, entry) {
      try {
        if (!entry || !entry.entryPath) throw new Error('entryPath is required');
        diagnostics.lastAnalyze = { entryPath: entry.entryPath, files: files?.length || 0 };
        return await (core as any).analyzeComponent(files as any, { entryPath: entry.entryPath });
      } catch (e) {
        throw toUfErrorPayload(e, { code: 'UF200' as any, phase: 'engine_analyze', owner: 'engine', details: { entry } });
      }
    },
    async renderFromSpec(specId, props, mode = 'live') {
      try {
        diagnostics.lastRender = { specId, mode };
        const r: any = await (core as any).renderFromSpec(specId, props, mode);
        // Prefer stable contract fields if present.
        if (r && typeof r === 'object' && r.type && r.data) {
          return { type: String(r.type), data: r.data } as EngineRenderResult;
        }
        // Back-compat mapping: CoreEngine historically returned { success, html, logs }
        const html = String(r?.html || '');
        return {
          type: 'render-result',
          data: {
            componentCode: (mode === 'live') ? html : '',
            componentName: String(specId || 'Component'),
            html: (mode === 'ssr') ? html : undefined,
            styles: '',
            props: props || {},
            files: [],
            diagnostics: null,
          }
        } as EngineRenderResult;
      } catch (e) {
        throw toUfErrorPayload(e, { code: 'UF400' as any, phase: 'engine_render', owner: 'engine', details: { specId, mode } });
      }
    },
    generateStates(props, opts) {
      return _generateStates(props, opts);
    },
    getDiagnostics() {
      return diagnostics;
    },
  };
}


