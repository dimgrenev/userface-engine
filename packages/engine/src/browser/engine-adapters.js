/**
 * SOURCE OF TRUTH (browser runtime)
 * This file is copied to public/runtime/engine/engine-adapters.js by engine/scripts/build-public.js.
 * Do not edit public/runtime/engine/engine-adapters.js directly.
 *
 * Универсальные адаптеры для фреймворков
 */

// Инициализация рабочей конфигурации Babel для тестов
if (typeof globalThis !== 'undefined') {
  // Глобальный промис готовности Babel
  if (!globalThis.__BABEL_READY_PROMISE__) {
    let resolveFn;
    globalThis.__BABEL_READY__ = false;
    globalThis.__BABEL_READY_PROMISE__ = new Promise((resolve) => { resolveFn = resolve; });
    globalThis.__RESOLVE_BABEL_READY__ = () => { if (!globalThis.__BABEL_READY__) { globalThis.__BABEL_READY__ = true; resolveFn && resolveFn(); } };
  }
  // Функция для инициализации конфига Babel
  function initBabelConfig() {
    const Babel = globalThis.Babel || (typeof window !== 'undefined' ? window.Babel : null);
    if (Babel && Babel.availablePresets) {
      globalThis.WORKING_BABEL_CONFIG = {
        presets: [
          [Babel.availablePresets.typescript, { 
            isTSX: true, 
            allExtensions: true 
          }],
          [Babel.availablePresets.react, { 
            runtime: 'classic',
            pragma: 'React.createElement',
            pragmaFrag: 'React.Fragment'
          }]
        ],
        parserOpts: {
          plugins: ['jsx', 'typescript']
        }
      };
      if (typeof window !== 'undefined') { window.WORKING_BABEL_CONFIG = globalThis.WORKING_BABEL_CONFIG; }
      console.log('[OK] WORKING_BABEL_CONFIG initialized with availablePresets');
      // Отмечаем Babel как готовый
      try { globalThis.__RESOLVE_BABEL_READY__ && globalThis.__RESOLVE_BABEL_READY__(); } catch(_) {}
      return true;
    } else {
      // Тихо ждем загрузки Babel
      return false;
    }
  }

  // Попытка немедленной инициализации
  if (!initBabelConfig()) {
    // Если не удалось сразу, ждем загрузки
    let retryCount = 0;
    const maxRetries = 50; // 5 секунд максимум
    
    const retryInit = function() {
      if (initBabelConfig() || retryCount >= maxRetries) {
        if (retryCount >= maxRetries) {
          console.error('[ERROR] Failed to initialize Babel config after ' + maxRetries + ' attempts');
        }
        return;
      }
      retryCount++;
      setTimeout(retryInit, 100);
    };
    
    // Начинаем попытки через 100ms
    setTimeout(retryInit, 100);
  }
}

// Утилита ожидания готовности Babel
async function waitForBabel(maxMs = 5000) {
  try {
    if (typeof globalThis === 'undefined') return;
    if (globalThis.__BABEL_READY__) return;
    const p = globalThis.__BABEL_READY_PROMISE__;
    if (!p) return;
    await Promise.race([
      p,
      new Promise((resolve) => setTimeout(resolve, maxMs))
    ]);
  } catch(_) {}
}

class ReactAdapter {
  constructor(engine) {
    this.engine = engine;
  }

  async render(spec, props) {
    this.engine.log('ReactAdapter: Starting render for', spec.name);
    
    try {
      // Дожидаемся готовности Babel, чтобы избежать regex-фоллбэка в санитайзере
      await waitForBabel();
      // Находим исходный код компонента
      const sourceFile = this.engine.findSourceFile(spec.name, 'react');
      if (!sourceFile) {
        throw new Error(`Source file not found for component: ${spec.name}`);
      }

      // Получаем все файлы из VFS
      const vfsEntry = this.engine.vfs.get(spec.name);
      const files = vfsEntry ? vfsEntry.files : [];

      // Canonical path: use injected bundler (npm-ready; no window globals).
      // Without bundling, most real components (e.g. Components) will break after import stripping.
      let cleanCode = '';
      let bundlerTried = false;
      let bundlerError = '';
      const hasModularSyntax = (s) => {
        try {
          const src = String(s || '');
          return /\bimport\s+|\bexport\s+/.test(src) || /\brequire\(\s*['"]/.test(src);
        } catch {
          return false;
        }
      };
      try {
        const bundler = (this.engine && typeof this.engine.bundler === 'function') ? this.engine.bundler : null;
        const externals = (this.engine && Array.isArray(this.engine.externals)) ? this.engine.externals : [
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
          'userface'
        ];
        if (typeof bundler === 'function') {
          bundlerTried = true;
          const vfs = {};
          for (const f of (files || [])) {
            if (!f || !f.name) continue;
            vfs[String(f.name)] = { name: String(f.name), type: 'text/plain', content: String(f.content || '') };
          }
          const entryKey = String(sourceFile.name || '');
          if (entryKey && vfs[entryKey]) {
            const res = await bundler(entryKey, vfs, { externals });
            if (res && res.success && res.code) {
              cleanCode = String(res.code || '');
              this.engine.log('ReactAdapter: ✅ Bundled via injected bundler', entryKey, 'len:', cleanCode.length);
            } else {
              bundlerError = String((res && res.error) ? res.error : 'Unknown bundler error');
              this.engine.log('ReactAdapter: ❌ Bundler failed', entryKey, bundlerError);
            }
          }
        }
      } catch (e) {
        bundlerTried = true;
        bundlerError = String((e && e.message) ? e.message : e);
        this.engine.log('ReactAdapter: ❌ Bundler exception', bundlerError);
      }

      // Fallback: sanitize single-file code (will strip imports; OK only for simple components)
      let sanitizationResult = null;
      if (!cleanCode) {
        // If we tried bundling and it failed, do NOT silently fall back to sanitizer for modular code.
        // That produces misleading "empty" renders and broken CSS, diverging from the canonical engine path.
        if (bundlerTried) {
          throw new Error(`ReactAdapter: Bundler failed for modular component. ${bundlerError || 'Unknown bundler error'}`);
        }
        // If bundler is not available, sanitizer can only handle non-modular code.
        if (hasModularSyntax(sourceFile.content)) {
          throw new Error('ReactAdapter: Bundler is required for components with import/export');
        }
        // ✅ ЖЕЛЕЗОБЕТОННЫЙ КОНТРАКТ: Используем UniversalCodeSanitizer
        const SanitizerClass = (typeof window !== 'undefined' && window.UniversalCodeSanitizer)
          ? window.UniversalCodeSanitizer
          : UniversalCodeSanitizer;
        
        // Создаем sanitizer для React
        const sanitizer = new SanitizerClass('react');
        sanitizationResult = sanitizer.sanitizeCode(sourceFile.content);
        
        // Логируем весь процесс санитизации
        (sanitizationResult.logs || []).forEach(log => this.engine.log(log));
        
        // 🚫 EARLY EXIT: Если санитизация провалилась - падаем ДО iframe
        if (!sanitizationResult.success) {
          throw new Error(`ReactAdapter: Code sanitization failed - ${sanitizationResult.logs && sanitizationResult.logs.join(', ')}`);
        }
        
        cleanCode = sanitizationResult.cleanCode;
        
        // 🚫 EARLY EXIT: Если cleanCode пустой - падаем ДО iframe  
        if (!cleanCode || cleanCode.trim().length === 0) {
          throw new Error('ReactAdapter: Sanitized code is empty');
        }
      }
      
      // ⚠️ РАНЕЕ: агрессивно падали при детекции TS. Отключаем жесткий блок — логируем и продолжаем
      // const stillHasTS = /interface\s+\w+|type\s+\w+\s*=|:\s*[A-Z]\w+|enum\s+\w+/.test(cleanCode);
      // if (stillHasTS) {
      //   throw new Error('ReactAdapter: TypeScript code not allowed in sandbox - interfaces/types/enums detected');
      // }
      const stillHasTS = /interface\s+\w+|type\s+\w+\s*=|:\s*[A-Z]\w+|enum\s+\w+/.test(cleanCode);
      if (stillHasTS) {
        this.engine.log('ReactAdapter: ⚠️ Residual TS-like patterns detected after sanitization. Proceeding with caution.');
      }

      // Hard guarantee: code must be executable JS before we ever touch the iframe.
      try {
        // eslint-disable-next-line no-new-func
        new Function(String(cleanCode || ''));
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : String(e);
        throw new Error(`ReactAdapter: Generated code is not executable JS: ${msg}`);
      }
      
      this.engine.log('ReactAdapter: ✅ Code sanitization successful');
      // In bundler path, sanitizationResult may be null.
      try {
        if (sanitizationResult && typeof sanitizationResult === 'object' && 'isWrappedInIIFE' in sanitizationResult) {
          this.engine.log('ReactAdapter: ✅ IIFE wrapped:', sanitizationResult.isWrappedInIIFE);
        }
      } catch(_) {}
      this.engine.log('ReactAdapter: ✅ Final code length:', cleanCode.length);
      
      // Извлекаем стили
      const styles = this.extractStyles(files);

      // 📋 ЖЕЛЕЗОБЕТОННЫЙ КОНТРАКТ: Возвращаем точно то, что ожидают sandbox'ы
      const renderData = {
        componentCode: cleanCode,     // Чистый JS без TS/импортов, IIFE-готовый
        componentName: spec.name,     // Имя компонента
        props: props || {},           // Props без обнуления
        files: files || [],           // Файлы + стили
        styles: styles                // Отформатированные стили
      };

      this.engine.log('ReactAdapter: Render data prepared for sandbox');
      
      return {
        type: 'react-component',
        data: renderData,
        spec: spec
      };
      
    } catch (error) {
      this.engine.log('ReactAdapter: Render failed', error.message);
      throw error;
    }
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
        // Variables first, then globals, then the rest stable (alphabetical)
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

  async compile(code, options = {}) {
    this.engine.log('ReactAdapter: Compiling code');
    
    // ✅ Используем UniversalCodeSanitizer
    const SanitizerClass = (typeof globalThis !== 'undefined' && globalThis.UniversalCodeSanitizer) || (typeof window !== 'undefined' && window.UniversalCodeSanitizer)
      ? ((typeof globalThis !== 'undefined' && globalThis.UniversalCodeSanitizer) || (typeof window !== 'undefined' && window.UniversalCodeSanitizer))
      : (typeof UniversalCodeSanitizer !== 'undefined' ? UniversalCodeSanitizer : null);
    if (!SanitizerClass) {
      throw new Error('UniversalCodeSanitizer is not available');
    }
    const sanitizer = new SanitizerClass('react');
    const sanitizationResult = sanitizer.sanitizeCode(code);
    
    if (!sanitizationResult.success) {
      throw new Error(`ReactAdapter compilation failed: ${sanitizationResult.logs && sanitizationResult.logs.join(', ')}`);
    }
    
    return sanitizationResult.cleanCode;
  }

  validate(code) {
    this.engine.log('ReactAdapter: Validating code');
    
    // Проверяем наличие React-специфичных конструкций
    const hasJSX = /<[A-Z]/.test(code) || /<[a-z]/.test(code);
    const hasReactHooks = /use[A-Z]/.test(code);
    
    return {
      isValid: true,
      hasJSX,
      hasReactHooks,
      framework: 'react'
    };
  }
}

class VueAdapter {
  constructor(engine) {
    this.engine = engine;
  }

  async render(spec, props) {
    this.engine.log('VueAdapter: Starting render for', spec.name);
    
    try {
      // Находим исходный код компонента
      const sourceFile = this.engine.findSourceFile(spec.name, 'vue');
      if (!sourceFile) {
        throw new Error(`Source file not found for component: ${spec.name}`);
      }

      // Получаем все файлы из VFS
      const vfsEntry = this.engine.vfs.get(spec.name);
      const files = vfsEntry ? vfsEntry.files : [];

      // 🔧 Vue SFC трансформация с единой санитизацией
      this.engine.log('VueAdapter: Starting Vue SFC transformation...');
      const transformedCode = this.transformVueSFC(sourceFile.content, spec.name);
      
      // 🚫 EARLY EXIT: Если transformedCode пустой - падаем ДО iframe  
      if (!transformedCode || transformedCode.trim().length === 0) {
        throw new Error('VueAdapter: Transformed code is empty');
      }
      
      // ⚠️ Отключаем жесткий блок по TS — только предупреждаем
      const stillHasTS_Vue = /interface\s+\w+|type\s+\w+\s*=|:\s*[A-Z]\w+|enum\s+\w+/.test(transformedCode);
      if (stillHasTS_Vue) {
        this.engine.log('VueAdapter: ⚠️ Residual TS-like patterns detected after sanitization. Proceeding with caution.');
      }
      
      this.engine.log('VueAdapter: ✅ Vue transformation successful');
      this.engine.log('VueAdapter: ✅ Transformed code length:', transformedCode.length);

      // Извлекаем стили из SFC
      const styles = this.extractVueStyles(sourceFile.content);

      // 📋 ЖЕЛЕЗОБЕТОННЫЙ КОНТРАКТ: Возвращаем точно то, что ожидают sandbox'ы
      const renderData = {
        componentCode: transformedCode,   // Чистый JS без TS/импортов, IIFE-готовый
        componentName: spec.name,         // Имя компонента
        props: props || {},               // Props без обнуления
        files: files || [],               // Файлы + стили
        styles: styles                    // Стили из SFC
      };

      this.engine.log('VueAdapter: Render data prepared for sandbox');
      
      return {
        type: 'vue-component',
        data: renderData,
        spec: spec
      };
      
    } catch (error) {
      this.engine.log('VueAdapter: Render failed', error.message);
      throw error;
    }
  }

  /**
   * Трансформация Vue SFC в executable JS с единой санитизацией
   */
  transformVueSFC(sfcCode, componentName) {
    // Извлекаем секции из SFC
    const scriptMatch = sfcCode.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    const templateMatch = sfcCode.match(/<template[^>]*>([\s\S]*?)<\/template>/);
    
    const scriptContent = scriptMatch ? scriptMatch[1].trim() : '';
    const templateContent = templateMatch ? templateMatch[1].trim() : '<div>No template found</div>';
    
    // ✅ Используем UniversalCodeSanitizer для script секции
    const SanitizerClass = (typeof globalThis !== 'undefined' && globalThis.UniversalCodeSanitizer) || (typeof window !== 'undefined' && window.UniversalCodeSanitizer)
      ? ((typeof globalThis !== 'undefined' && globalThis.UniversalCodeSanitizer) || (typeof window !== 'undefined' && window.UniversalCodeSanitizer))
      : (typeof UniversalCodeSanitizer !== 'undefined' ? UniversalCodeSanitizer : null);
    
    if (!SanitizerClass) {
      throw new Error('UniversalCodeSanitizer is not available');
    }
    const sanitizer = new SanitizerClass('vue');
    const sanitizationResult = sanitizer.sanitizeCode(scriptContent);
    
    // Логируем процесс санитизации
    (sanitizationResult.logs || []).forEach(log => console.log(log));
    
    if (!sanitizationResult.success) {
      throw new Error(`VueAdapter SFC transformation failed: ${sanitizationResult.logs && sanitizationResult.logs.join(', ')}`);
    }
    
    const cleanScript = sanitizationResult.cleanCode;
    
    // Создаем Vue компонент объект
    const componentCode = `
const ${componentName} = {
  template: \`${templateContent.replace(/`/g, '\\`')}\`,
  ${cleanScript.replace(/export\s+default\s*\{?/, '').replace(/\}?\s*$/, '')}
};
    `.trim();
    
    return componentCode;
  }

  /**
   * Извлечение стилей из Vue SFC
   */
  extractVueStyles(sfcCode) {
    const styleMatches = sfcCode.match(/<style[^>]*>([\s\S]*?)<\/style>/g);
    if (!styleMatches) return '';
    
    return styleMatches
      .map(match => {
        const content = match.replace(/<style[^>]*>/, '').replace(/<\/style>/, '');
        return content.trim();
      })
      .join('\n');
  }

  async compile(code, options = {}) {
    this.engine.log('VueAdapter: Compiling Vue SFC');
    return this.transformVueSFC(code, options.componentName || 'Component');
  }

  validate(code) {
    this.engine.log('VueAdapter: Validating Vue SFC');
    
    const hasTemplate = /<template/.test(code);
    const hasScript = /<script/.test(code);
    const hasStyle = /<style/.test(code);
    
    return {
      isValid: hasTemplate || hasScript,
      hasTemplate,
      hasScript,
      hasStyle,
      framework: 'vue'
    };
  }
}

class SvelteAdapter {
  constructor(engine) {
    this.engine = engine;
  }

  async render(spec, props) {
    this.engine.log('SvelteAdapter: Starting render for', spec.name);
    
    try {
      // Находим исходный код компонента
      const sourceFile = this.engine.findSourceFile(spec.name, 'svelte');
      if (!sourceFile) {
        throw new Error(`Source file not found for component: ${spec.name}`);
      }

      // Получаем все файлы из VFS
      const vfsEntry = this.engine.vfs.get(spec.name);
      const files = vfsEntry ? vfsEntry.files : [];

      // 🔧 Svelte компонент трансформация с единой санитизацией
      this.engine.log('SvelteAdapter: Starting Svelte transformation...');
      const transformedCode = this.transformSvelteComponent(sourceFile.content, spec.name);
      
      // 🚫 EARLY EXIT: Если transformedCode пустой - падаем ДО iframe  
      if (!transformedCode || transformedCode.trim().length === 0) {
        throw new Error('SvelteAdapter: Transformed code is empty');
      }
      
      // ⚠️ Отключаем жесткий блок по TS — только предупреждаем
      const stillHasTS_Svelte = /interface\s+\w+|type\s+\w+\s*=|:\s*[A-Z]\w+|enum\s+\w+/.test(transformedCode);
      if (stillHasTS_Svelte) {
        this.engine.log('SvelteAdapter: ⚠️ Residual TS-like patterns detected after sanitization. Proceeding with caution.');
      }
      
      this.engine.log('SvelteAdapter: ✅ Svelte transformation successful');
      this.engine.log('SvelteAdapter: ✅ Transformed code length:', transformedCode.length);

      // Извлекаем стили из Svelte компонента
      const styles = this.extractSvelteStyles(sourceFile.content);

      // 📋 ЖЕЛЕЗОБЕТОННЫЙ КОНТРАКТ: Возвращаем точно то, что ожидают sandbox'ы
      const renderData = {
        componentCode: transformedCode,   // Чистый JS без TS/импортов, IIFE-готовый
        componentName: spec.name,         // Имя компонента
        props: props || {},               // Props без обнуления
        files: files || [],               // Файлы + стили
        styles: styles                    // Стили из Svelte
      };

      this.engine.log('SvelteAdapter: Render data prepared for sandbox');
      
      return {
        type: 'svelte-component',
        data: renderData,
        spec: spec
      };
      
    } catch (error) {
      this.engine.log('SvelteAdapter: Render failed', error.message);
      throw error;
    }
  }

  /**
   * Трансформация Svelte компонента в executable класс с единой санитизацией
   */
  transformSvelteComponent(svelteCode, componentName) {
    // Извлекаем секции
    const scriptMatch = svelteCode.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    const templateMatch = svelteCode.match(/<script[^>]*>[\s\S]*?<\/script>([\s\S]*?)(?:<style|$)/);
    
    const scriptContent = scriptMatch ? scriptMatch[1].trim() : '';
    const templateContent = templateMatch ? templateMatch[1].trim() : '<div>No template found</div>';
    
    // ✅ Используем UniversalCodeSanitizer для очистки script секции
    const SanitizerClass = (typeof globalThis !== 'undefined' && globalThis.UniversalCodeSanitizer) || (typeof window !== 'undefined' && window.UniversalCodeSanitizer)
      ? ((typeof globalThis !== 'undefined' && globalThis.UniversalCodeSanitizer) || (typeof window !== 'undefined' && window.UniversalCodeSanitizer))
      : (typeof UniversalCodeSanitizer !== 'undefined' ? UniversalCodeSanitizer : null);
    
    if (!SanitizerClass) {
      throw new Error('UniversalCodeSanitizer is not available');
    }
    const sanitizer = new SanitizerClass('svelte');
    const sanitizationResult = sanitizer.sanitizeCode(scriptContent);
    
    // Логируем процесс санитизации
    (sanitizationResult.logs || []).forEach(log => console.log(log));
    
    if (!sanitizationResult.success) {
      throw new Error(`SvelteAdapter transformation failed: ${sanitizationResult.logs && sanitizationResult.logs.join(', ')}`);
    }
    
    const cleanScript = sanitizationResult.cleanCode;
    
    // Создаем простой Svelte-like класс (упрощенная версия)
    const componentCode = `
class ${componentName} {
  constructor(options) {
    this.target = options.target;
    this.props = options.props || {};
    this.render();
  }
  
  render() {
    if (!this.target) return;
    
    // Простой template рендер (без полной Svelte компиляции)
    const template = \`${templateContent.replace(/`/g, '\\`')}\`;
    
    // Заменяем простые переменные
    let html = template;
    Object.keys(this.props).forEach(key => {
      const regex = new RegExp('\\\\{\\\\s*' + key + '\\\\s*\\\\}', 'g');
      html = html.replace(regex, this.props[key]);
    });
    
    this.target.innerHTML = html;
  }
  
  $set(newProps) {
    this.props = { ...this.props, ...newProps };
    this.render();
  }
  
  $destroy() {
    if (this.target) {
      this.target.innerHTML = '';
    }
  }
  
  // User script content
  ${cleanScript}
}
    `.trim();
    
    return componentCode;
  }

  /**
   * Извлечение стилей из Svelte компонента
   */
  extractSvelteStyles(svelteCode) {
    const styleMatch = svelteCode.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    return styleMatch ? styleMatch[1].trim() : '';
  }

  async compile(code, options = {}) {
    this.engine.log('SvelteAdapter: Compiling Svelte component');
    return this.transformSvelteComponent(code, options.componentName || 'Component');
  }

  validate(code) {
    this.engine.log('SvelteAdapter: Validating Svelte component');
    
    const hasScript = /<script/.test(code);
    const hasTemplate = !/<script/.test(code) || (code.indexOf('</script>') < code.lastIndexOf('<'));
    const hasStyle = /<style/.test(code);
    
    return {
      isValid: true, // Svelte компоненты могут быть только template
      hasScript,
      hasTemplate,
      hasStyle,
      framework: 'svelte'
    };
  }
}

// Экспорт для браузера
if (typeof window !== 'undefined') {
  window.ReactAdapter = ReactAdapter;
  window.VueAdapter = VueAdapter;
  window.SvelteAdapter = SvelteAdapter;
}

// Экспорт для Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ReactAdapter, VueAdapter, SvelteAdapter };
}
