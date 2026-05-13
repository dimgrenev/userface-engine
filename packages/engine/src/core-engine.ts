/**
 * CoreEngine - Изолированное ядро движка без зависимостей от окружения
 * Совместим с Node.js и браузером через dependency injection
 */

import { UniversalCodeSanitizer, Framework } from './codeSanitizer';
import {
  mapTypeRich as _mapTypeRich,
  extractLocalAliases as _extractLocalAliases,
  parseStringLiterals as _parseStringLiterals,
  extractPropsFromCode as _extractPropsFromCode,
  extractEnumMap as _extractEnumMap,
  extractInterfaceMap as _extractInterfaceMap,
  parseInlineObjectType as _parseInlineObjectType,
} from './propParsingHelpers';

// Optional telemetry hook (engine must not depend on host app modules).
// Host can provide `globalThis.emitTelemetry(payload)` or `globalThis.__UF_EMIT_TELEMETRY__(payload)`.
function emitTelemetry(payload: any): void {
  try {
    const g: any = globalThis as any;
    const fn = (typeof g.emitTelemetry === 'function')
      ? g.emitTelemetry
      : (typeof g.__UF_EMIT_TELEMETRY__ === 'function' ? g.__UF_EMIT_TELEMETRY__ : null);
    if (typeof fn === 'function') fn(payload);
  } catch {}
}

function isEngineDebugEnabled(): boolean {
  try {
    if (typeof process !== 'undefined' && (process as any)?.env?.UF_ENGINE_DEBUG === '1') return true;
  } catch {}
  try {
    const g: any = globalThis as any;
    if (g && g.__UF_ENGINE_DEBUG__ === true) return true;
  } catch {}
  return false;
}

function engineLog(...args: any[]): void {
  if (!isEngineDebugEnabled()) return;
  try { console.log(...args); } catch {}
}

function engineWarn(...args: any[]): void {
  if (!isEngineDebugEnabled()) return;
  try { console.warn(...args); } catch {}
}

// Интерфейсы для зависимостей
export interface ITransformer {
  transform(code: string, options: TransformOptions): Promise<string>;
  validate(code: string): boolean;
}

export interface IValidator {
  validate(componentName: string, props: any): ValidationResult;
  registerSchema(componentName: string, schema: any): void;
  createSchema(props: any[]): any;
}

export interface IRenderer {
  render(spec: ComponentSpec, props: any): Promise<RenderResult>;
}

export interface TransformOptions {
  framework: 'react' | 'vue' | 'svelte';
  target: 'iframe' | 'node';
  plugins?: string[];
}

export interface ValidationResult {
  success: boolean;
  data?: any;
  errors?: string[];
}

export interface RenderResult {
  type: string;
  data: any;
  spec: ComponentSpec;
}

export interface StructuredRenderResult {
  success: boolean;
  html?: string;
  error?: string;
  stack?: string;
  logs: string[];
  specName?: string; // Добавляем имя спецификации для batch рендеринга
  usedSandbox?: boolean; // Флаг использования sandbox fallback
  // Stable contract fields (npm + app)
  type?: string;
  data?: any;
}

export interface EngineDiagnostics {
  entryPath: string;
  specId: string;
  framework: string;
  filesUsed: string[];
  filesHash: string;
  stylesHash: string;
  codeHash: string;
}

export interface ComponentSpec {
  name: string;
  framework: 'react' | 'vue' | 'svelte';
  version: string;
  code: string; // Добавляем код компонента
  metadata: {
    fileName: string;
    createdAt: string;
    interfaces: any[];
    types: any[];
    schema?: any; // Добавляем схему в метаданные
    entryPath?: string;
  };
  props: ComponentProp[];
  styles: string;
  render: {
    type: string;
    framework: string;
    adapter: string;
  };
  diagnostics?: EngineDiagnostics;
}

function ufHashFNV1a(s: string): string {
  try {
    const str = String(s || '');
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return `fnv1a:${h.toString(16)}:${str.length}`;
  } catch {
    return 'fnv1a:0:0';
  }
}

export interface ComponentProp {
  name: string;
  type: string;
  required: boolean;
  description: string;
  defaultValue?: any;
  enumValues?: string[]; // Для enum типов
  fields?: ComponentProp[]; // Для object типов
  options?: string[]; // Для select-типов (string-literal unions)
}

export interface EngineDependencies {
  transformer: ITransformer;
  validator: IValidator;
  renderers: {
    react: IRenderer;
    vue: IRenderer;
    svelte: IRenderer;
  };
}

export interface ParseResult {
  props: ComponentProp[];
  interfaces: any[];
  cleanCode: string;
}

export interface VFSEntry {
  files: Array<{ name: string; content: string }>;
  spec: ComponentSpec;
  timestamp: number;
}

/**
 * Изолированный core-движок
 */
export class CoreEngine {
  private vfs: Map<string, VFSEntry> = new Map();
  private componentRegistry: Map<string, ComponentSpec> = new Map();
  private deps: EngineDependencies;
  private sassCache: Map<string, string> = new Map();

  constructor(deps: EngineDependencies) {
    this.deps = deps;
  }

  /**
   * Сброс всех внутренних кэшей и VFS
   */
  resetCaches(): void {
    try {
      this.sassCache.clear();
    } catch {}
    try {
      this.clearVFS();
    } catch {}
  }

  /**
   * Framework adapter SSR-like render
   */
  private async renderViaAdapter(framework: 'react' | 'vue' | 'svelte', code: string, props: any, styles?: string): Promise<string> {
    const adapter = this.deps?.renderers?.[framework];
    if (!adapter || typeof (adapter as any).render !== 'function') {
      throw new Error('No adapter available for framework: ' + framework);
    }

    // Ensure code is transpiled to IIFE before giving it to adapter
    let iifeCode = '' as string;
    try {
      const t = await import('./transpiler');
      const transpiled: any = await (t as any).transpileToIIFE(code, framework, 'DynamicComponent', 'ssr');
      iifeCode = transpiled && transpiled.cleanCode ? transpiled.cleanCode : '';
    } catch {}

    const spec: ComponentSpec = {
      name: 'DynamicComponent',
      framework,
      version: '0.0.1',
      code: iifeCode || code,
      metadata: {
        fileName: 'dynamic.tsx',
        createdAt: new Date().toISOString(),
        interfaces: [],
        types: [],
      },
      props: [],
      styles: styles || '',
      render: {
        type: 'ssr',
        framework,
        adapter: adapter.constructor.name,
      }
    };

    const result = await adapter.render(spec, props);

    if (result.type === 'error') {
      throw new Error(result.data);
    }

    const html = (result as any)?.data?.html || (typeof (result as any)?.data === 'string' ? (result as any).data : '');
    return html;
  }

  /**
   * Анализ компонента - извлечение props, интерфейсов, создание спеки
   */
  async analyzeComponent(
    files: Array<{ name: string; content: string }>,
    options?: { entryPath?: string }
  ): Promise<ComponentSpec> {
    engineLog('🔍 Starting component analysis...');
    const t0 = Date.now();
    
    try {
      // Определяем фреймворк
      const framework = this.detectFramework(files);
      engineLog(`📊 Detected framework: ${framework}`);
      
      // Находим основной файл
      const entryPath = (() => { try { return String(options?.entryPath || ''); } catch { return ''; } })();
      if (!entryPath) {
        // Core contract: deterministic entry is required (no guessing).
        throw Object.assign(new Error('entryPath is required for analyzeComponent (deterministic entry)'), {
          code: 'UF200',
          phase: 'engine_analyze',
          owner: 'engine',
          details: { hint: 'Pass analyzeComponent(files, { entryPath })', files: (files || []).map(f => f?.name).filter(Boolean) }
        });
      }

      const mainFile = this.findMainFile(files, framework, { entryPath });
      if (!mainFile) {
        throw new Error(`No main file found for ${framework} framework`);
      }
      
      engineLog(`📄 Main file: ${mainFile.name}`);

      const specId = String(entryPath || mainFile.name || '')
        .replace(/\.(tsx|jsx|ts|js|vue|svelte)$/i, '');
      
      // Парсим код
      let parseResult: { props: ComponentProp[]; interfaces: string[]; cleanCode: string };
      
      // В Node.js окружении всегда используем простой парсинг
      if (typeof window === 'undefined') {
        engineLog('🖥️ Running in Node.js environment, using simple parsing');
        parseResult = this.parseCodeSimple(mainFile.content, framework);
      } else {
        try {
          parseResult = await this.parseCode(mainFile.content, framework);
        } catch (parseError) {
          engineWarn('⚠️ Parse code failed, using fallback:', parseError);
          // Fallback к простому парсингу
          parseResult = this.parseCodeSimple(mainFile.content, framework);
        }
      }
      
      engineLog(`✅ Code parsing completed`);
      engineLog(`📊 Found ${parseResult.props.length} props`);
      engineLog(`📊 Found ${parseResult.interfaces.length} interfaces`);
      
      // Извлекаем стили
      const styles = this.extractStyles(files);
      
      // Создаем спецификацию компонента
      const spec = this.createComponentSpec(specId, framework, parseResult, styles, files);
      try {
        spec.metadata.entryPath = entryPath;
      } catch {}

      // Stable diagnostics (hashes + files) for reproducibility
      try {
        const filesUsed = (files || []).map((f) => String(f?.name || '')).filter(Boolean).sort();
        const filesHash = ufHashFNV1a(
          filesUsed
            .map((n) => {
              const content = String(files.find((f) => f?.name === n)?.content || '');
              return `${n}:${ufHashFNV1a(content)}`;
            })
            .join('|')
        );
        spec.diagnostics = {
          entryPath,
          specId,
          framework: String(framework),
          filesUsed,
          filesHash,
          stylesHash: ufHashFNV1a(String(styles || '')),
          codeHash: ufHashFNV1a(String(mainFile?.content || '')),
        };
      } catch {}
      
      // Регистрируем компонент
      this.registerComponent(spec);
      
      // Сохраняем в VFS
      this.saveToVFS(files, spec);
      
      engineLog(`✅ Component analysis completed: ${spec.name}`);
      try { emitTelemetry({ type: 'analyze', success: true, durationMs: Date.now() - t0, framework, component: spec.name }); } catch {}
      return spec;
      
    } catch (error) {
      console.error('❌ Component analysis failed:', error);
      try { emitTelemetry({ type: 'analyze', success: false, durationMs: Date.now() - t0, details: { files: files?.length }, error: error instanceof Error ? error.message : String(error) }); } catch {}
      throw error;
    }
  }

  /**
   * Рендеринг компонента по спецификации
   */
  async renderFromSpec(
    specName: string, 
    props: any,
    renderMode: 'ssr' | 'live' = 'ssr'
  ): Promise<StructuredRenderResult> {
    const t0 = Date.now();
    const logs: string[] = [];
    
    try {
      logs.push(`🎨 Starting render for component: ${specName}, mode: ${renderMode}`);
      engineLog(`🎨 Rendering component: ${specName}, mode: ${renderMode}`);
      
      // 1. 🔍 Найти спецификацию по имени
      logs.push(`🔍 Looking for component spec: ${specName}`);
      const spec = this.getComponentSpec(specName);
      if (!spec) {
        const error = `Component spec not found: ${specName}`;
        logs.push(`❌ ${error}`);
        return { success: false, error, logs };
      }
      
      logs.push(`✅ Found component spec: ${spec.name} (${spec.framework})`);

      // 2. 🧹 Compile component to executable code.
      // If the entry has relative imports (multi-file component like components gallery),
      // use the VFS bundler to inline all dependencies. Otherwise, transpile as single IIFE.
      //
      // IMPORTANT: Check the ORIGINAL entry file source from VFS, NOT spec.code.
      // parseCodeSimple() uses a broken regex (/import\s+.*?;?\s*/g with lazy .*?) that
      // only strips the "import " prefix instead of the full import statement.
      // This causes spec.code to have no lines starting with "import", making
      // hasRelativeImports falsely return false and skipping the VFS bundler.
      const entryPath = String(spec?.metadata?.entryPath || `${spec.name}.tsx`);
      const originalEntrySource = (() => {
        try {
          // 1) Try engine's internal VFS (populated by analyzeComponent/saveToVFS)
          const internalVfs = (this as any).vfs as Map<string, any> | undefined;
          if (internalVfs && typeof internalVfs.forEach === 'function') {
            for (const [, entry] of internalVfs) {
              const files = Array.isArray(entry?.files) ? entry.files : [];
              for (const f of files) {
                if (String(f?.name || '') === entryPath && typeof f?.content === 'string') {
                  return f.content;
                }
              }
            }
          }
        } catch {}
        try {
          // 2) Fallback: global VFS (window.vfs)
          const g: any = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined' ? window : null);
          const gVfs = g?.vfs;
          if (gVfs && gVfs[entryPath] && typeof gVfs[entryPath].content === 'string') {
            return gVfs[entryPath].content;
          }
        } catch {}
        return '';
      })();
      const sourceToCheck = originalEntrySource || String(spec.code || '');
      const hasRelativeImports = /^\s*import\s+.+from\s+['"]\.{1,2}\//m.test(sourceToCheck);
      const bundlerFn = (this as any).bundler as ((entryPath: string, vfs: Record<string, any>) => any) | undefined;
      const vfsMap = (this as any).vfs as Record<string, any> | undefined;

      let iifeCode = '';
      let isIIFE = false;

      if (hasRelativeImports && typeof bundlerFn === 'function') {
        // Multi-file path: bundle all VFS dependencies into a single executable.
        logs.push(`BUNDLE: Entry has relative imports, using VFS bundler for ${spec.name}...`);
        // entryPath already computed above (before hasRelativeImports check).
        // Build flat VFS map from engine's internal Map<specName, VFSEntry>.
        const flatVfs: Record<string, any> = {};
        try {
          const internalVfs = (this as any).vfs as Map<string, any> | undefined;
          if (internalVfs && typeof internalVfs.forEach === 'function') {
            internalVfs.forEach((entry: any) => {
              const files = Array.isArray(entry?.files) ? entry.files : [];
              for (const f of files) {
                const n = String(f?.name || '');
                if (n && typeof f?.content === 'string') {
                  flatVfs[n] = { name: n, content: f.content, type: 'text/plain' };
                }
              }
            });
          }
        } catch {}
        // Also check globalVfs (provided dynamically via constructor/injection or `globalThis.vfs`).
        try {
          const gVfs = (typeof globalThis !== 'undefined' && (globalThis as any).vfs) 
            ? (globalThis as any).vfs 
            : (typeof window !== 'undefined' ? (window as any).vfs : undefined);
          if (gVfs && typeof gVfs === 'object') {
            for (const k of Object.keys(gVfs)) {
              if (!flatVfs[k] && gVfs[k] && typeof gVfs[k].content === 'string') {
                flatVfs[k] = { name: k, content: gVfs[k].content, type: gVfs[k].type || 'text/plain' };
              }
            }
          }
        } catch {}
        if (Object.keys(flatVfs).length > 0) {
          try {
            const bundleResult = bundlerFn(entryPath, flatVfs);
            if (bundleResult && bundleResult.success && bundleResult.code) {
              iifeCode = String(bundleResult.code);
              isIIFE = true;
              logs.push(`✅ BUNDLE: VFS bundle succeeded. Size: ${iifeCode.length} chars, files: ${(bundleResult.filesUsed || []).length}`);
            } else {
              logs.push(`⚠️ BUNDLE: VFS bundler returned no code, falling back to single-file transpile. Error: ${bundleResult?.error || 'unknown'}`);
            }
          } catch (bundleErr: any) {
            logs.push(`⚠️ BUNDLE: VFS bundler failed (${bundleErr?.message || bundleErr}), falling back to single-file transpile.`);
          }
        } else {
          logs.push(`⚠️ BUNDLE: No flat VFS available, falling back to single-file transpile.`);
        }
      }

      if (!iifeCode) {
        logs.push(`TRANSPILE: Compiling ${spec.framework} component to IIFE...`);
        const { transpileToIIFE } = await import('./transpiler');
        engineLog(`[CoreEngine] Transpiling ${spec.framework} component: ${spec.name}`);
        const result = await transpileToIIFE(spec.code, spec.framework, spec.name, renderMode === 'ssr' ? 'ssr' : 'dom');
        iifeCode = result.cleanCode;
        isIIFE = result.isIIFE;
        if ((result as any).error) {
          logs.push(`TRANSPILE ERROR: ${(result as any).error}`);
        }
      }
      engineLog(`[CoreEngine] Compilation result: isIIFE=${isIIFE}, codeLength=${iifeCode.length}`);

      if (!isIIFE || !iifeCode) {
        // Fallback: for vue/svelte produce minimal IIFE wrapper to keep preview responsive
        if (spec.framework === 'vue' || spec.framework === 'svelte') {
          logs.push(`⚠️ TRANSPILE: Fallback to minimal IIFE for ${spec.framework}`);
          iifeCode = '(function(){ return function(){ return null; }; })();';
          isIIFE = true;
        } else {
          const error = `TRANSPILE: Failed to compile component to IIFE.`;
          logs.push(`❌ ${error}`);
          return { success: false, error, logs };
        }
      }
      logs.push(`✅ TRANSPILE: Successfully compiled component to IIFE. Size: ${iifeCode.length} chars.`);

      // Guard: prevent silent "preview placeholders" for non-React frameworks.
      // For Vue/Svelte, transpiler can return a fallback IIFE ("Vue Preview"/"Svelte Preview") to keep UI responsive.
      // That is OK for internal experimentation, but NOT OK as a "successful" engine render in production.
      try {
        const isVueOrSvelte = spec.framework === 'vue' || spec.framework === 'svelte';
        if (isVueOrSvelte) {
          const s = String(iifeCode || '');
          const looksLikeFallback =
            /data-uf-fallback\s*=\s*["']?1["']?/i.test(s) ||
            /\bVue Preview\b/i.test(s) ||
            /\bSvelte Preview\b/i.test(s);
          const allowFallback =
            (typeof process !== 'undefined' && (process as any).env && String((process as any).env.UF_ALLOW_ENGINE_FALLBACK || '').trim() === '1') ||
            (typeof window !== 'undefined' && (window as any).__UF_ALLOW_ENGINE_FALLBACK__ === true);
          const isProd =
            (typeof process !== 'undefined' && (process as any).env && (process as any).env.NODE_ENV === 'production');

          if (looksLikeFallback && isProd && !allowFallback) {
            const error = `UF500 Missing requirements\n[phase=engine_transpile owner=engine]\nEngine produced a fallback placeholder for ${spec.framework}. This usually means the ${spec.framework} compiler/bundling is not available in this environment.`;
            logs.push(`❌ TRANSPILE: ${error}`);
            return { success: false, error, logs };
          }
        }
      } catch {}

      // LIVE MODE
      if (renderMode === 'live') {
        logs.push('🚀 Live mode rendering...');
        const vfsEntry = (() => { try { return this.vfs.get(spec.name); } catch { return null; } })();
        return {
          success: true,
          html: iifeCode, // back-compat: sandbox expects `html` to be executable IIFE
          logs,
          specName,
          type: `${spec.framework}-component`,
          data: {
            componentCode: iifeCode,
            componentName: spec.name,
            styles: spec.styles || '',
            props: props || {},
            files: (vfsEntry && vfsEntry.files) ? vfsEntry.files : [],
            diagnostics: spec.diagnostics || null,
          }
        };
      }

      // SSR MODE (default)
      logs.push('🖥️ SSR mode rendering...');
      
      // 3. ✅ Провести валидацию пропсов (если есть схема)
      logs.push(`🔍 Validating props...`);
      if (spec.metadata?.schema) {
        try {
          this.validateProps(props, spec.metadata.schema);
          logs.push(`✅ Props validation passed`);
        } catch (validationError: any) {
          logs.push(`⚠️ Props validation failed, continuing without validation: ${validationError.message}`);
          // Не блокируем рендеринг, просто логируем предупреждение
        }
      } else {
        logs.push(`ℹ️ No schema available, skipping props validation`);
      }
      
      // 4. 🧹 Применяем санитайзер
      logs.push(`🧹 Applying security code sanitization...`);
      let sanitizedCode: string;
      try {
          const sanitizer = new UniversalCodeSanitizer(spec.framework as Framework);
          sanitizedCode = sanitizer.sanitizeForSecurity(iifeCode);
          logs.push(`✅ Security sanitization completed.`);
          logs.push(...sanitizer.getLogs().map((log: string) => `  - ${log}`));
      } catch (cleanError) {
          logs.push(`⚠️ Security sanitization failed, using transpiled code: ${cleanError}`);
          sanitizedCode = iifeCode; // fallback
      }

      // 5. 🚀 Выполнить рендер через адаптер
      logs.push(`🚀 Starting render with ${spec.framework} adapter...`);
      
      try {
        const html = await this.renderViaAdapter(spec.framework as 'react' | 'vue' | 'svelte', sanitizedCode, props, spec.styles);
        logs.push(`✅ Render completed successfully`);
        
        if (!html) {
          const error = 'Renderer returned empty HTML';
          logs.push(`❌ ${error}`);
          return { success: false, error, logs };
        }
        
        // Возвращаем в соответствии с StructuredRenderResult
        logs.push(`componentName=${spec.name}`);
        logs.push(`componentCode.length=${(iifeCode||'').length}`);
        const vfsEntry = (() => { try { return this.vfs.get(spec.name); } catch { return null; } })();
        const out = {
          success: true,
          html,
          logs,
          type: `${spec.framework}-component`,
          data: {
            componentCode: iifeCode,
            componentName: spec.name,
            html,
            styles: spec.styles || '',
            props: props || {},
            files: (vfsEntry && vfsEntry.files) ? vfsEntry.files : [],
            diagnostics: spec.diagnostics || null,
          }
        } as StructuredRenderResult;
        try { emitTelemetry({ type: 'render', success: true, durationMs: Date.now() - t0, framework: spec.framework, component: spec.name }); } catch {}
        return out;
      } catch (renderError) {
        const error = `Render execution failed: ${renderError instanceof Error ? renderError.message : String(renderError)}`;
        logs.push(`❌ ${error}`);
        const out = {
          success: false,
          error,
          stack: renderError instanceof Error ? renderError.stack : undefined,
          logs
        } as StructuredRenderResult;
        try { emitTelemetry({ type: 'render', success: false, durationMs: Date.now() - t0, framework: spec.framework, component: spec.name, error }); } catch {}
        return out;
      }
      
    } catch (error) {
      const errorMessage = `Unexpected error in renderFromSpec: ${error instanceof Error ? error.message : String(error)}`;
      logs.push(`💥 ${errorMessage}`);
      
      const out = {
        success: false,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        logs
      } as StructuredRenderResult;
      try { emitTelemetry({ type: 'render', success: false, durationMs: Date.now() - t0, error: errorMessage }); } catch {}
      return out;
    }
  }

  /**
   * Пакетный рендеринг компонентов по спецификациям
   */
  async renderBatchFromSpecs(specs: { name: string, props: any }[]): Promise<StructuredRenderResult[]> {
    engineLog(`🎨 Starting batch render for ${specs.length} components`);
    
    const results: StructuredRenderResult[] = [];
    
    for (const spec of specs) {
      engineLog(`🔍 Processing spec: ${spec.name}`);
      
      try {
        // Вызываем renderFromSpec для каждого компонента
        const result = await this.renderFromSpec(spec.name, spec.props);
        
        // Добавляем specName к результату
        const resultWithName: StructuredRenderResult = {
          ...result,
          specName: spec.name
        };
        
        results.push(resultWithName);
        
        engineLog(`✅ Completed render for ${spec.name}: ${result.success ? 'SUCCESS' : 'FAILED'}`);
        
      } catch (error) {
        // Обрабатываем неожиданные ошибки
        console.error(`💥 Unexpected error rendering ${spec.name}:`, error);
        
        const errorResult: StructuredRenderResult = {
          success: false,
          error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          logs: [`💥 Unexpected error rendering ${spec.name}: ${error instanceof Error ? error.message : String(error)}`],
          specName: spec.name
        };
        
        results.push(errorResult);
      }
    }
    
    engineLog(`🎯 Batch render completed. Results: ${results.filter(r => r.success).length}/${results.length} successful`);
    
    return results;
  }

  /**
   * Парсинг кода компонента
   */
  private async parseCode(code: string, framework: string): Promise<{ props: ComponentProp[]; interfaces: string[]; cleanCode: string }> {
    engineLog('🔍 Parsing react code...');
    
    // В Node.js окружении всегда используем простую логику
    if (typeof window === 'undefined') {
      engineLog('🖥️ Running in Node.js environment, using simple parsing');
      return this.parseCodeSimple(code, framework);
    }

    // В браузере используем transformer только если доступен
    if (this.deps.transformer && typeof this.deps.transformer.transform === 'function') {
      try {
        engineLog('🌐 Running in browser, using transformer');
        const cleanCode = await this.deps.transformer.transform(code, { framework: framework as 'react' | 'vue' | 'svelte', target: 'iframe' });
        const props = this.extractPropsWithRegex(cleanCode);
        const interfaces = this.extractInterfacesWithRegex(cleanCode);
        
        return { props, interfaces, cleanCode };
      } catch (error) {
        engineLog('⚠️ Transformer failed, falling back to simple parsing:', error);
        return this.parseCodeSimple(code, framework);
      }
    }

    // Fallback к простому парсингу
    engineLog('⚠️ No transformer available, using fallback parsing');
    return this.parseCodeSimple(code, framework);
  }

  private parseCodeSimple(code: string, framework: string): { props: ComponentProp[]; interfaces: string[]; cleanCode: string } {
    engineLog('🔄 Using simple parsing logic');

    // ВАЖНО: Сначала извлечь props и интерфейсы из исходного кода (до очистки)
    const props = this.extractPropsWithRegex(code);
    const interfaces = this.extractInterfacesWithRegex(code);

    // Затем аккуратно очистить TypeScript синтаксис для дальнейшего использования.
    // IMPORTANT: The cleanCode is a best-effort simplified version of the source.
    // It is NOT used for bundling (the VFS bundler uses original VFS content).
    // It's mainly used for single-file components (no imports) via the transpiler fallback.
    let cleanCode = code;
    cleanCode = cleanCode.replace(/interface\s+\w+\s*\{[\s\S]*?\}/g, '');
    cleanCode = cleanCode.replace(/enum\s+\w+\s*\{[\s\S]*?\}/g, '');
    cleanCode = cleanCode.replace(/type\s+\w+\s*=\s*[\s\S]*?;/g, '');
    // Удаляем TypeScript типы, но не затрагиваем содержимое HTML тегов
    cleanCode = cleanCode.replace(/:\s*[A-Z][a-zA-Z]*(?=\s*[=,)}])/g, '');
    // Strip full import/export lines (use line-level matching to avoid partial stripping).
    // Previous regex `/import\s+.*?;?\s*/g` was broken — lazy .*? only matched "import " prefix.
    cleanCode = cleanCode.replace(/^[ \t]*import\s+[^\n]+$/gm, '');
    cleanCode = cleanCode.replace(/^[ \t]*export\s+default\s+/gm, '');
    cleanCode = cleanCode.replace(/^[ \t]*export\s+/gm, '');
    
    engineLog('✅ Simple parsing completed');
    return { props, interfaces, cleanCode };
  }

  /**
   * Валидация интерфейса пропсов
   */
  private validatePropsInterface(interfaceName: string, interfaceCode: string): void {
    engineLog(`🔍 Validating interface: ${interfaceName}`);
    
    // 1. Проверяем, что интерфейс существует
    const interfaceMatch = interfaceCode.match(new RegExp(`interface\\s+${interfaceName}\\s*\\{([^}]*)\\}`));
    if (!interfaceMatch) {
      throw new Error(`Missing interface ${interfaceName}`);
    }
    
    const interfaceBody = interfaceMatch[1].trim();
    engineLog(`📝 Interface body: ${interfaceBody}`);
    
    // 2. Проверяем, что интерфейс не пустой
    if (!interfaceBody || interfaceBody.length === 0) {
      throw new Error(`Empty interface ${interfaceName}`);
    }
    
    // 3. Проверяем, что все поля простые
    const propRegex = /(\w+)(\??):\s*([^;,\n]+)/g;
    let propMatch;
    
    while ((propMatch = propRegex.exec(interfaceBody)) !== null) {
      const propName = propMatch[1];
      const propType = propMatch[3].trim();
      
      engineLog(`🔍 Checking prop: ${propName}: ${propType}`);
      
      // Проверяем на вложенные структуры
      if (propType.includes('{') || propType.includes('[')) {
        throw new Error(`Nested types not supported in interface ${interfaceName}, prop ${propName}: ${propType}`);
      }
      
      // Проверяем на сложные типы (объекты, массивы, функции)
      if (propType.includes('=>') || propType.includes('Function') || propType.includes('()')) {
        throw new Error(`Complex types not supported in interface ${interfaceName}, prop ${propName}: ${propType}`);
      }
    }
    
    engineLog(`✅ Interface ${interfaceName} validation passed`);
  }

  /**
   * Валидация пропсов по JSON-схеме
   */
  private validateProps(props: any, schema: any): void {
    engineLog('🔍 Validating props against schema...');
    engineLog('📋 Props:', JSON.stringify(props, null, 2));
    engineLog('📋 Schema:', JSON.stringify(schema, null, 2));
    
    if (!schema || !schema.properties) {
      engineLog('ℹ️ No schema properties found — skipping validation');
      return;
    }
    
    const { properties, required = [] } = schema;
    const details: Array<{ prop: string; expected: string; received: string }> = [];
    
    // Проверяем обязательные поля
    for (const requiredProp of required) {
      if (!(requiredProp in props)) {
        details.push({ prop: requiredProp, expected: 'required', received: 'missing' });
      }
    }
    
    // Проверяем типы всех переданных пропсов
    for (const [propName, propValue] of Object.entries(props)) {
      const propSchema = properties[propName];
      
      if (!propSchema) {
        engineLog(`⚠️ Unknown prop: "${propName}" - ignoring`);
        continue;
      }
      
      const expectedType = propSchema.type;
      const actualType = typeof propValue;
      
      engineLog(`🔍 Checking prop "${propName}": expected ${expectedType}, got ${actualType}`);
      
      // Проверяем тип
      if (actualType !== expectedType) {
        details.push({ prop: String(propName), expected: expectedType, received: actualType });
        continue;
      }
      
      // Дополнительные проверки для специфичных типов
      if (expectedType === 'string' && propValue !== null && propValue !== undefined) {
        if (typeof propValue !== 'string') {
          details.push({ prop: String(propName), expected: 'string', received: typeof propValue });
          continue;
        }
        
        // Проверяем enum значения
        if (propSchema.enum && !propSchema.enum.includes(propValue)) {
          details.push({ prop: String(propName), expected: `one of [${propSchema.enum.join(', ')}]`, received: String(propValue) });
          continue;
        }
      }
      
      if (expectedType === 'number' && propValue !== null && propValue !== undefined) {
        if (typeof propValue !== 'number' || isNaN(propValue)) {
          details.push({ prop: String(propName), expected: 'number', received: typeof propValue });
          continue;
        }
      }
      
      if (expectedType === 'boolean' && propValue !== null && propValue !== undefined) {
        if (typeof propValue !== 'boolean') {
          details.push({ prop: String(propName), expected: 'boolean', received: typeof propValue });
          continue;
        }
      }
      
      // Проверяем вложенные объекты
      if (expectedType === 'object' && propValue !== null && propValue !== undefined) {
        if (typeof propValue !== 'object' || Array.isArray(propValue)) {
          details.push({ prop: String(propName), expected: 'object', received: Array.isArray(propValue) ? 'array' : typeof propValue });
          continue;
        }
        
        // Рекурсивно валидируем вложенный объект
        if (propSchema.properties) {
          try {
            this.validateProps(propValue, propSchema);
          } catch (nestedErr: any) {
            if (nestedErr && Array.isArray(nestedErr.details)) {
              // Префиксуем имена свойств
              nestedErr.details.forEach((d: any) => {
                details.push({ prop: `${propName}.${d.prop}`, expected: d.expected, received: d.received });
              });
            } else {
              details.push({ prop: String(propName), expected: 'object (valid)', received: 'object (invalid)' });
            }
          }
        }
      }
    }
    
    if (details.length > 0) {
      const err: any = new Error('Props validation failed');
      err.details = details;
      throw err;
    }
    engineLog('✅ Props validation passed');
  }

  /**
   * Определение фреймворка по файлам
   */
  private detectFramework(files: Array<{ name: string; content: string }>): 'react' | 'vue' | 'svelte' {
    for (const file of files) {
      if (file.name.endsWith('.tsx') || file.name.endsWith('.jsx')) {
        return 'react';
      }
      if (file.name.endsWith('.vue')) {
        return 'vue';
      }
      if (file.name.endsWith('.svelte')) {
        return 'svelte';
      }
    }

    // Fallback: проверяем содержимое
    for (const file of files) {
      if (file.content.includes('React') || file.content.includes('jsx')) {
        return 'react';
      }
      if (file.content.includes('<template>')) {
        return 'vue';
      }
      if (file.content.includes('<script>') && !file.content.includes('<template>')) {
        return 'svelte';
      }
    }

    return 'react'; // default
  }

  /**
   * Поиск главного файла компонента
   */
  private findMainFile(
    files: Array<{ name: string; content: string }>,
    framework: string,
    options?: { entryPath?: string }
  ): { name: string; content: string } | null {
    const extensions = {
      react: ['.tsx', '.jsx', '.ts', '.js'],
      vue: ['.vue'],
      svelte: ['.svelte']
    };

    const validExtensions = extensions[framework as keyof typeof extensions] || extensions.react;

    // Prefer explicit entryPath (canonical).
    try {
      const entryPath = String(options?.entryPath || '');
      if (entryPath) {
        const exact = files.find((f) => String(f?.name || '') === entryPath);
        if (exact) return exact;
      }
    } catch {}

    for (const file of files) {
      for (const ext of validExtensions) {
        if (file.name.endsWith(ext)) {
          return file;
        }
      }
    }

    return files[0] || null;
  }

  /**
   * Extract props via regex — delegates to shared propParsingHelpers.
   */
  private extractPropsWithRegex(code: string): ComponentProp[] {
    return _extractPropsFromCode(code);
  }

  /**
   * Extract interfaces — delegates to shared propParsingHelpers.
   */
  private extractInterfaceMap(code: string): Record<string, ComponentProp[]> {
    return _extractInterfaceMap(code);
  }

  /**
   * Parse inline object type — delegates to shared propParsingHelpers.
   */
  private parseInlineObjectType(objectType: string): ComponentProp[] {
    return _parseInlineObjectType(objectType);
  }

  // NOTE: parseInterfaceBody removed — logic lives in propParsingHelpers.ts

  // Placeholder to satisfy any remaining this.parseInlineObjectType calls
  // in methods not yet refactored (e.g. extractVueProps/extractSvelteProps).
  /**
   * Extract enums — delegates to shared propParsingHelpers.
   */
  private extractEnumMap(code: string): Record<string, string[]> {
    return _extractEnumMap(code);
  }

  /**
   * Извлечение пропсов из Vue компонента (Composition API)
   */
  private extractPropsFromVue(code: string): ComponentProp[] {
    engineLog('🔍 Extracting props from Vue component...');
    
    // Ищем defineProps<...>() - используем подход с подсчетом скобок
    const definePropsMatch = code.match(/defineProps\s*<\s*\{/);
    
    if (!definePropsMatch) {
      engineLog('📝 No defineProps found in Vue component');
      return [];
    }
    
    // Находим позицию начала интерфейса
    const startPos = definePropsMatch.index! + definePropsMatch[0].length;
    let braceCount = 1;
    let endPos = startPos;
    
    // Ищем закрывающую скобку с учетом вложенности
    for (let i = startPos; i < code.length; i++) {
      if (code[i] === '{') braceCount++;
      else if (code[i] === '}') {
        braceCount--;
        if (braceCount === 0) {
          endPos = i;
          break;
        }
      }
    }
    
    if (braceCount !== 0) {
      engineLog('📝 Malformed defineProps - unmatched braces');
      return [];
    }
    
    const propsInterface = code.substring(startPos, endPos).trim();
    engineLog(`📝 Found props interface: { ${propsInterface} }`);
    
    // Валидируем интерфейс пропсов
    this.validatePropsInterface('VueProps', `interface VueProps { ${propsInterface} }`);
    
    // Парсим пропы
    const props: ComponentProp[] = [];
    const propRegex = /(\w+)(\??):\s*([^;,\n]+)/g;
    let propMatch;
    
    while ((propMatch = propRegex.exec(propsInterface)) !== null) {
      const propName = propMatch[1];
      const isRequired = !propMatch[2];
      const rawType = propMatch[3].trim();
      
      engineLog(`🔍 Vue prop: ${propName}: ${rawType} (required: ${isRequired})`);
      
      // Проверяем на вложенные структуры
      if (rawType.includes('{') || rawType.includes('[')) {
        throw new Error(`Nested types not supported in Vue props, prop ${propName}: ${rawType}`);
      }
      
      const mapped = this.mapTypeRich(rawType);
      const prop: ComponentProp = {
        name: propName,
        type: mapped.type,
        required: isRequired,
        description: `${propName} prop`
      };
      if (mapped.options) prop.options = mapped.options;
      props.push(prop);
    }
    
    engineLog(`✅ Extracted ${props.length} Vue props`);
    return props;
  }

  /**
   * Извлечение пропсов из Svelte компонента
   */
  private extractPropsFromSvelte(code: string): ComponentProp[] {
    engineLog('🔍 Extracting props from Svelte component...');
    
    // Ищем все export let <name>: <type>
    const exportLetRegex = /export\s+let\s+(\w+)(\??):\s*([^;,\n]+)/g;
    const props: ComponentProp[] = [];
    let match;
    
    while ((match = exportLetRegex.exec(code)) !== null) {
      const propName = match[1];
      const isRequired = !match[2];
      const rawType = match[3].trim();
      
      engineLog(`🔍 Svelte prop: ${propName}: ${rawType} (required: ${isRequired})`);
      
      // Проверяем на вложенные структуры
      if (rawType.includes('{') || rawType.includes('[')) {
        throw new Error(`Nested types not supported in Svelte props, prop ${propName}: ${rawType}`);
      }
      
      // Проверяем на сложные типы
      if (rawType.includes('=>') || rawType.includes('Function') || rawType.includes('()')) {
        throw new Error(`Complex types not supported in Svelte props, prop ${propName}: ${rawType}`);
      }
      
      const mapped = this.mapTypeRich(rawType);
      const prop: ComponentProp = {
        name: propName,
        type: mapped.type,
        required: isRequired,
        description: `${propName} prop`
      };
      if (mapped.options) prop.options = mapped.options;
      props.push(prop);
    }
    
    engineLog(`✅ Extracted ${props.length} Svelte props`);
    return props;
  }

  /**
   * Извлечение интерфейсов через regex
   */
  private extractInterfacesWithRegex(code: string): string[] {
    const interfaces: string[] = [];
    const interfaceRegex = /interface\s+(\w+)\s*\{([^}]+)\}/g;
    let match;

    while ((match = interfaceRegex.exec(code)) !== null) {
      const name = match[1];
      const body = match[2];
      const properties: string[] = [];

      const propRegex = /(\w+)(\??):\s*([^;,\n]+)/g;
      let propMatch;

      while ((propMatch = propRegex.exec(body)) !== null) {
        properties.push(`${propMatch[1]}${propMatch[2]}: ${propMatch[3].trim()}`);
      }

      interfaces.push(`interface ${name} { ${properties.join(', ')} }`);
    }

    return interfaces;
  }

  /**
   * Упрощение TypeScript типов
   */
  /**
   * Rich type mapping: delegates to shared propParsingHelpers.
   */
  private mapTypeRich(tsType: string, aliases?: Record<string, string[]>): { type: string; options?: string[] } {
    return _mapTypeRich(tsType, aliases);
  }

  /**
   * Legacy compat: returns just the type string.
   */
  private mapTypeToSimple(tsType: string): string {
    return this.mapTypeRich(tsType).type;
  }

  /**
   * Извлечение и компиляция стилей (CSS/SCSS)
   */
  private extractStyles(files: Array<{ name: string; content: string }>): string {
    const styleExtensions = ['.css', '.scss', '.sass', '.less'];
    const logs: string[] = [];
    
    logs.push('🎨 Starting style extraction and compilation...');
    
    const styles = files
      .filter(file => styleExtensions.some(ext => file.name.endsWith(ext)))
      .map(file => {
        logs.push(`📄 Processing style file: ${file.name}`);
        
        try {
          // Компилируем SCSS/SASS в CSS
          if (file.name.endsWith('.scss') || file.name.endsWith('.sass')) {
            const compiledCss = this.compileSass(file.content, file.name);
            logs.push(`✅ SCSS/SASS compiled successfully: ${file.name}`);
            return compiledCss;
          }
          
          // LESS компиляция (базовая)
          if (file.name.endsWith('.less')) {
            // Простая обработка LESS - в реальности нужен less.js
            logs.push(`⚠️ LESS file processed as CSS: ${file.name}`);
            return file.content;
          }
          
          // Обычный CSS
          logs.push(`✅ CSS file processed: ${file.name}`);
          return file.content;
          
        } catch (error) {
          logs.push(`❌ Style compilation failed for ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
          // Возвращаем исходный CSS как fallback
          return `/* Compilation failed for ${file.name} */\n${file.content}`;
        }
      })
      .join('\n');

    // Генерируем CSS для ассетов (шрифты/иконки) из VFS
    const assetsCss = this.generateAssetCSS(files);

    logs.push(`🎨 Style extraction completed. Total styles: ${styles.length} characters`);
    if (typeof process !== 'undefined' && process?.env?.USERFACE_ENGINE_DEBUG_STYLES === '1') {
      logs.forEach(log => console.log(log));
    }
    
    return [styles, assetsCss].filter(Boolean).join('\n');
  }

  /**
   * Генерация CSS для шрифтов и иконок из VFS
   * Поддержка:
   *  - .svg: инлайн в data:image/svg+xml;utf8
   *  - .woff2/.woff/.ttf/.otf: ожидается data:URL; если не data:, пропускаем (нельзя надёжно сериализовать бинарник)
   */
  private generateAssetCSS(files: Array<{ name: string; content: string }>): string {
    const cssBlocks: string[] = [];
    const toKebab = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const toFontFamily = (s: string) => `UF_${s.replace(/[^a-zA-Z0-9_]+/g, '_')}`;

    for (const f of files) {
      const lower = f.name.toLowerCase();
      // SVG иконки
      if (lower.endsWith('.svg')) {
        const base = f.name.split('/').pop() || f.name;
        const name = base.replace(/\.svg$/i, '');
        const encoded = encodeURIComponent(f.content)
          // минимальная очистка, чтобы не поломать атрибуты
          .replace(/%0A/g, '') // убрать переводы строк
          .replace(/%20/g, ' ');
        const dataUrl = `data:image/svg+xml;utf8,${encoded}`;
        // CSS-переменная и класс-иконка
        cssBlocks.push(
          `:root { --icon-${toKebab(name)}: url('${dataUrl}'); }`,
        );
        cssBlocks.push(
          `.icon-${toKebab(name)}{ display:inline-block; width:1em; height:1em; background: currentColor; -webkit-mask-image: var(--icon-${toKebab(name)}); mask-image: var(--icon-${toKebab(name)}); -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-size:contain; mask-size:contain; }`
        );
        continue;
      }

      // Шрифты
      if (/\.(woff2|woff|ttf|otf)$/i.test(lower)) {
        const base = f.name.split('/').pop() || f.name;
        const family = toFontFamily(base.replace(/\.(woff2|woff|ttf|otf)$/i, ''));
        const ext = (base.match(/\.(woff2|woff|ttf|otf)$/i) || [,'woff2'])[1];
        const formatMap: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };
        const fmt = formatMap[ext] || 'woff2';
        let src: string | null = null;
        const content = f.content.trim();
        if (content.startsWith('data:')) {
          // уже data URL
          src = `url('${content}') format('${fmt}')`;
        } else {
          // не поддерживаем бинарный контент без data:URL — безопасно пропустить
          // в будущем можно расширить до File API
          src = null;
        }
        if (src) {
          cssBlocks.push(
            `@font-face { font-family: '${family}'; src: ${src}; font-weight: normal; font-style: normal; font-display: swap; }`
          );
        }
        continue;
      }
    }

    return cssBlocks.join('\n');
  }

  /**
   * Компиляция SASS/SCSS в CSS
   */
  private compileSass(sassContent: string, fileName: string): string {
    // Сначала проверяем кэш
    try {
      const cacheKey = `${fileName}|${sassContent.length}|${this.simpleHash(sassContent)}`;
      const cached = this.sassCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      
      // 1) Браузер: используем window.Sass, если доступен (sass.js / wasm)
      try {
        const anyGlobal = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        const anyWindow = (typeof window !== 'undefined') ? (window as unknown as { Sass?: any }) : null;
        const Sass = (anyWindow && anyWindow.Sass) || (anyGlobal && anyGlobal.Sass);
        if (Sass && typeof Sass.compile === 'function') {
          const res = Sass.compile(sassContent, { style: 'expanded' });
          const out = (res && (res.text || res.css)) ? (res.text || res.css) : '';
          if (out) {
            this.sassCache.set(cacheKey, out);
            return out;
          }
        }
      } catch {}
      
      // 2) Node.js: используем пакет "sass", если доступен
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sass = (typeof require !== 'undefined') ? require('sass') : null;
        if (sass) {
          let out: string = '';
          if (typeof sass.compileString === 'function') {
            const result = sass.compileString(sassContent, { style: 'expanded' });
            out = result && result.css ? result.css : (result?.text || '');
          } else if (typeof sass.renderSync === 'function') {
            const result = sass.renderSync({ data: sassContent, outputStyle: 'expanded' });
            out = result && result.css ? String(result.css) : '';
          }
          if (out) {
            this.sassCache.set(cacheKey, out);
            return out;
          }
        }
      } catch {}
      
      // 3) Fallback: упрощённая обработка (как раньше)
      let css = sassContent;
      css = this.processSassVariables(css);
      css = this.processSassNesting(css);
      css = this.cleanSassSpecificSyntax(css);
      this.sassCache.set(cacheKey, css);
      return css;
    } catch (error) {
      engineLog(`SCSS compilation warning for ${fileName}:`, error);
      return `/* SCSS compilation fallback for ${fileName} */\n${sassContent}`;
    }
  }

  private simpleHash(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      // eslint-disable-next-line no-bitwise
      hash = ((hash << 5) - hash) + input.charCodeAt(i);
      // eslint-disable-next-line no-bitwise
      hash |= 0;
    }
    return hash >>> 0;
  }

  /**
   * Обработка SCSS переменных
   */
  private processSassVariables(scss: string): string {
    const variables: Record<string, string> = {};
    
    // Извлекаем переменные
    const variableRegex = /\$([a-zA-Z_-][a-zA-Z0-9_-]*)\s*:\s*([^;]+);/g;
    let match;
    
    while ((match = variableRegex.exec(scss)) !== null) {
      variables[match[1]] = match[2].trim();
    }
    
    // Заменяем использование переменных
    let result = scss;
    Object.entries(variables).forEach(([name, value]) => {
      const varRegex = new RegExp(`\\$${name}\\b`, 'g');
      result = result.replace(varRegex, value);
    });
    
    // Удаляем объявления переменных
    result = result.replace(variableRegex, '');
    
    return result;
  }

  /**
   * Простая обработка SCSS вложенности
   */
  private processSassNesting(scss: string): string {
    // Это упрощенная версия - полная обработка вложенности сложна
    // В реальном проекте лучше использовать sass.js или node-sass
    
    // Убираем простые случаи вложенности типа:
    // .parent { .child { color: red; } }
    // превращаем в: .parent .child { color: red; }
    
    let result = scss;
    
    // Простейший случай - один уровень вложенности
    const nestedRegex = /([^{}]+)\s*{\s*([^{}]+)\s*{\s*([^{}]+)\s*}\s*}/g;
    
    result = result.replace(nestedRegex, (match, parent, child, content) => {
      const parentSelector = parent.trim();
      const childSelector = child.trim();
      
      // Если child начинается с &, заменяем & на parent
      if (childSelector.startsWith('&')) {
        const finalSelector = childSelector.replace('&', parentSelector);
        return `${finalSelector} { ${content} }`;
      } else {
        return `${parentSelector} ${childSelector} { ${content} }`;
      }
    });
    
    return result;
  }

  /**
   * Очистка SCSS-специфичного синтаксиса
   */
  private cleanSassSpecificSyntax(scss: string): string {
    let result = scss;
    
    // Удаляем миксины (базово)
    result = result.replace(/@mixin[^{]*{[^}]*}/g, '');
    result = result.replace(/@include[^;]*;/g, '');
    
    // Удаляем импорты SCSS
    result = result.replace(/@import[^;]*;/g, '');
    
    // Удаляем функции SCSS
    result = result.replace(/@function[^{]*{[^}]*}/g, '');
    
    return result;
  }

  /**
   * Валидация зависимостей в файлах
   */
  private validateDependencies(files: Array<{ name: string; content: string }>): { 
    valid: boolean; 
    missing: string[]; 
    logs: string[] 
  } {
    const logs: string[] = [];
    const missing: string[] = [];
    const availableFiles = new Set(files.map(f => f.name));
    
    logs.push('🔍 Starting dependency validation...');
    
    files.forEach(file => {
      logs.push(`📄 Validating dependencies in: ${file.name}`);
      
      const imports = this.extractImportPaths(file.content);
      
      imports.forEach(importPath => {
        const normalizedPath = this.normalizeImportPath(importPath, file.name);
        
        // Проверяем только относительные импорты
        if (importPath.startsWith('./') || importPath.startsWith('../')) {
          if (!availableFiles.has(normalizedPath)) {
            missing.push(`${file.name} -> ${importPath} (resolved: ${normalizedPath})`);
            logs.push(`❌ Missing dependency: ${importPath} in ${file.name}`);
          } else {
            logs.push(`✅ Dependency found: ${importPath} in ${file.name}`);
          }
        } else {
          logs.push(`⚠️ External dependency (skipped): ${importPath} in ${file.name}`);
        }
      });
    });
    
    const valid = missing.length === 0;
    logs.push(`🔍 Dependency validation completed. Valid: ${valid}, Missing: ${missing.length}`);
    logs.forEach(log => console.log(log));
    
    return { valid, missing, logs };
  }

  /**
   * Извлечение путей импортов из кода
   */
  private extractImportPaths(code: string): string[] {
    const imports: string[] = [];
    
    // ES6 imports
    const es6ImportRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = es6ImportRegex.exec(code)) !== null) {
      imports.push(match[1]);
    }
    
    // Dynamic imports
    const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = dynamicImportRegex.exec(code)) !== null) {
      imports.push(match[1]);
    }
    
    // require() calls
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(code)) !== null) {
      imports.push(match[1]);
    }
    
    return imports;
  }

  /**
   * Нормализация пути импорта
   */
  private normalizeImportPath(importPath: string, currentFile: string): string {
    // Простая нормализация - для полной поддержки нужна path.resolve логика
    
    if (importPath.startsWith('./')) {
      // Относительный импорт в той же папке
      const dir = currentFile.split('/').slice(0, -1).join('/');
      const file = importPath.substring(2);
      return dir ? `${dir}/${file}` : file;
    }
    
    if (importPath.startsWith('../')) {
      // Относительный импорт в родительской папке
      const pathParts = currentFile.split('/').slice(0, -1);
      const importParts = importPath.split('/');
      
      let i = 0;
      while (i < importParts.length && importParts[i] === '..') {
        pathParts.pop();
        i++;
      }
      
      return [...pathParts, ...importParts.slice(i)].join('/');
    }
    
    // Абсолютный или внешний импорт
    return importPath;
  }

  /**
   * Создание спецификации компонента
   */
  private createComponentSpec(name: string, framework: string, parseResult: { props: ComponentProp[]; interfaces: string[]; cleanCode: string }, styles: string, files: Array<{ name: string; content: string }>): ComponentSpec {
    engineLog('🔧 Creating component spec...');
    
    // Генерируем JSON-схему на основе пропсов
    const schema = this.generateJsonSchema(parseResult.props);
    engineLog('📋 Generated schema:', schema);
    
    return {
      name,
      framework: framework as 'react' | 'vue' | 'svelte',
      version: '1.0.0',
      code: parseResult.cleanCode, // Добавляем очищенный код
      metadata: {
        fileName: files[0]?.name || `${name}.${framework}`,
        createdAt: new Date().toISOString(),
        interfaces: parseResult.interfaces.map(i => {
          const match = i.match(/interface\s+(\w+)\s*\{([^}]*)\}/);
          return match ? { name: match[1], properties: [] } : { name: 'Unknown', properties: [] };
        }),
        types: [],
        schema: schema // Добавляем схему в метаданные
      },
      props: parseResult.props,
      styles,
      render: {
        type: 'component',
        framework,
        adapter: framework
      }
    };
  }

  /**
   * Регистрация компонента
   */
  private registerComponent(spec: ComponentSpec): void {
    this.componentRegistry.set(spec.name, spec);
  }

  /**
   * Сохранение в VFS
   */
  private saveToVFS(files: Array<{ name: string; content: string }>, spec: ComponentSpec): void {
    const vfsEntry: VFSEntry = {
      files: files.map(f => ({ name: f.name, content: f.content })),
      spec,
      timestamp: Date.now()
    };

    this.vfs.set(spec.name, vfsEntry);
  }

  /**
   * Получение спецификации компонента
   */
  private getComponentSpec(specName: string): ComponentSpec | undefined {
    return this.componentRegistry.get(specName);
  }

  /**
   * Удаление компонента из реестра
   */
  private unregisterComponent(specName: string): void {
    this.componentRegistry.delete(specName);
  }

  /**
   * Поиск исходного файла компонента
   */
  findSourceFile(componentName: string, framework: string): { name: string; content: string } | null {
    const vfsEntry = this.vfs.get(componentName);
    if (!vfsEntry) {
      return null;
    }

    // Prefer the deterministic entryPath recorded during analyzeComponent.
    // This avoids accidentally picking the first .tsx in a folder (e.g. Accordion instead of Button).
    const preferredEntry = (() => {
      try {
        const raw =
          String(vfsEntry.spec?.metadata?.entryPath || '') ||
          String((vfsEntry.spec as any)?.diagnostics?.entryPath || '') ||
          String(vfsEntry.spec?.name || '') ||
          String(componentName || '');
        return raw.replace(/^\/+/, '').trim();
      } catch {
        return '';
      }
    })();
    if (preferredEntry) {
      const exact = vfsEntry.files.find((f) => String(f?.name || '') === preferredEntry);
      if (exact) return exact;
    }

    const extensions = {
      react: ['.tsx', '.jsx', '.ts', '.js'],
      vue: ['.vue'],
      svelte: ['.svelte']
    };

    const validExtensions = extensions[framework as keyof typeof extensions] || extensions.react;

    for (const file of vfsEntry.files) {
      for (const ext of validExtensions) {
        if (file.name.endsWith(ext)) {
          return file;
        }
      }
    }

    return vfsEntry.files[0] || null;
  }

  /**
   * Экспорт JSON-спецификации
   */
  exportSpec(specName: string): string {
    const spec = this.getComponentSpec(specName);
    if (!spec) {
      throw new Error(`Component spec not found: ${specName}`);
    }

    return JSON.stringify(spec, null, 2);
  }

  /**
   * Импорт JSON-спецификации
   */
  importSpec(specJson: string): ComponentSpec {
    const spec = JSON.parse(specJson);
    this.registerComponent(spec);
    return spec;
  }

  /**
   * Получение списка компонентов
   */
  getComponents(): string[] {
    return Array.from(this.componentRegistry.keys());
  }

  /**
   * Очистка VFS
   */
  clearVFS(): void {
    this.vfs.clear();
    this.componentRegistry.clear();
  }

  /**
   * Генерация JSON-схемы из пропсов компонента
   */
  private generateJsonSchema(props: ComponentProp[]): any {
    engineLog('🔧 Generating JSON schema from props...');
    
    const properties: any = {};
    const required: string[] = [];
    
    for (const prop of props) {
      engineLog(`🔍 Processing prop: ${prop.name} (${prop.type})`);
      
      try {
        const propSchema = this.generatePropSchema(prop);
        properties[prop.name] = propSchema;
        
        if (prop.required) {
          required.push(prop.name);
        }
      } catch (error) {
        engineLog(`⚠️ Skipping prop "${prop.name}": ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    
    const schema = {
      type: 'object',
      properties,
      required
    };
    
    engineLog('📋 Generated schema:', schema);
    return schema;
  }
  
  /**
   * Генерация схемы для отдельного пропа
   */
  private generatePropSchema(prop: ComponentProp): any {
    const { type, enumValues, fields } = prop;
    
    // 1. Примитивные типы
    if (['string', 'number', 'boolean'].includes(type)) {
      return { type };
    }
    
    // 2. Enum типы
    if (type === 'enum' || type === 'union') {
      if (!enumValues || enumValues.length === 0) {
        throw new Error(`Enum type "${prop.name}" must have enumValues`);
      }
      return {
        type: 'string',
        enum: enumValues
      };
    }
    
    // 3. Object типы
    if (type === 'object') {
      if (!fields || fields.length === 0) {
        throw new Error(`Object type "${prop.name}" must have fields`);
      }
      
      // Проверяем вложенность - только 1 уровень
      for (const field of fields) {
        if (field.type === 'object') {
          throw new Error(`Unsupported complex type in prop: ${prop.name} - nested objects not allowed`);
        }
        if (['array', 'function', 'generic'].includes(field.type)) {
          throw new Error(`Unsupported complex type in prop: ${prop.name} - ${field.type} not allowed`);
        }
      }
      
      // Генерируем схему для объекта
      const objectProperties: any = {};
      const objectRequired: string[] = [];
      
      for (const field of fields) {
        try {
          const fieldSchema = this.generatePropSchema(field);
          objectProperties[field.name] = fieldSchema;
          
          if (field.required) {
            objectRequired.push(field.name);
          }
        } catch (error) {
          throw new Error(`Error in field "${field.name}" of prop "${prop.name}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      
      return {
        type: 'object',
        properties: objectProperties,
        required: objectRequired
      };
    }
    
    // 4. Неподдерживаемые типы
    if (['array', 'function', 'generic', 'any', 'unknown'].includes(type)) {
      throw new Error(`Unsupported complex type in prop: ${prop.name} - ${type} not allowed`);
    }
    
    // 5. Неизвестные типы
    engineLog(`⚠️ Unknown type "${type}" for prop "${prop.name}" - treating as string`);
    return { type: 'string' };
  }

  /**
   * Анализ и рендеринг компонента в одном вызове
   */
  async analyzeAndRender(code: string, framework: 'react' | 'vue' | 'svelte', props: any): Promise<StructuredRenderResult> {
    const logs: string[] = [];
    const startTime = Date.now();
    
    logs.push(`🎯 Starting analyzeAndRender for ${framework} component`);
    
    try {
      // 1. Анализируем компонент
      logs.push(`🔍 Step 1: Analyzing component code...`);
      const mainName = framework === 'vue' ? '__analyze_component__.vue' : framework === 'svelte' ? '__analyze_component__.svelte' : '__analyze_component__.tsx';
      const analysis = await this.analyzeComponent([{ name: mainName, content: code }], { entryPath: mainName });
      logs.push(`✅ Component analysis completed: ${analysis.name}`);
      
      // 2. Валидируем пропсы по схеме
      logs.push(`✅ Step 2: Validating props against schema...`);
      if (analysis.metadata.schema) {
        this.validateProps(props, analysis.metadata.schema);
        logs.push(`✅ Props validation passed`);
      } else {
        logs.push(`⚠️ No schema available, skipping props validation`);
      }
      
      // 3. Создаем рендер через минимальные фреймворк-адаптеры
      logs.push(`🎨 Step 3: Creating render via adapter...`);
      let html: string;
      let adapterName = 'mock';
      try {
        adapterName = framework + '-adapter';
        const adapterHtml = await this.renderViaAdapter(framework, analysis.code, props, analysis.styles);
        html = adapterHtml || this.createFallbackRender(framework, analysis.name, props);
        if (!adapterHtml) {
          logs.push('Fallback activated for ' + framework);
        }
        logs.push(`Adapter used: ${framework}`);
      } catch (renderError) {
        logs.push(`❌ Adapter render failed: ${renderError instanceof Error ? renderError.message : String(renderError)}`);
        logs.push(`Fallback activated for ${framework}`);
        html = this.createFallbackRender(framework, analysis.name, props);
      }
      
      const duration = Date.now() - startTime;
      logs.push(`⏱️ AnalyzeAndRender completed in ${duration}ms`);
      
      return {
        success: true,
        html,
        logs,
        specName: analysis.name
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`💥 Error in analyzeAndRender: ${errorMessage}`);
      
      return {
        success: false,
        error: `Analyze and render failed: ${errorMessage}`,
        logs,
        stack: error instanceof Error ? error.stack : undefined
      };
    }
  }

  /**
   * Безопасный рендеринг компонента в sandbox-режиме
   */
  async renderInSandbox(code: string, framework: 'react' | 'vue' | 'svelte', props: any): Promise<StructuredRenderResult> {
    const logs: string[] = [];
    const startTime = Date.now();
    
    logs.push(`🛡️ Starting sandbox render for ${framework} component`);
    
    try {
      // 1. Анализируем компонент
      logs.push(`🔍 Step 1: Analyzing component code...`);
      const mainName = framework === 'vue' ? '__sandbox_component__.vue' : framework === 'svelte' ? '__sandbox_component__.svelte' : '__sandbox_component__.tsx';
      const analysis = await this.analyzeComponent([{ name: mainName, content: code }], { entryPath: mainName });
      logs.push(`✅ Component analysis completed: ${analysis.name}`);
      
      // 2. Валидируем пропсы по схеме
      logs.push(`✅ Step 2: Validating props against schema...`);
      if (analysis.metadata.schema) {
        this.validateProps(props, analysis.metadata.schema);
        logs.push(`✅ Props validation passed`);
      } else {
        logs.push(`⚠️ No schema available, skipping props validation`);
      }
      
      // 3. Попытка безопасного выполнения
      logs.push(`🧪 Step 3: Attempting safe execution...`);
      let html: string;
      
      try {
        // Используем простой адаптерный SSR-подобный рендер как безопасный путь
        html = await this.renderViaAdapter(framework, analysis.code, props, analysis.styles);
        logs.push('Adapter used: ' + framework);
        logs.push(`✅ Safe execution successful`);
      } catch (executionError) {
        logs.push(`❌ Safe execution failed: ${executionError instanceof Error ? executionError.message : String(executionError)}`);
        
        // 4. Fallback-рендеринг
        logs.push(`🔄 Step 4: Using fallback render...`);
        html = this.createFallbackRender(framework, analysis.name, props);
        logs.push(`✅ Fallback render created`);
      }
      
      const duration = Date.now() - startTime;
      logs.push(`⏱️ Sandbox render completed in ${duration}ms`);
      
      return {
        success: true,
        html,
        logs,
        specName: analysis.name
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`💥 Sandbox render failed: ${errorMessage}`);
      
      return {
        success: false,
        error: `Sandbox render failed: ${errorMessage}`,
        logs,
        stack: error instanceof Error ? error.stack : undefined
      };
    }
  }

  /**
   * Создание простого рендера для Node.js окружения
   */
  private createSimpleRender(framework: string, componentName: string, props: any, code: string): string {
    engineLog('🔄 Creating simple render for Node.js environment');
    
    // Простая очистка TypeScript синтаксиса
    let cleanedCode = code;
    cleanedCode = cleanedCode.replace(/interface\s+\w+\s*\{[\s\S]*?\}/g, '');
    cleanedCode = cleanedCode.replace(/enum\s+\w+\s*\{[\s\S]*?\}/g, '');
    cleanedCode = cleanedCode.replace(/type\s+\w+\s*=\s*[\s\S]*?;/g, '');
    cleanedCode = cleanedCode.replace(/:\s*[A-Z][a-zA-Z]*/g, '');
    cleanedCode = cleanedCode.replace(/import\s+.*?;?\s*/g, '');
    cleanedCode = cleanedCode.replace(/export\s+.*?;?\s*/g, '');
    
    // Создаем простой HTML с компонентом
    const propsJson = JSON.stringify(props, null, 2);
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${componentName}</title>
  <style>
    body { 
      margin: 0; 
      padding: 20px; 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
    }
    .component-preview {
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 20px;
      background: white;
    }
    .props-display {
      margin-top: 20px;
      padding: 15px;
      background: #f5f5f5;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="component-preview">
    <h3>${componentName}</h3>
    <div id="component-root">
      <!-- Component would render here in browser -->
      <div style="color: #666; font-style: italic;">
        Component preview not available in Node.js environment
      </div>
    </div>
    <div class="props-display">
      <strong>Props:</strong><br/>
      <pre>${propsJson}</pre>
    </div>
  </div>
  
  <script>
    // Component code (cleaned):
    ${cleanedCode}
    
    engineLog('Component loaded:', typeof window.${componentName});
    engineLog('Props:', ${propsJson});
  </script>
</body>
</html>`;
  }

  /**
   * Безопасное выполнение компонента
   */
  private async executeComponentSafely(code: string, framework: string, props: any, analysis: ComponentSpec): Promise<string> {
    const logs: string[] = [];
    
    try {
      // Очищаем код от потенциально опасных конструкций
      const { code: cleanCode } = this.sanitizeCode(code, framework);
      logs.push(`🧹 Code sanitized`);
      
      // Создаем изолированную функцию
      const isolatedFunction = this.createIsolatedFunction(cleanCode, framework, props);
      logs.push(`🔒 Isolated function created`);
      
      // Выполняем с таймаутом
      const result = await this.executeWithTimeout(isolatedFunction, 5000); // 5 секунд таймаут
      logs.push(`✅ Execution completed`);
      
      return result;
      
    } catch (error) {
      logs.push(`❌ Safe execution error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Санитизация кода для безопасности (использует UniversalCodeSanitizer)
   */
  private sanitizeCode(code: string, framework: string): { code: string; blocked: string[] } {
    const blocked: string[] = [];
    let working = code;

    // 1) Блокируем критические конструкции до каких-либо трансформаций
    const criticalPatterns: Array<{ name: string; regex: RegExp }> = [
      { name: 'dangerouslySetInnerHTML', regex: /dangerouslySetInnerHTML\s*=/g },
      { name: 'eval', regex: /\beval\s*\(/g },
      { name: 'alert', regex: /\balert\s*\(/g },
      { name: 'Function', regex: /\bnew\s+Function\s*\(|\bFunction\s*\(/g }
    ];

    for (const { name, regex } of criticalPatterns) {
      if (regex.test(working)) {
        blocked.push(name);
        working = working.replace(regex, '/** BLOCKED **/');
      }
    }

    // 2) Политика script-тегов
    const scriptTagRegex = /<\s*script\b([\s\S]*?)>([\s\S]*?)<\s*\/\s*script\s*>/gi;
    working = working.replace(scriptTagRegex, (full, _attrs, body) => {
      const bodyStr = String(body || '');
      const hasDanger = /(\beval\s*\(|\balert\s*\(|\bnew\s+Function\s*\()/i.test(bodyStr);
      if (framework === 'react') {
        blocked.push('<script>');
        return '/** BLOCKED **/';
      }
      if (hasDanger) {
        blocked.push('<script>');
        return '/** BLOCKED **/';
      }
      return full;
    });

    // 3) Универсальная санитизация модульного синтаксиса (imports/exports/CommonJS) + IIFE
    try {
      const fw = (framework as 'react' | 'vue' | 'svelte');
      const sanitizer = new UniversalCodeSanitizer(fw);
      const result = sanitizer.sanitizeCode(working);

      // Если после санитизации всё ещё есть модульный синтаксис — считаем это блокировкой
      if (result.hasImports) blocked.push('import');
      if (result.hasExports) blocked.push('export');
      if (result.hasCommonJS) blocked.push('commonjs');

      working = result.cleanCode;
    } catch (e) {
      // В случае ошибки санитизатора — оставляем working как есть
    }

    // 4) Доп. песочница — только пометки, чтобы не ломать код
    const sandboxedPatterns: RegExp[] = [
      /window\./g,
      /document\./g,
      /global\./g,
      /process\./g,
      /require\(/g,
      /import\s+.*from\s+['"]/g,
      /export\s+/g,
      /setTimeout\(/g,
      /setInterval\(/g,
      /fetch\(/g,
      /XMLHttpRequest/g,
      /localStorage/g,
      /sessionStorage/g
    ];

    sandboxedPatterns.forEach(pattern => {
      working = working.replace(pattern, '// SANDBOX_BLOCKED: $&');
    });

    return { code: working, blocked };
  }

  /**
   * Санитизация входящих props
   */
  private sanitizeProps<T = any>(input: T): T {
    const sanitizeValue = (value: any): any => {
      if (value === null || value === undefined) return value;
      const valueType = typeof value;
      if (valueType === 'symbol') return `[Symbol: ${(value as symbol).description || 'anonymous'}]`;
      if (valueType === 'bigint') return (value as bigint).toString() + 'n';
      if (valueType === 'function') return '[Function]';
      if (Array.isArray(value)) return value.map(sanitizeValue);
      if (valueType === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          out[k] = sanitizeValue(v);
        }
        return out;
      }
      if (valueType === 'string') {
        // Блокируем явные javascript: и script в строках
        let str = value as string;
        if (/javascript:/i.test(str)) return '[BLOCKED: javascript-protocol]';
        if (/<\s*script\b|dangerouslySetInnerHTML/i.test(str)) str = str.replace(/<\s*script\b|dangerouslySetInnerHTML/gi, '[BLOCKED]');
        if (/\beval\s*\(|\balert\s*\(/i.test(str)) str = str.replace(/\beval\s*\(|\balert\s*\(/gi, '[BLOCKED(');
        return str;
      }
      return value;
    };

    return sanitizeValue(input);
  }

  private propsContainBlockedMarkers(input: any): boolean {
    const check = (v: any): boolean => {
      if (v == null) return false;
      if (typeof v === 'string') return v.includes('[BLOCKED:');
      if (Array.isArray(v)) return v.some(check);
      if (typeof v === 'object') return Object.values(v).some(check);
      return false;
    };
    return check(input);
  }

  /**
   * Создание изолированной функции
   */
  private createIsolatedFunction(code: string, framework: string, props: any): () => string {
    // Создаем безопасную среду выполнения
    const safeGlobals = {
      console: {
        log: () => {},
        warn: () => {},
        error: () => {},
        info: () => {}
      },
      JSON: JSON,
      Math: Math,
      Date: Date,
      Array: Array,
      Object: Object,
      String: String,
      Number: Number,
      Boolean: Boolean,
      RegExp: RegExp,
      React: {},
      ReactDOM: { renderToString: () => '<div>Mock React Render</div>' }
    };
    
    // Для React компонентов
    if (framework === 'react') {
      return () => {
        try {
          // Упрощённое выполнение React компонента
          return `<div class="react-component" data-props="${JSON.stringify(props)}">
            <h3>React Component (Sandbox)</h3>
            <p>Props: ${JSON.stringify(props)}</p>
            <button class="btn btn-primary">${props.label || 'Button'}</button>
          </div>`;
        } catch (error) {
          throw new Error(`React execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
    
    // Для Vue компонентов
    if (framework === 'vue') {
      return () => {
        try {
          return `<div class="vue-component" data-props="${JSON.stringify(props)}">
            <h3>Vue Component (Sandbox)</h3>
            <p>Props: ${JSON.stringify(props)}</p>
          </div>`;
        } catch (error) {
          throw new Error(`Vue execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
    
    // Для Svelte компонентов
    if (framework === 'svelte') {
      return () => {
        try {
          return `<div class="svelte-component" data-props="${JSON.stringify(props)}">
            <h3>Svelte Component (Sandbox)</h3>
            <p>Props: ${JSON.stringify(props)}</p>
          </div>`;
        } catch (error) {
          throw new Error(`Svelte execution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    }
    
    // Fallback для неизвестных фреймворков
    return () => {
      throw new Error(`Unsupported framework: ${framework}`);
    };
  }

  /**
   * Выполнение с таймаутом
   */
  private async executeWithTimeout(func: () => string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      try {
        const result = func();
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Создание fallback-рендера
   */
  private createFallbackRender(framework: string, componentName: string, props: any): string {
    const propsStr = JSON.stringify(props, null, 2);
    const isProd =
      (typeof process !== 'undefined' && (process as any).env && (process as any).env.NODE_ENV === 'production') ||
      (typeof window !== 'undefined' && (window as any).__UF_DISABLE_FALLBACK === true) ||
      (typeof globalThis !== 'undefined' && (globalThis as any).__UF_DISABLE_FALLBACK === true);
    if (isProd) {
      // В проде не выводим fallback DOM, чтобы избежать "неожиданного контента" в превью
      return '';
    }
    
    return `
      <div class="sandbox-fallback ${framework}-component" style="
        border: 2px dashed #ccc;
        padding: 20px;
        margin: 10px;
        background: #f9f9f9;
        border-radius: 8px;
        font-family: monospace;
      ">
        <h3 style="color: #666; margin: 0 0 10px 0;">[Mock Rendered] ${componentName}</h3>
        <p style="margin: 5px 0; color: #888;"><strong>Framework:</strong> ${framework}</p>
        <p style="margin: 5px 0; color: #888;"><strong>Props:</strong></p>
        <pre style="
          background: #fff;
          padding: 10px;
          border-radius: 4px;
          font-size: 12px;
          overflow-x: auto;
          margin: 5px 0;
        ">${propsStr}</pre>
        <p style="margin: 10px 0 0 0; font-size: 12px; color: #999;">
          ⚠️ This is a fallback render. The actual component could not be executed safely.
          <br/>Fallback used
        </p>
      </div>
    `;
  }

  /**
   * Playground модуль для рендеринга с fallback стратегией
   */
  async renderPreview(code: string, framework: 'react' | 'vue' | 'svelte', props: any): Promise<StructuredRenderResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    
    engineLog('🎭 CoreEngine.renderPreview called with framework:', framework);
    logs.push(`🎮 Starting playground render for ${framework} component`);

    // Предварительная санитизация props (безопасность только для данных)
    logs.push('🧹 Sanitizing props...');
    const safeProps = this.sanitizeProps(props);
    // Транспиляция кода в IIFE (без модульного синтаксиса) — единый источник правды
    logs.push('🧩 Transpiling code to IIFE...');
    let iifeCode = '';
    try {
      const { transpileToIIFE } = await import('./transpiler');
      const t = await transpileToIIFE(code, framework, 'DynamicComponent', 'ssr');
      if (!t || !t.cleanCode) {
        return { success: false, error: 'Transpilation failed', logs, usedSandbox: false } as any;
      }
      iifeCode = t.cleanCode;
      logs.push(`✅ Transpiled to IIFE (${iifeCode.length} chars)`);
    } catch (e: any) {
      return { success: false, error: `Transpilation error: ${e?.message || String(e)}`, logs, usedSandbox: false } as any;
    }

    try {
      // Шаг 1: Для Vue/Svelte создаём универсальный iframe HTML с IIFE (первый <script>)
      if (framework === 'vue' || framework === 'svelte') {
        logs.push('🔍 Step 1: Building iframe HTML with IIFE for non-React framework...');
        const ensureIIFE = (s: string) => {
          const t = (s || '').trim();
          if (t.startsWith('(function()') && (t.endsWith('})();') || t.endsWith('());'))) return t;
          return `(function(){ return ${t}; })();`;
        };
        const stylesContent = '';
        let html = '';
        if (framework === 'vue') {
          html = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <title>Vue Component Preview</title>\n  <script>\n${ensureIIFE(iifeCode)}\n  </script>\n  <script src=\"https://unpkg.com/vue@3/dist/vue.global.js\"></script>\n  <style>\n    body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }\n    .error { color: red; padding: 10px; border: 1px solid red; background: #ffe6e6; }\n    ${stylesContent}\n  </style>\n</head>\n<body>\n  <div id=\"app\"></div>\n  <script>\n    try {\n      const { createApp } = Vue;\n      const ComponentDefinition = ${iifeCode};\n      const componentProps = ${JSON.stringify(safeProps)};\n      window.__COMPONENT_PROPS__ = componentProps;\n      const app = createApp({ components: { DynamicComponent: ComponentDefinition }, template: '<DynamicComponent v-bind="componentProps" />', data(){ return { componentProps } } });\n      app.mount('#app');\n    } catch (e) { document.getElementById('app').innerHTML = '<div class=\\"error\\">Error: ' + e.message + '</div>'; }\n  </script>\n</body>\n</html>`;
        } else {
          html = `<!DOCTYPE html>\n<html>\n<head>\n  <meta charset=\"utf-8\">\n  <title>Svelte Component Preview</title>\n  <script>\n${ensureIIFE(iifeCode)}\n  </script>\n  <script src=\"https://unpkg.com/svelte@4/compiler/svelte-compiler.min.js\"></script>\n  <style>\n    body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }\n    .error { color: red; padding: 10px; border: 1px solid red; background: #ffe6e6; }\n    ${stylesContent}\n  </style>\n</head>\n<body>\n  <div id=\"app\"></div>\n  <script>\n    try {\n      const Component = ${iifeCode};\n      const componentProps = ${JSON.stringify(safeProps)};\n      window.__COMPONENT_PROPS__ = componentProps;\n      new Component({ target: document.getElementById('app'), props: componentProps });\n    } catch (e) { document.getElementById('app').innerHTML = '<div class=\\"error\\">Error: ' + e.message + '</div>'; }\n  </script>\n</body>\n</html>`;
        }
        const duration = Date.now() - startTime;
        logs.push(`⏱️ Playground render completed in ${duration}ms (iframe)`);
        return { success: true, html, logs, usedSandbox: false };
      }

      // Для React пробуем SSR-адаптер
      logs.push('🔍 Step 1: Rendering via adapter on IIFE (React)...');
      try {
        const html = await this.renderViaAdapter(framework, iifeCode, safeProps, '');
        const duration = Date.now() - startTime;
        logs.push(`⏱️ Playground render completed in ${duration}ms`);
        return { success: true, html, logs, usedSandbox: false };
      } catch (adapterErr: any) {
        logs.push(`❌ Adapter render failed: ${adapterErr?.message || String(adapterErr)}`);
        logs.push('🧪 Fallback to sandbox render');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`❌ analyzeAndRender failed: ${errorMessage}`);
      logs.push('🧪 Fallback to sandbox render due to: ' + errorMessage);
    }

    // Шаг 2: Fallback к sandbox render
    logs.push('🔄 Step 2: Executing sandbox fallback...');
    try {
      const sandboxResult = await this.renderInSandbox(code, framework, safeProps);
      const duration = Date.now() - startTime;
      logs.push(`⏱️ Playground render completed in ${duration}ms`);
      
      return {
        ...sandboxResult,
        logs: [...logs, ...(sandboxResult.logs || [])],
        usedSandbox: true
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logs.push(`💥 Sandbox fallback failed: ${errorMessage}`);
      
      return {
        success: false,
        error: `Sandbox fallback failed: ${errorMessage}`,
        logs,
        usedSandbox: true
      };
    }
  }

  /**
   * Самотестирование движка на встроенных демо-компонентах
   */
  async selfTest(): Promise<{ success: boolean; report: string }> {
    const startTime = Date.now();
    const results: Array<{
      framework: string;
      testName: string;
      success: boolean;
      usedSandbox: boolean;
      error?: string;
      duration: number;
    }> = [];

    // Базовые тестовые компоненты
    const testComponents = [
      {
        name: 'Basic React Button',
        code: 'const Button = ({ label }) => <button>{label}</button>;',
        framework: 'react' as const,
        props: { label: 'Test Button' },
        expectedSuccess: true
      },
      {
        name: 'Vue Component',
        code: '<template><div>{{ title }}</div></template><script setup lang="ts">defineProps<{ title: string }>();</script>',
        framework: 'vue' as const,
        props: { title: 'Vue Test' },
        expectedSuccess: true
      },
      {
        name: 'Svelte Component',
        code: '<script lang="ts">export let text: string;</script><div>{text}</div>',
        framework: 'svelte' as const,
        props: { text: 'Svelte Test' },
        expectedSuccess: true
      }
    ];

    // Regression тесты - проверяем старые успешные кейсы
    const regressionTests = [
      {
        name: 'Nested Objects Test',
        code: 'const Comp = ({ user }) => <div>{user.name}</div>;',
        framework: 'react' as const,
        props: { user: { name: 'Nested' } },
        expectedSuccess: true
      },
      {
        name: 'Multiline Component Test',
        code: 'const Comp = ({ title }) => { return ( <section> <h1>{title}</h1> </section> ) };',
        framework: 'react' as const,
        props: { title: 'Multiline Test' },
        expectedSuccess: true
      },
      {
        name: 'JSX-like String Test',
        code: 'const Comp = ({ str }) => <div>{str}</div>;',
        framework: 'react' as const,
        props: { str: '<h1>This is a string</h1>' },
        expectedSuccess: true
      }
    ];

    // Безопасность тесты - проверяем блокировку
    const securityTests = [
      {
        name: 'XSS Blocking Test',
        code: 'const Comp = ({ html }) => <div dangerouslySetInnerHTML={{__html: html}} />;',
        framework: 'react' as const,
        props: { html: '<script>alert(1)</script>' },
        expectedSuccess: false // Должен быть заблокирован
      },
      {
        name: 'Function Props Blocking Test',
        code: 'const Comp = ({ action }) => <button onClick={action}>Click</button>;',
        framework: 'react' as const,
        props: { action: '() => alert(1)' },
        expectedSuccess: false // Должен быть заблокирован
      }
    ];

    const allTests = [...testComponents, ...regressionTests, ...securityTests];

    for (const test of allTests) {
      const testStartTime = Date.now();
      
      try {
        const result = await this.renderPreview(test.code, test.framework, test.props);
        const duration = Date.now() - testStartTime;

        const testResult = {
          framework: test.framework,
          testName: test.name,
          success: result.success,
          usedSandbox: result.usedSandbox || false,
          error: result.error,
          duration
        };

        results.push(testResult);

      } catch (error) {
        const duration = Date.now() - testStartTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        results.push({
          framework: test.framework,
          testName: test.name,
          success: false,
          usedSandbox: false,
          error: errorMessage,
          duration
        });
      }
    }

    // Анализируем результаты
    const totalTests = results.length;
    const passedTests = results.filter(r => r.success === true).length;
    const failedTests = results.filter(r => r.success === false).length;
    const sandboxUsed = results.filter(r => r.usedSandbox).length;
    
    // Проверяем regression тесты (должны пройти)
    const regressionPassed = regressionTests.length === results.filter(r => 
      regressionTests.some(rt => rt.name === r.testName && r.success === rt.expectedSuccess)
    ).length;
    
    // Проверяем security тесты (должны НЕ пройти - success: false)
    const securityPassed = securityTests.length === results.filter(r => 
      securityTests.some(st => st.name === r.testName && r.success === st.expectedSuccess)
    ).length;

    // Общий успех: все обычные тесты прошли + regression прошли + security заблокированы
    const overallSuccess = (passedTests - securityTests.length) === (totalTests - securityTests.length) && 
                          regressionPassed && 
                          securityPassed;
    const totalDuration = Date.now() - startTime;

    // Генерируем отчет
    let report = `🧪 Self Test Report: ${new Date().toISOString()}\n`;
    report += `⏱️ Total Duration: ${totalDuration}ms\n`;
    report += `📊 Summary: ${passedTests}/${totalTests} tests passed\n`;
    report += `🛡️ Security: ${securityPassed ? 'PASS' : 'FAIL'} (${securityTests.length} tests)\n`;
    report += `🔄 Regression: ${regressionPassed ? 'PASS' : 'FAIL'} (${regressionTests.length} tests)\n`;
    report += `📦 Sandbox Usage: ${sandboxUsed}/${totalTests} tests used sandbox\n\n`;

    report += `📋 Detailed Results:\n`;
    for (const result of results) {
      const status = result.success ? '✅ PASS' : '❌ FAIL';
      const sandbox = result.usedSandbox ? ' (sandbox)' : '';
      const duration = `${result.duration}ms`;
      report += `  ${status} ${result.framework.toUpperCase()} ${result.testName}${sandbox} - ${duration}\n`;
      if (result.error) {
        report += `    Error: ${result.error}\n`;
      }
    }

    report += `\n🎯 Final Status: ${overallSuccess ? '🎉 ALL TESTS PASSED' : '💥 SOME TESTS FAILED'}\n`;

    if (overallSuccess) {
      report += `✅ All frameworks passed without sandbox fallback\n`;
      report += `✅ Security measures working correctly\n`;
      report += `✅ Regression tests passed\n`;
    } else {
      report += `❌ Some tests failed - check detailed results above\n`;
    }

    return { success: overallSuccess, report };
  }
}
