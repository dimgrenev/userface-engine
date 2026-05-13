/**
 * SOURCE OF TRUTH (browser runtime)
 * This file is copied to public/runtime/engine/userface-engine.js by engine/scripts/build-public.js.
 * Do not edit public/runtime/engine/userface-engine.js directly.
 *
 * UserfaceEngine - Центральный движок системы
 * Универсальный анализ, компиляция и рендеринг компонентов
 */

class UfError extends Error {
  constructor({ code, phase, owner, message, details }) {
    super(String(message || 'Unknown error'));
    this.name = 'UfError';
    this.code = String(code || 'UF400');
    this.phase = String(phase || 'unknown');
    this.owner = String(owner || 'renderer');
    this.details = details || null;
  }
}

function __uf_hash(s) {
  try {
    const str = String(s || '');
    let h = 2166136261; // FNV-1a
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return `fnv1a:${h.toString(16)}:${str.length}`;
  } catch {
    return 'fnv1a:0:0';
  }
}

function isUfCode(s) {
  try { return /^UF\\d{3}$/.test(String(s || '').trim()); } catch { return false; }
}

function toUfError(err, meta) {
  try {
    if (err && typeof err === 'object') {
      if (isUfCode(err.code)) return err;
      if (err.uf && typeof err.uf === 'object' && isUfCode(err.uf.code)) {
        err.code = err.uf.code;
        err.phase = err.uf.phase;
        err.owner = err.uf.owner;
        err.details = err.uf.details;
        return err;
      }
    }
  } catch (_) {}

  const msg = String((err && err.message) ? err.message : (err || 'Unknown error'));
  const lower = msg.toLowerCase();
  let code = 'UF400';
  let owner = (meta && meta.owner) ? String(meta.owner) : 'renderer';
  let phase = (meta && meta.phase) ? String(meta.phase) : 'unknown';

  if (lower.includes('component spec not found') || lower.includes('source file not found') || lower.includes('cannot resolve') || lower.includes('missing dependency')) {
    code = 'UF200';
    owner = 'component';
  } else if (lower.includes('sanitiz') || lower.includes('babel') || lower.includes('transformation') || lower.includes('parse') || lower.includes('parsing')) {
    code = 'UF100';
    owner = owner || 'renderer';
  } else if (lower.includes('adapter not found') || lower.includes('adapter not available') || lower.includes('only available in the browser')) {
    code = 'UF600';
    owner = 'compat';
  } else if (lower.includes('css') && (lower.includes('fail') || lower.includes('error'))) {
    code = 'UF300';
    owner = owner || 'renderer';
  }

  return new UfError({
    code,
    phase,
    owner,
    message: msg,
    details: (meta && meta.details) ? meta.details : (meta || null),
  });
}

class UserfaceEngine {
  constructor(options = {}) {
    this.React = options.React;
    this.Babel = options.Babel;
    this.Vue = options.Vue;
    this.Svelte = options.Svelte;
    // Optional injected helpers (npm-ready; avoid window globals)
    this.PropExtractor = options.PropExtractor || null;
    this.zodPropsValidator = options.zodPropsValidator || null;
    this.debug = options.debug || false;

    // Optional dependencies for npm-ready engine usage (no window globals):
    // - bundler(entryPath, vfs, { externals }) -> { code, ... }
    // - externals: array of package names to treat as external
    this.bundler = options.bundler || null;
    this.externals = Array.isArray(options.externals) ? options.externals.slice() : null;
    
    // VFS для хранения компонентов и стилей
    this.vfs = new Map();
    
    // Реестр компонентов
    this.componentRegistry = new Map();
    
    // Zod валидатор
    this.zodValidator = null;
    this.initializeZodValidator();
    
    // Инициализируем адаптеры после загрузки
    this.adapters = {};
    // Промис готовности адаптеров, чтобы дождаться инициализации перед рендером
    this._resolveAdaptersReady = null;
    this._adaptersResolved = false;
    this.adaptersReady = new Promise((resolve) => {
      this._resolveAdaptersReady = () => {
        if (!this._adaptersResolved) {
          this._adaptersResolved = true;
          resolve();
        }
      };
    });
    this.initializeAdapters();
    
    this.log('Engine initialized');
  }

  /**
   * Инициализация Zod валидатора
   */
  async initializeZodValidator() {
    try {
      if (this.zodPropsValidator) {
        this.zodValidator = this.zodPropsValidator;
        this.log('Zod validator initialized (injected)');
      } else if (typeof globalThis !== 'undefined' && globalThis.zodPropsValidator) {
        this.zodValidator = globalThis.zodPropsValidator;
        this.log('Zod validator initialized (globalThis)');
      } else if (typeof window !== 'undefined' && window.zodPropsValidator) {
        this.zodValidator = window.zodPropsValidator;
        this.log('Zod validator initialized (window)');
      } else {
        // В Node.js среде валидатор пока недоступен
        this.zodValidator = null;
        this.log('Zod validator not available in Node.js environment');
      }
    } catch (error) {
      this.log('Zod validator initialization failed:', error.message);
      this.zodValidator = null;
    }
  }

  /**
   * Инициализация адаптеров
   */
  async initializeAdapters() {
    try {
      // Загружаем адаптеры
      // Определяем среду корректно: require используем ТОЛЬКО в Node.js (где window ДЕЙСТВИТЕЛЬНО undefined)
      if (typeof window === 'undefined' && typeof require === 'function' && typeof module !== 'undefined' && module.exports) {
        const { ReactAdapter, VueAdapter, SvelteAdapter } = require('./adapters.js');
        this.adapters = {
          react: new ReactAdapter(this),
          vue: new VueAdapter(this),
          svelte: new SvelteAdapter(this)
        };
        if (this._resolveAdaptersReady) this._resolveAdaptersReady();
      } else {
        // В браузере - ждем загрузки адаптеров, но не бесконечно
        let attempts = 0;
        const maxAttempts = 50; // ~5 секунд при интервале 100мс
        const checkAdapters = () => {
          if ((typeof globalThis !== 'undefined' && globalThis.ReactAdapter && globalThis.VueAdapter && globalThis.SvelteAdapter) ||
              (typeof window !== 'undefined' && window.ReactAdapter && window.VueAdapter && window.SvelteAdapter)) {
            const getAdapter = (name) => {
               if (typeof globalThis !== 'undefined' && globalThis[name]) return globalThis[name];
               if (typeof window !== 'undefined' && window[name]) return window[name];
               return null;
            };
            const ReactAdapterClass = getAdapter('ReactAdapter');
            const VueAdapterClass = getAdapter('VueAdapter');
            const SvelteAdapterClass = getAdapter('SvelteAdapter');

            this.adapters = {
              react: new ReactAdapterClass(this),
              vue: new VueAdapterClass(this),
              svelte: new SvelteAdapterClass(this)
            };
            this.log('Adapters initialized successfully');
            if (this._resolveAdaptersReady) this._resolveAdaptersReady();
          } else if (attempts++ >= maxAttempts) {
            this.log('Adapters did not load in time, using fallback adapters');
            this.createFallbackAdapters();
            if (this._resolveAdaptersReady) this._resolveAdaptersReady();
          } else {
            setTimeout(checkAdapters, 100);
          }
        };
        checkAdapters();
      }
    } catch (error) {
      this.log('Failed to initialize adapters:', error.message);
      // Создаем fallback адаптеры
      this.createFallbackAdapters();
      if (this._resolveAdaptersReady) this._resolveAdaptersReady();
    }
  }

  /**
   * Создание fallback адаптеров
   */
  createFallbackAdapters() {
    this.adapters = {
      react: {
        render: async (spec, props) => {
          throw new Error('React adapter not available');
        }
      },
      vue: {
        render: async (spec, props) => {
          throw new Error('Vue adapter not available');
        }
      },
      svelte: {
        render: async (spec, props) => {
          throw new Error('Svelte adapter not available');
        }
      }
    };
  }

  /**
   * Анализ компонента и создание JSON-спецификации
   */
  async analyzeComponent(files, options = {}) {
    this.log('Starting component analysis', files.length, 'files');
    
    try {
      // Определяем фреймворк
      const framework = this.detectFramework(files);
      this.log('Framework detected:', framework);
      
      // Deterministic entry: entryPath is required for render-grade analysis.
      // Without it, selecting "first .tsx" is non-deterministic and breaks specId identity.
      const entryPath = (() => {
        try { return String(options && options.entryPath ? options.entryPath : ''); } catch { return ''; }
      })();
      if (!entryPath) {
        throw new UfError({
          code: 'UF200',
          phase: 'engine_analyze',
          owner: 'renderer',
          message: 'entryPath is required for analyzeComponent (deterministic entry)',
          details: { hint: 'Pass analyzeComponent(files, { entryPath })', files: (files || []).map(f => f && f.name).filter(Boolean) }
        });
      }

      // Находим главный файл компонента
      const mainFile = this.findMainFile(files, framework, { ...options, entryPath });
      if (!mainFile) {
        throw new Error('Main component file not found');
      }
      
      this.log('Main file found:', mainFile.name);
      
      // Парсим код и извлекаем props
      const parseResult = await this.parseCode(mainFile.content, framework);
      this.log('Code parsed, props found:', parseResult.props.length);
      
      // Извлекаем стили
      const styles = this.extractStyles(files);
      try {
        this.log('Styles extracted:', (typeof styles === 'string') ? styles.length : 0, 'chars');
      } catch {
        this.log('Styles extracted');
      }
      
      // Создаем JSON-спецификацию
      const spec = this.createComponentSpec(
        mainFile.name.replace(/\.(tsx?|vue|svelte)$/, ''),
        framework,
        parseResult,
        styles,
        files
      );

      // Debug diagnostics (only when engine debug is enabled)
      try {
        if (this.debug) {
          spec.diagnostics = {
            entryPath: String(entryPath || ''),
            specId: String(mainFile.name || '').replace(/\.(tsx|jsx|ts|js|vue|svelte)$/i, ''),
            files: (files || []).map(f => String(f && f.name || '')).filter(Boolean),
            filesHash: __uf_hash((files || []).map(f => String(f && f.name || '') + ':' + __uf_hash(f && f.content || '')).join('|')),
            stylesHash: __uf_hash(String(styles || '')),
            codeHash: __uf_hash(String(mainFile && mainFile.content || ''))
          };
        }
      } catch (_) {}

      // IMPORTANT: always store entryPath in metadata so findSourceFile can locate the correct
      // entry file deterministically (spec.name has the extension stripped).
      try {
        if (spec && spec.metadata) {
          spec.metadata.entryPath = String(entryPath || mainFile.name || '');
        }
      } catch (_) {}

      // Регистрируем компонент
      this.registerComponent(spec);
      
      // Регистрируем Zod схему для валидации
      if (this.zodValidator) {
        this.zodValidator.registerSchema(spec.name, spec.props);
        this.log('Zod schema registered for:', spec.name);
      }
      
      // Сохраняем в VFS
      this.saveToVFS(files, spec);
      
      this.log('Component analysis completed:', spec.name);
      return spec;
      
    } catch (error) {
      const uf = toUfError(error, {
        phase: 'engine_analyze',
        owner: 'renderer',
        details: {
          files: (files || []).map(f => f && f.name).filter(Boolean),
          entryPath: (() => { try { return String(options && options.entryPath ? options.entryPath : ''); } catch { return ''; } })()
        }
      });
      this.log('Component analysis failed:', uf.message);
      throw uf;
    }
  }

  /**
   * Рендеринг компонента из JSON-спецификации
   */
  async renderFromSpec(specName, props) {
    this.log('Starting render from spec:', specName);
    
    try {
      // Гарантируем, что адаптеры готовы
      if (this.adaptersReady && typeof this.adaptersReady.then === 'function') {
        await this.adaptersReady;
      }
      
      // Получаем спецификацию (с резолюцией base->entry для устойчивости)
      let spec = this.getComponentSpec(specName);
      if (!spec) {
        const resolved = this.resolveSpecName(specName);
        if (resolved && resolved !== specName) {
          this.log('Resolved specName:', specName, '->', resolved);
          specName = resolved;
          spec = this.getComponentSpec(specName);
        }
      }
      if (!spec) {
        throw new Error(`Component spec not found: ${specName}`);
      }
      
      this.log('Spec found, framework:', spec.framework);
      
      // Валидируем props через Zod
      if (this.zodValidator) {
        const validation = this.zodValidator.validate(specName, props);
        if (!validation.success) {
          this.log('Props validation failed:', validation.errors);
          // Не бросаем ошибку, просто логируем предупреждение
          this.log('Warning: Using props without validation');
        } else {
          this.log('Props validation passed');
          props = validation.data; // Используем валидированные props с default значениями
        }
      }
      
      // Проверяем наличие адаптера
      const adapter = this.adapters[spec.framework];
      if (!adapter) {
        throw new Error(`Adapter not found for framework: ${spec.framework}`);
      }
      
      // Рендерим через адаптер
      const result = await adapter.render(spec, props);

      // Строгая проверка формы результата до возврата
      if (!result || typeof result !== 'object') {
        throw new Error('Adapter returned invalid result: not an object');
      }
      if (!('type' in result)) {
        throw new Error('Adapter returned result without type');
      }
      if (!('data' in result)) {
        throw new Error('Adapter returned result without data');
      }
      const data = result.data || {};
      const missing = [];
      if (typeof data.componentCode !== 'string' || !data.componentCode.trim()) missing.push('componentCode');
      if (typeof data.componentName !== 'string' || !data.componentName.trim()) missing.push('componentName');
      if (!('props' in data)) missing.push('props');
      if (!('files' in data)) missing.push('files');
      if (missing.length) {
        throw new Error(`Adapter returned incomplete data: missing ${missing.join(', ')}`);
      }

      this.log('Render completed successfully');
      
      return result;
      
    } catch (error) {
      const uf = toUfError(error, {
        phase: 'engine_render',
        owner: 'renderer',
        details: { requested: specName }
      });
      this.log('Render from spec failed:', uf.message);
      throw uf;
    }
  }

  /**
   * Валидация props для компонента
   */
  validateProps(componentName, props) {
    if (!this.zodValidator) {
      return {
        success: true,
        data: props,
        errors: []
      };
    }
    
    return this.zodValidator.validate(componentName, props);
  }

  /**
   * Определение фреймворка по файлам
   */
  detectFramework(files) {
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
  findMainFile(files, framework, options = {}) {
    const extensions = {
      react: ['.tsx', '.jsx', '.ts', '.js'],
      vue: ['.vue'],
      svelte: ['.svelte']
    };
    
    const validExtensions = extensions[framework] || extensions.react;

    // Prefer explicit entryPath when provided (canonical).
    try {
      const entryPath = options && options.entryPath ? String(options.entryPath) : '';
      if (entryPath) {
        const exact = (files || []).find(f => String(f && f.name) === entryPath);
        if (exact) return exact;
      }
    } catch (_) {}
    
    const candidates = (files || []).filter((file) => {
      try {
        const name = String(file && file.name || '');
        return validExtensions.some((ext) => name.endsWith(ext));
      } catch {
        return false;
      }
    });
    if (candidates.length === 0) return null;

    const leafNoExt = (p) => {
      const s = String(p || '');
      const base = s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
      return base.replace(/\.(tsx|jsx|ts|js|vue|svelte)$/i, '');
    };
    const parentDir = (p) => {
      const s = String(p || '');
      const dir = s.includes('/') ? s.slice(0, s.lastIndexOf('/')) : '';
      return dir ? (dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir) : '';
    };
    const score = (name) => {
      const n = String(name || '');
      const lower = n.toLowerCase();
      let s = 0;
      // Prefer executable entries over barrels.
      if (/\/index\.ts$/i.test(lower)) s -= 50;
      if (/\/index\.(tsx|jsx|js|vue|svelte)$/i.test(lower)) s += 40;
      if (/\.(tsx|jsx)$/i.test(lower)) s += 30;
      if (/\.(ts)$/i.test(lower)) s += 10;
      if (/\.(js)$/i.test(lower)) s += 5;
      // Prefer leaf file matching its parent folder (e.g. components/components.tsx).
      try {
        const leaf = leafNoExt(lower);
        const parent = parentDir(lower);
        if (leaf && parent && leaf === parent) s += 80;
      } catch (_) {}
      // De-prioritize generated gallery entries unless nothing else exists.
      if (lower.includes('__render_gallery')) s -= 30;
      // De-prioritize obvious non-entry patterns.
      if (/\.(test|spec)\./i.test(lower)) s -= 100;
      if (/\.d\.ts$/i.test(lower)) s -= 1000;
      return s;
    };

    return candidates
      .slice()
      .sort((a, b) => {
        const an = String(a && a.name || '');
        const bn = String(b && b.name || '');
        const d = score(bn) - score(an);
        return d !== 0 ? d : an.localeCompare(bn);
      })[0];
  }

  /**
   * Парсинг кода компонента
   */
  async parseCode(code, framework) {
    this.log('Parsing code for framework:', framework);
    
    try {
      // Пробуем SWC
      if (this.canUseSWC()) {
        return await this.parseWithSWC(code, framework);
      }
      
      // Пробуем Babel
      if (this.Babel) {
        return await this.parseWithBabel(code, framework);
      }
      
      // Fallback на regex
      return this.parseWithRegex(code, framework);
      
    } catch (error) {
      this.log('Parse failed, using regex fallback:', error.message);
      return this.parseWithRegex(code, framework);
    }
  }

  /**
   * Парсинг через SWC
   */
  async parseWithSWC(code, framework) {
    this.log('Parsing with SWC');
    // TODO: Implement SWC parsing
    throw new Error('SWC not implemented yet');
  }

  /**
   * Парсинг через Babel
   */
  async parseWithBabel(code, framework) {
    this.log('Parsing with Babel');
    
    try {
      const Babel = this.Babel || (typeof globalThis !== 'undefined' && globalThis.Babel) || (typeof window !== 'undefined' ? window.Babel : null);
      if (!Babel) {
        throw new Error('Babel not available');
      }
      // 🔧 ИСПРАВЛЕНИЕ: Правильная конфигурация для Babel Standalone
      const presetTS = Babel?.availablePresets?.typescript;
      const presetReact = Babel?.availablePresets?.react;
      const pluginUMD = Babel?.availablePlugins?.['transform-modules-umd'];
      
      if (!presetTS || !presetReact || !pluginUMD) {
          console.error('[Engine] ❌ Babel presets or UMD plugin not available');
          console.error('[Engine] Available presets:', Object.keys(Babel?.availablePresets || {}));
          console.error('[Engine] Available plugins:', Object.keys(Babel?.availablePlugins || {}));
          throw new Error('Babel presets or UMD plugin not available');
      }
      
      // 🔧 ИСПРАВЛЕНИЕ: Используем правильные опции для TypeScript пресета
      const babelConfig = {
        presets: [
          [presetTS, { 
            isTSX: true, 
            allExtensions: true,
            allowNamespaces: true,
            allowDeclareFields: true,
            onlyRemoveTypeImports: true
          }],
          [presetReact, { 
            runtime: 'classic', 
            pragma: 'React.createElement',
            pragmaFrag: 'React.Fragment'
          }]
        ],
        plugins: [
          pluginUMD,
          Babel?.availablePlugins?.['proposal-optional-chaining'] || '@babel/plugin-proposal-optional-chaining'
        ],
        sourceType: 'module',
        filename: 'component.tsx'
      };
      
      let result;
      try {
        result = Babel.transform(code, babelConfig);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        
        // 🔧 ИСПРАВЛЕНИЕ: Структурированная обработка ошибок Flow
        if (/experimental syntax 'flow'|\b@flow\b/i.test(msg)) {
          console.error('[Engine] ❌ Flow syntax detected and rejected');
          throw {
            name: 'FlowSyntaxError',
            message: 'Flow syntax is not supported. Please use TypeScript syntax instead.',
            code: 'FLOW_NOT_SUPPORTED',
            originalError: e
          };
        }
        
        // 🔧 ИСПРАВЛЕНИЕ: Другие ошибки трансформации
        console.error('[Engine] ❌ Babel transformation error:', msg);
        throw {
          name: 'BabelTransformError',
          message: `TypeScript transformation failed: ${msg}`,
          code: 'BABEL_TRANSFORM_FAILED',
          originalError: e
        };
      }
      
      if (!result || !result.code) {
        throw new Error('Babel transformation failed - no result');
      }
      
      let transformedCode = result.code;
      
      // ОТКЛЮЧАЕМ повторную санитизацию - Babel уже сделал всё нужное

      
      // 🔧 ИСПРАВЛЕНИЕ: Извлекаем props и interfaces из уже преобразованного кода.
      const props = this.extractPropsWithRegex(code, framework); // Используем исходный код для извлечения props
      const interfaces = this.extractInterfacesWithRegex(code);
      
      return {
        code: `(function() {
          const exports = {};
          const module = { exports: {} };
          const require = (name) => {
            if (name === 'react') return React;
            if (name === 'react-dom') return ReactDOM;
            return {};
          };
          
          ${transformedCode}
          
          return exports.default || module.exports.default || (typeof _DefaultExport !== 'undefined' ? _DefaultExport : null);
        })()`,
        props,
        interfaces
      };
      
    } catch (babelError) {
      const message = babelError && babelError.message ? babelError.message : String(babelError);
      console.error('[Engine] ❌ BABEL TRANSFORMATION FAILED:', message);
      if (/Flow syntax is unsupported/i.test(message)) {
        throw new Error('Flow syntax is unsupported. Use valid TypeScript or JSX.');
      }
      console.error('[Engine] Babel error details:', babelError);
      throw new Error('Babel transformation failed: ' + message);
    }
  }

  /**
   * Очистка от остаточных import/export выражений.
   */
  cleanImportsAndExports(code) {
    this.log('Cleaning final code from import/export statements...');
    
    // Удаляем import/export, которые могли остаться
    let cleanedCode = code
      .replace(/^import\s+.*\s+from\s+['"]*.*['"]*;?/gm, '') // import ... from '...'
      .replace(/^export\s+default\s+/gm, 'return ')         // export default ... -> return ...
      .replace(/^export\s+\{/gm, '')                       // export { ... }
      .replace(/\}\s+from\s+['"]*.*['"]*;?/gm, '');      // } from '...'
      
    // Дополнительная очистка для `export default MyComponent;` -> `return MyComponent;`
    cleanedCode = cleanedCode.replace(/export default (\w+);/g, 'return $1;');
    
    // Исправляем случаи, где остался просто `default`
    cleanedCode = cleanedCode.replace(/^default\s+/gm, 'return ');

    return cleanedCode.trim();
  }

  /**
   * Обертка кода в IIFE (Immediately Invoked Function Expression).
   */
  wrapInIIFE(code) {
    this.log('Wrapping code in IIFE...');
    // Проверяем, не обернут ли код уже
    if (code.startsWith('(function()') && code.endsWith('})();')) {
        return code;
    }
    return `(function() {\n${code}\n})();`;
  }

  /**
   * Финальная валидация кода на наличие запрещенных конструкций.
   */
  validateFinalCode(code) {
    this.log('Validating final code...');
    const forbiddenPatterns = [
      { pattern: /\bimport\b/g, name: 'import statement' },
      { pattern: /\bexport\b/g, name: 'export statement' },
      { pattern: /module\.exports/g, name: 'module.exports' },
      { pattern: /exports\./g, name: 'exports.' }
    ];

    for (const { pattern, name } of forbiddenPatterns) {
      if (pattern.test(code)) {
        const match = code.match(pattern);
        const context = code.substring(Math.max(0, match.index - 30), Math.min(code.length, match.index + 30));
        console.error(`[Engine] ❌ Validation failed: Found forbidden ${name}.`);
        console.error(`[Engine] Context: ...${context}...`);
        throw new Error(`Validation failed: Forbidden ${name} found in final code.`);
      }
    }
    
  }


  /**
   * Парсинг через regex (fallback)
   */
  parseWithRegex(code, framework) {
    this.log('Parsing with regex fallback');
    
    const props = this.extractPropsWithRegex(code, framework);
    const interfaces = this.extractInterfacesWithRegex(code);
    
    return {
      props,
      interfaces,
      cleanCode: this.cleanTypeScriptCode(code)
    };
  }

  /**
   * Извлечение props через regex
   */
  extractPropsWithRegex(code, framework) {
    const pe = this.PropExtractor || (typeof globalThis !== 'undefined' && globalThis.PropExtractor) || (typeof window !== 'undefined' ? window.PropExtractor : null);

    // ВСЕГДА используем PropExtractor
    if (pe) {
      try {
        const props = pe.extract(code, framework);
        return props;
      } catch (e) {
        console.error('[Engine] ❌ Error using PropExtractor:', e);
        // Fallback to regex if PropExtractor fails
      }
    }

    const props = [];
    
    if (framework === 'react') {
      // React props из интерфейсов
      const interfaceRegex = /interface\s+(\w+)(?:\s+extends[^{]+)?\s*\{([^}]+)\}/g;
      let match;
      
      while ((match = interfaceRegex.exec(code)) !== null) {
        const interfaceBody = match[2];
        const propRegex = /(\w+)(\??):\s*([^;,\n]+)/g;
        let propMatch;
        
        while ((propMatch = propRegex.exec(interfaceBody)) !== null) {
          props.push({
            name: propMatch[1],
            type: this.mapTypeToSimple(propMatch[3].trim()),
            required: !propMatch[2],
            description: `${propMatch[1]} prop`
          });
        }
      }
    } else if (framework === 'vue') {
      // Vue props из defineProps или props объекта
      const definePropsRegex = /defineProps<([^>]+)>/;
      const match = code.match(definePropsRegex);
      
      if (match) {
        const propsType = match[1];
        const propRegex = /(\w+)(\??):\s*([^;,\n]+)/g;
        let propMatch;
        
        while ((propMatch = propRegex.exec(propsType)) !== null) {
          props.push({
            name: propMatch[1],
            type: this.mapTypeToSimple(propMatch[3].trim()),
            required: !propMatch[2],
            description: `${propMatch[1]} prop`
          });
        }
      }
    } else if (framework === 'svelte') {
      // Svelte props из export let
      const propRegex = /export\s+let\s+(\w+)(?:\s*:\s*([^=;]+))?(?:\s*=\s*([^;]+))?/g;
      let match;
      
      while ((match = propRegex.exec(code)) !== null) {
        const defaultValue = match[3];
        props.push({
          name: match[1],
          type: match[2] ? this.mapTypeToSimple(match[2].trim()) : 'any',
          required: !defaultValue,
          defaultValue: defaultValue ? defaultValue.trim() : undefined,
          description: `${match[1]} prop`
        });
      }
    }
    
    return props;
  }

  /**
   * Извлечение интерфейсов через regex
   */
  extractInterfacesWithRegex(code) {
    const interfaces = [];
    const interfaceRegex = /interface\s+(\w+)\s*\{([^}]+)\}/g;
    let match;
    
    while ((match = interfaceRegex.exec(code)) !== null) {
      const name = match[1];
      const body = match[2];
      const properties = [];
      
      const propRegex = /(\w+)(\??):\s*([^;,\n]+)/g;
      let propMatch;
      
      while ((propMatch = propRegex.exec(body)) !== null) {
        properties.push({
          name: propMatch[1],
          type: propMatch[3].trim(),
          required: !propMatch[2]
        });
      }
      
      interfaces.push({ name, properties });
    }
    
    return interfaces;
  }

  /**
   * Очистка TypeScript кода до чистого JavaScript с сохранением JSX
   */
  cleanTypeScriptCode(code) {
    
    // 🔧 ИСПРАВЛЕНИЕ: Убираю ВСЕ regex-замены, использую только Babel
    
    // Шаг 1: Пропускаем предварительную валидацию сырым JS — всегда доверяем Babel
    
    // 🔧 ИСПРАВЛЕНИЕ: Используем Babel с правильными пресетами
    
    const Babel = this.Babel || (typeof window !== 'undefined' ? window.Babel : null);
    if (!Babel) {
      throw new Error('Babel not available for TypeScript transformation');
    }
    
    try {
      // 🔧 ИСПРАВЛЕНИЕ: Правильная конфигурация Standalone пресетов
      const presetTS = Babel?.availablePresets?.typescript;
      const presetReact = Babel?.availablePresets?.react;
      
      if (!presetTS || !presetReact) {
        console.error('[Engine] ❌ Babel presets not available in cleanTypeScriptCode');
        console.error('[Engine] Available presets:', Object.keys(Babel?.availablePresets || {}));
        throw new Error('Babel presets not available: typescript/react');
      }
      
      const babelConfig = {
        presets: [
          [presetTS, { 
            isTSX: true, 
            allExtensions: true,
            allowNamespaces: true,
            allowDeclareFields: true,
            onlyRemoveTypeImports: true
          }],
          [presetReact, { 
            runtime: 'classic', 
            pragma: 'React.createElement',
            pragmaFrag: 'React.Fragment'
          }]
        ],
        plugins: [],
        sourceType: 'module',
        filename: 'component.tsx'
      };
      
      const result = Babel.transform(code, babelConfig);
      
      if (!result || !result.code) {
        throw new Error('Babel transformation failed - no result');
      }
      
      let cleaned = result.code;
      
      // 🔧 Очистка require()/module.exports (если вдруг появились)
      cleaned = cleaned.replace(/const\s+\w+\s*=\s*require\([^)]+\);/g, '');
      cleaned = cleaned.replace(/var\s+\w+\s*=\s*require\([^)]+\);/g, '');
      cleaned = cleaned.replace(/let\s+\w+\s*=\s*require\([^)]+\);/g, '');
      cleaned = cleaned.replace(/module\.exports\s*=\s*[^;]+;/g, '');
      
      // 🔧 Финализация: удаляем import/export и TS-хвосты для безопасного исполнения
      const finalized = this.finalizeCodeForIframe(cleaned);
      
      // Финальная валидация уже финализированного кода
      try {
        new Function(finalized);
      } catch (error) {
        console.error('[Engine] ❌ FINAL CODE VALIDATION FAILED:', error.message);
        console.error('[Engine] Invalid final code:', finalized);
        throw new Error('Final code validation failed: ' + error.message);
      }
      
      return finalized;
      
    } catch (babelError) {
      const message = babelError && babelError.message ? babelError.message : String(babelError);
      console.error('[Engine] ❌ BABEL TRANSFORMATION FAILED in cleanTypeScriptCode:', message);
      
      // 🔧 ИСПРАВЛЕНИЕ: Структурированная обработка ошибок Flow
      if (/experimental syntax 'flow'|\b@flow\b/i.test(message)) {
        console.error('[Engine] ❌ Flow syntax detected in cleanTypeScriptCode');
        throw {
          name: 'FlowSyntaxError',
          message: 'Flow syntax is not supported. Please use TypeScript syntax instead.',
          code: 'FLOW_NOT_SUPPORTED',
          originalError: babelError
        };
      }
      
      console.error('[Engine] Babel error details:', babelError);
      throw {
        name: 'BabelTransformError',
        message: `TypeScript transformation failed in cleanTypeScriptCode: ${message}`,
        code: 'BABEL_TRANSFORM_FAILED',
        originalError: babelError
      };
    }
  }

  /**
   * Финализация кода для iframe (удаление import/export, подготовка для eval)
   */
  finalizeCodeForIframe(code) {
    let finalized = code;
    
    
    // 🔥 АГРЕССИВНОЕ УДАЛЕНИЕ ВСЕХ IMPORT STATEMENTS
    // 1. import React from 'react'
    finalized = finalized.replace(/import\s+\w+\s+from\s+['"][^'"]*['"];?/g, '');
    
    // 2. import { useState, useEffect } from 'react'
    finalized = finalized.replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?/g, '');
    
    // 3. import * as React from 'react'
    finalized = finalized.replace(/import\s+\*\s+as\s+\w+\s+from\s+['"][^'"]*['"];?/g, '');
    
    // 4. import 'styles.css' (side effects)
    finalized = finalized.replace(/import\s+['"][^'"]*['"];?/g, '');
    
    // 5. import type (любые)
    finalized = finalized.replace(/import\s+type\s+[^;]+;?/g, '');
    
    // 🔥 АГРЕССИВНОЕ УДАЛЕНИЕ ВСЕХ EXPORT STATEMENTS
    // 1. export default Component
    finalized = finalized.replace(/export\s+default\s+/g, '');
    
    // 2. export { Component, Button }
    finalized = finalized.replace(/export\s+\{[^}]*\};?/g, '');
    
    // 3. export const Component = ...
    finalized = finalized.replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ');
    
    // 4. export function Component() {...}
    finalized = finalized.replace(/export\s+function\s+/g, 'function ');
    
    // 5. export class Component {...}
    finalized = finalized.replace(/export\s+class\s+/g, 'class ');
    
    // 6. export type (любые)
    finalized = finalized.replace(/export\s+type\s+[^;]+;?/g, '');
    
    // 🔥 УДАЛЕНИЕ ОСТАВШИХСЯ TypeScript КОНСТРУКЦИЙ
    // Интерфейсы и типы (если остались) - используем более точные regex
    finalized = finalized.replace(/interface\s+\w+\s*\{[\s\S]*?\}/g, '');
    finalized = finalized.replace(/type\s+\w+\s*=\s*[^;]+;?/g, '');
    
    // 🔥 ФИНАЛЬНАЯ ОЧИСТКА
    // Удаляем пустые строки (больше 2 подряд)
    finalized = finalized.replace(/\n\s*\n\s*\n/g, '\n\n');
    
    // Удаляем ведущие пустые строки
    finalized = finalized.replace(/^\s*\n+/g, '');
    
    // Удаляем trailing пустые строки
    finalized = finalized.replace(/\n\s*$/g, '');
    
    finalized = finalized.trim();
    
    console.log(finalized.substring(0, 400) + (finalized.length > 400 ? '...' : ''));
    
    return finalized;
  }

  /**
   * Ручная трансформация JSX для iframe (если Babel недоступен)
   */
  manualJSXTransform(code) {
    let transformed = code;

    // 1. Удаляем все import type (но оставляем обычные import)
    transformed = transformed.replace(/import\s+type\s+[^;]+;/g, '');

    // 2. Удаляем export type
    transformed = transformed.replace(/export\s+type\s+[^;]+;/g, '');

    // 3. Удаляем интерфейсы (многострочные, осторожно с JSX)
    transformed = transformed.replace(/interface\s+\w+\s*\{[\s\S]*?\n\}/g, '');

    // 4. Удаляем типы (многострочные)
    transformed = transformed.replace(/type\s+\w+\s*=\s*[\s\S]*?;/g, '');

    // 5. Удаляем React.FC типизацию
    transformed = transformed.replace(/:\s*React\.FC<[^>]*>/g, '');
    transformed = transformed.replace(/:\s*FC<[^>]*>/g, '');

    // 6. Удаляем дженерики из функций (но НЕ из JSX!)
    // Осторожно: <Component> в JSX != <T> в функции
    transformed = transformed.replace(/function\s+\w+<[^>]*>/g, (match) => {
      return match.replace(/<[^>]*>/, '');
    });
    transformed = transformed.replace(/const\s+\w+\s*=\s*<[^>]*>\s*\(/g, (match) => {
      return match.replace(/<[^>]*>/, '');
    });

    // 7. Удаляем типизацию параметров функций
    // Паттерн: (param: Type) -> (param)
    transformed = transformed.replace(/\(\s*([^)]+)\s*\)/g, (match, params) => {
      // Обрабатываем каждый параметр
      const cleanParams = params.split(',').map(param => {
        // Удаляем типизацию: name: Type -> name (только если это действительно типизация)
        // Проверяем, что это не строка в кавычках и что двоеточие не внутри строки
        if (param.includes(':') && !param.match(/['"\`]/)) {
          // Более точная проверка: удаляем типизацию только если двоеточие не внутри строки
          return param.replace(/:\s*[^,=\)]+(?=\s*[,=\)]|$)/, '').trim();
        }
        return param.trim();
      }).join(', ');
      return `(${cleanParams})`;
    });

    // 8. Удаляем as assertions (осторожно с JSX attributes)
    transformed = transformed.replace(/\s+as\s+[^,);}\]\s]+/g, '');

    // 9. Удаляем опциональные параметры ?
    transformed = transformed.replace(/\?\s*(?=[,):=])/g, '');

    // 10. Удаляем возвращаемые типы функций
    transformed = transformed.replace(/\)\s*:\s*[^{;=]+(?=\s*[{;=])/g, ')');

    // 11. Удаляем типизацию переменных (только если это не строка)
    transformed = transformed.replace(/(const|let|var)\s+(\w+)\s*:\s*[^=]+=/g, (match, keyword, varName) => {
      // Проверяем, что это не строка в кавычках
      if (match.includes('"') || match.includes("'") || match.includes('`')) {
        return match; // Не изменяем строки
      }
      return `${keyword} ${varName} =`;
    });

    // 12. Очистка пустых строк и лишних пробелов
    transformed = transformed.replace(/\n\s*\n\s*\n/g, '\n\n');
    transformed = transformed.replace(/^\s*\n/gm, '');


    return transformed;
  }

  /**
   * Маппинг TypeScript типов в простые типы
   */
  mapTypeToSimple(tsType) {
    const type = tsType.toLowerCase().trim();
    
    if (type.includes('string')) return 'string';
    if (type.includes('number')) return 'number';
    if (type.includes('boolean')) return 'boolean';
    if (type.includes('function') || type.includes('=>')) return 'function';
    if (type.includes('array') || type.includes('[]')) return 'array';
    if (type.includes('object') || type.includes('{}')) return 'object';
    
    return 'any';
  }

  /**
   * Извлечение стилей из файлов
   */
  extractStyles(files) {
    try {
      const list = (files || [])
        .filter(file => file && file.name && (String(file.name).endsWith('.css') || String(file.name).endsWith('.scss') || String(file.name).endsWith('.sass') || String(file.name).endsWith('.less')))
        .map(file => ({ name: String(file.name), content: String(file.content || '') }));

      const score = (n) => {
        const name = String(n || '').toLowerCase();
        // Variables first, then globals, then rest stable (alphabetical)
        if (name.endsWith('variables.css') || name.endsWith('tokens.css')) return 0;
        if (name.endsWith('globals.css') || name.includes('/globals.')) return 1;
        return 2;
      };

      list.sort((a, b) => {
        const sa = score(a.name);
        const sb = score(b.name);
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name);
      });
      return list.map(f => f.content).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Создание JSON-спецификации компонента
   */
  createComponentSpec(name, framework, parseResult, styles, files) {
    // Находим исходный код компонента
    const mainFile = files.find(f => f.name.endsWith('.tsx') || f.name.endsWith('.jsx') || f.name.endsWith('.vue') || f.name.endsWith('.svelte'));
    const code = mainFile ? mainFile.content : '';
    
    return {
      name,
      framework,
      version: '1.0.0',
      code, // Добавляем код компонента
      metadata: {
        fileName: files[0]?.name || `${name}.${framework}`,
        createdAt: new Date().toISOString(),
        interfaces: parseResult.interfaces || [],
        types: []
      },
      props: parseResult.props || [],
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
  registerComponent(spec) {
    this.componentRegistry.set(spec.name, spec);
    this.log('Component registered:', spec.name);
  }

  /**
   * Сохранение в VFS
   */
  saveToVFS(files, spec) {
    const vfsEntry = {
      files: files.map(f => ({ name: f.name, content: f.content })),
      spec,
      timestamp: Date.now()
    };
    
    this.vfs.set(spec.name, vfsEntry);
    this.log('Saved to VFS:', spec.name);
  }

  /**
   * Поиск исходного файла компонента
   */
  findSourceFile(componentName, framework) {
    const vfsEntry = this.vfs.get(componentName);
    if (!vfsEntry) {
      return null;
    }

    // Prefer the deterministic entryPath recorded during analyzeComponent.
    // This avoids accidentally picking the first .tsx in a folder (e.g. Accordion instead of Button).
    const preferredEntry = (() => {
      try {
        const raw =
          String((vfsEntry.spec && vfsEntry.spec.metadata && vfsEntry.spec.metadata.entryPath) || '') ||
          String((vfsEntry.spec && vfsEntry.spec.diagnostics && vfsEntry.spec.diagnostics.entryPath) || '') ||
          String((vfsEntry.spec && vfsEntry.spec.name) || '') ||
          String(componentName || '');
        return raw.replace(/^\/+/, '').trim();
      } catch {
        return '';
      }
    })();
    if (preferredEntry) {
      const exact = vfsEntry.files.find((f) => String((f && f.name) || '') === preferredEntry);
      if (exact) return exact;

      // spec.name strips the file extension (e.g. 'components/Button/Button' from 'components/Button/Button.tsx').
      // Try adding common extensions so we find the actual source file instead of falling through
      // to the non-deterministic "first matching extension" loop below.
      const tryExts = ['.tsx', '.ts', '.jsx', '.js', '.vue', '.svelte'];
      for (const ext of tryExts) {
        const withExt = preferredEntry + ext;
        const found = vfsEntry.files.find((f) => String((f && f.name) || '') === withExt);
        if (found) return found;
      }
    }

    const extensions = {
      react: ['.tsx', '.jsx', '.ts', '.js'],
      vue: ['.vue'],
      svelte: ['.svelte']
    };
    
    const validExtensions = extensions[framework] || extensions.react;
    
    for (const file of vfsEntry.files) {
      for (const ext of validExtensions) {
        if (file.name.endsWith(ext)) {
          return file;
        }
      }
    }
    
    return vfsEntry.files[0]; // fallback
  }

  /**
   * Экспорт JSON-спецификации
   */
  exportSpec(specName) {
    const spec = this.getComponentSpec(specName);
    if (!spec) {
      throw new Error(`Component spec not found: ${specName}`);
    }
    
    return JSON.stringify(spec, null, 2);
  }

  /**
   * Импорт JSON-спецификации
   */
  importSpec(specJson) {
    const spec = JSON.parse(specJson);
    this.registerComponent(spec);
    return spec;
  }

  /**
   * Получение спецификации компонента
   */
  getComponentSpec(specName) {
    return this.componentRegistry.get(specName);
  }

  /**
   * Резолюция имени спека.
   * Поддерживает base-name вызовы (например \"components\") и возвращает детерминированный specId.
   */
  resolveSpecName(requestedName) {
    try {
      const name = String(requestedName || '').trim();
      if (!name) return null;
      if (this.componentRegistry.has(name)) return name;

      // If it's already a path-like specId, try normalizations.
      const noExt = name.replace(/\.(tsx|jsx|ts|js|vue|svelte|html?)$/i, '');
      if (this.componentRegistry.has(noExt)) return noExt;

      // Base-name heuristic: prefer `${base}/${base}` then `${base}/index` then best under `${base}/`.
      if (!name.includes('/')) {
        const base = name;
        const direct = `${base}/${base}`;
        if (this.componentRegistry.has(direct)) return direct;
        const idx = `${base}/index`;
        if (this.componentRegistry.has(idx)) return idx;

        const keys = Array.from(this.componentRegistry.keys()).filter(k => String(k).startsWith(`${base}/`));
        if (keys.length === 0) return null;
        const score = (k) => {
          const lower = String(k).toLowerCase();
          let s = 0;
          if (lower === direct.toLowerCase()) s += 1000;
          if (lower === idx.toLowerCase()) s += 900;
          if (lower.includes('__render_gallery')) s -= 100;
          // Prefer leaf matching folder name.
          try {
            const leaf = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
            const parent = lower.includes('/') ? lower.slice(0, lower.lastIndexOf('/')) : '';
            const parentLeaf = parent.includes('/') ? parent.slice(parent.lastIndexOf('/') + 1) : parent;
            if (leaf === parentLeaf) s += 200;
          } catch(_) {}
          return s;
        };
        return keys
          .slice()
          .sort((a, b) => {
            const d = score(b) - score(a);
            return d !== 0 ? d : String(a).localeCompare(String(b));
          })[0] || null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Получение всех компонентов
   */
  getComponents() {
    return Array.from(this.componentRegistry.values());
  }

  /**
   * Очистка VFS
   */
  clearVFS() {
    this.vfs.clear();
    this.componentRegistry.clear();
    if (this.zodValidator) {
      this.zodValidator.clearSchemas();
    }
    this.log('VFS cleared');
  }

  /**
   * Проверка доступности SWC
   */
  canUseSWC() {
    return false; // TODO: Implement SWC check
  }

  /**
   * Логирование
   */
  log(...args) {
    if (this.debug) {
      console.log('[UserfaceEngine]', ...args);
    }
  }

  /**
   * Строгая валидация очищенного кода на отсутствие TypeScript
   */
  validateCleanCode(code, componentName) {
    
    const tsPatterns = [
      { pattern: /interface\s+\w+/g, name: 'interface declarations' },
      { pattern: /type\s+\w+\s*=/g, name: 'type aliases' },
      { pattern: /:\s*[A-Z]\w+/g, name: 'type annotations' },
      { pattern: /\s+as\s+\w+/g, name: 'type assertions' },
      { pattern: /React\.FC<[^>]*>/g, name: 'React.FC types' },
      { pattern: /\?\s*:/g, name: 'optional parameters' },
      { pattern: /import\s+type/g, name: 'type imports' },
      { pattern: /export\s+type/g, name: 'type exports' },
      // 🔧 КРИТИЧЕСКОЕ ДОБАВЛЕНИЕ: Проверка import/export для iframe
      { pattern: /import\s+.*?from\s+['"][^'"]*['"]/g, name: 'import statements' },
      { pattern: /import\s+['"][^'"]*['"]/g, name: 'side-effect imports' },
      { pattern: /export\s+default/g, name: 'default exports' },
      { pattern: /export\s+\{[^}]*\}/g, name: 'named exports' },
      { pattern: /export\s+(const|let|var|function|class)/g, name: 'direct exports' }
    ];
    
    const violations = [];
    
    for (const { pattern, name } of tsPatterns) {
      const matches = code.match(pattern);
      if (matches) {
        violations.push({
          type: name,
          count: matches.length,
          examples: matches.slice(0, 3) // Первые 3 примера
        });
      }
    }
    
    if (violations.length > 0) {
      console.error('[Engine] ❌ VALIDATION FAILED - Code contains constructs that will break iframe execution:');
      violations.forEach(v => {
        console.error(`  - ${v.type}: ${v.count} occurrences`);
        console.error(`    Examples: ${v.examples.join(', ')}`);
      });
      
      // Debug dump
      this.renderErrorDebugDump(componentName, code, violations);
      return false;
    }
    
    return true;
  }

  /**
   * Debug dump для проблемного кода
   */
  renderErrorDebugDump(componentName, code, violations) {
    const timestamp = new Date().toISOString();
    const dumpData = {
      timestamp,
      componentName,
      codeLength: code.length,
      violations,
      codePreview: code.substring(0, 500) + (code.length > 500 ? '...' : ''),
      fullCode: code
    };
    
    // UE-002: Save to localStorage for debugging — capped at 10 entries to prevent quota exhaustion.
    if (typeof window !== 'undefined') {
      try {
        var MAX_DEBUG_DUMPS = 10;
        var key = 'debug_dump_' + componentName + '_' + Date.now();
        localStorage.setItem(key, JSON.stringify(dumpData, null, 2));
        // Evict oldest entries over the cap
        var allKeys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.startsWith('debug_dump_')) allKeys.push(k);
        }
        if (allKeys.length > MAX_DEBUG_DUMPS) {
          allKeys.sort(); // lexicographic — oldest timestamps first
          var toRemove = allKeys.slice(0, allKeys.length - MAX_DEBUG_DUMPS);
          for (var j = 0; j < toRemove.length; j++) localStorage.removeItem(toRemove[j]);
        }
        console.error('[Engine] 💾 Debug dump saved to localStorage:', key, '(' + allKeys.length + ' total)');
      } catch (_e) { /* quota exceeded or SecurityError — ignore */ }
    }
    
    // Логируем в консоль
    console.group('[Engine] 🚨 RENDER ERROR DEBUG DUMP');
    console.error('Component:', componentName);
    console.error('Timestamp:', timestamp);
    console.error('Violations:', violations);
    console.error('Code preview:', dumpData.codePreview);
    console.groupEnd();
    
    return dumpData;
  }
}

    // Экспорт для использования
    if (typeof globalThis !== 'undefined') {
      globalThis.UserfaceEngine = UserfaceEngine;
      console.log('✅ UserfaceEngine exported to globalThis');
    }
    if (typeof window !== 'undefined') {
      // Главный экспорт класса
      // Export only the class. Host controls instantiation via ensureEngineReady().
      window.UserfaceEngine = UserfaceEngine;
      console.log('✅ UserfaceEngine exported to window');
      
    }
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { UserfaceEngine };
    }
