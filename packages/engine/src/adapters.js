/**
 * Универсальные адаптеры для фреймворков
 */

// Robust fallback import for UniversalCodeSanitizer (Browser or Node)
let UniversalCodeSanitizer;
try {
  if (typeof window !== 'undefined' && window.UniversalCodeSanitizer) {
    UniversalCodeSanitizer = window.UniversalCodeSanitizer;
  } else if (typeof require !== 'undefined') {
    try {
      // Пытаемся TS-версию (во время сборки / runtime в Node)
      const modTs = require('./codeSanitizer.ts');
      UniversalCodeSanitizer = modTs && (modTs.UniversalCodeSanitizer || modTs.default || modTs);
    } catch (e) {
      // Если нет — просто оставляем undefined. Не тянем public/codeSanitizer.js через динамический require,
      // чтобы избежать critical dependency warnings в webpack.
      UniversalCodeSanitizer = undefined;
    }
  } else {
    UniversalCodeSanitizer = undefined;
  }
} catch (e) {
  UniversalCodeSanitizer = undefined;
}

class ReactAdapter {
  constructor(engine) {
    this.engine = engine;
  }

  async render(spec, props) {
    this.engine.log('ReactAdapter: Starting render for', spec.name);
    
    try {
      // Находим исходный код компонента
      const sourceFile = this.engine.findSourceFile(spec.name, 'react');
      if (!sourceFile) {
        throw new Error(`Source file not found for component: ${spec.name}`);
      }

      // Получаем все файлы из VFS
      const vfsEntry = this.engine.vfs.get(spec.name);
      const files = vfsEntry ? vfsEntry.files : [];

      // 🔍 ДИАГНОСТИКА: Логируем исходный код
      console.log('[ReactAdapter] 📝 Processing component:', spec.name);
      console.log('[ReactAdapter] 📝 Original code length:', sourceFile.content.length);
      console.log('[ReactAdapter] 📝 Original code preview (first 300 chars):', sourceFile.content.substring(0, 300));
      
      // Проверяем наличие TS в исходном коде
      const hasOriginalTS = /interface\s+\w+|type\s+\w+\s*=|enum\s+\w+/.test(sourceFile.content);
      console.log('[ReactAdapter] 🔍 Original code contains TS constructs:', hasOriginalTS);

      // ✅ НОВАЯ АРХИТЕКТУРА: Используем UniversalCodeSanitizer
      const sanitizer = new UniversalCodeSanitizer('react');
      const sanitizationResult = sanitizer.sanitizeCode(sourceFile.content);
      
      // Логируем прохождение через UniversalCodeSanitizer
      sanitizationResult.logs.forEach(log => console.log(`[ReactAdapter] ${log}`));
      
      if (!sanitizationResult.success) {
        throw new Error(`Code sanitization failed: ${sanitizationResult.logs.join(', ')}`);
      }
      
      const finalCode = sanitizationResult.cleanCode;
      console.log('[ReactAdapter] ✅ UniversalCodeSanitizer: Code sanitized successfully');
      console.log('[ReactAdapter] ✅ UniversalCodeSanitizer: IIFE wrapped:', sanitizationResult.isWrappedInIIFE);
      
      // 🔍 ДИАГНОСТИКА: Проверяем очищенный код
      console.log('[ReactAdapter] 📝 Final code length:', finalCode.length);
      console.log('[ReactAdapter] 📝 Final code preview (first 300 chars):', finalCode.substring(0, 300));
      
      // Проверяем наличие TS в очищенном коде
      const hasCleanTS = /interface\s+\w+|type\s+\w+\s*=|enum\s+\w+/.test(finalCode);
      console.log('[ReactAdapter] 🔍 Clean code contains TS constructs:', hasCleanTS);
      
      console.log('[ReactAdapter] 📊 React transformation complete:');
      console.log('  - Original code length:', sourceFile.content.length);
      console.log('  - Final code length:', finalCode.length);

      // ⚠️ Previously: hard fail if TS artifacts remained. Align with browser build: only warn and proceed
      const stillHasTS = /interface\s+\w+|type\s+\w+\s*=|:\s*[A-Z]\w+|enum\s+\w+/.test(finalCode);
      if (stillHasTS) {
        if (this.engine && typeof this.engine.log === 'function') {
          this.engine.log('ReactAdapter: ⚠️ Residual TS-like patterns detected after sanitization. Proceeding with caution.');
        } else {
          console.warn('[ReactAdapter] ⚠️ Residual TS-like patterns detected after sanitization. Proceeding with caution.');
        }
      }
      
      // Извлекаем стили
      const styles = this.extractStyles(files);

      console.log('[ReactAdapter] ✅ React code ready for iframe execution');
      console.log('[ReactAdapter] 📝 Final componentCode that will be sent to iframe (first 200 chars):', finalCode.substring(0, 200) + '...');

      // Создаем данные для React sandbox
      const renderData = {
        componentCode: finalCode,
        componentName: spec.name,
        props: props,
        framework: 'react',
        files: files,
        styles: styles
      };

      this.engine.log('ReactAdapter: Render data prepared', renderData);
      
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
   * React-специфичная очистка кода
   */
  cleanReactCode(code, componentName) {
    let cleaned = code;
    
    // Убеждаемся что нет React импортов (они уже глобальные в iframe)
    cleaned = cleaned.replace(/import\s+React.*?from\s+['"]react['"];?/g, '');
    cleaned = cleaned.replace(/import\s+\{[^}]*\}\s+from\s+['"]react['"];?/g, '');
    
    // Убеждаемся что компонент определён корректно
    const hasExplicitDef =
      (new RegExp('function\\s+' + componentName + '\\b')).test(cleaned) ||
      (new RegExp('const\\s+' + componentName + '\\b')).test(cleaned) ||
      (new RegExp('class\\s+' + componentName + '\\b')).test(cleaned);

    if (!hasExplicitDef) {
      // Если нет явного определения, пытаться заменить default export (если остался)
      cleaned = cleaned.replace(/export\s+default\s+/, 'const ' + componentName + ' = ');
    }
    
    return cleaned.trim();
  }

  /**
   * Извлечение стилей из файлов
   */
  extractStyles(files) {
    return files
      .filter(file => file.name.endsWith('.css'))
      .map(file => file.content)
      .join('\n');
  }

  async compile(code, options = {}) {
    this.engine.log('ReactAdapter: Compiling code');
    
    // Используем общую трансформацию движка
    return this.engine.cleanTypeScriptCode(code);
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

      // ✅ НОВАЯ АРХИТЕКТУРА: Используем UniversalCodeSanitizer
      const sanitizer = new UniversalCodeSanitizer('vue');
      const sanitizationResult = sanitizer.sanitizeCode(sourceFile.content);
      
      // Логируем прохождение через UniversalCodeSanitizer
      sanitizationResult.logs.forEach(log => console.log(`[VueAdapter] ${log}`));
      
      if (!sanitizationResult.success) {
        throw new Error(`Code sanitization failed: ${sanitizationResult.logs.join(', ')}`);
      }
      
      const finalCode = sanitizationResult.cleanCode;
      console.log('[VueAdapter] ✅ UniversalCodeSanitizer: Code sanitized successfully');
      console.log('[VueAdapter] ✅ UniversalCodeSanitizer: IIFE wrapped:', sanitizationResult.isWrappedInIIFE);
      
      console.log('[VueAdapter] 📊 Vue transformation complete:');
      console.log('  - Original code length:', sourceFile.content.length);
      console.log('  - Final code length:', finalCode.length);
      
      // 🔧 Vue SFC трансформация
      console.log('[VueAdapter] 🔄 Starting Vue SFC transformation...');
      const transformedCode = this.transformVueSFC(finalCode, spec.name);
      
      console.log('[VueAdapter] 📊 Vue transformation complete:');
      console.log('  - Original SFC length:', sourceFile.content.length);
      console.log('  - Transformed JS length:', transformedCode.length);

      // Извлекаем стили из SFC
      const styles = this.extractVueStyles(sourceFile.content);

      console.log('[VueAdapter] ✅ Vue code ready for iframe execution');

      // Создаем данные для Vue sandbox
      const renderData = {
        componentCode: transformedCode,
        componentName: spec.name,
        props: props,
        framework: 'vue',
        files: files,
        styles: styles
      };

      this.engine.log('VueAdapter: Render data prepared', renderData);
      
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

  transformVueSFC(sfcCode, componentName) {
    // Простейшая трансформация SFC -> JS
    const templateMatch = sfcCode.match(/<template>[\s\S]*?<\/template>/i);
    const scriptMatch = sfcCode.match(/<script[^>]*>[\s\S]*?<\/script>/i);

    const template = templateMatch ? templateMatch[0].replace(/<\/?template>/gi, '') : '';
    const script = scriptMatch ? scriptMatch[0].replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '') : '';

    // Удаляем импорт Vue и экспорт по умолчанию
    const scriptClean = script
      .replace(/import\s+\{?\s*ref\s*\}?\s*from\s+['"]vue['"];?/g, '')
      .replace(/export\s+default\s+\{[\s\S]*?\};?/g, '');

    // Оборачиваем в функцию
    const jsCode = `function ${componentName}(props){\n  return ${JSON.stringify(template)};\n}`;

    // Комбинируем
    return scriptClean + '\n' + jsCode;
  }

  extractVueStyles(sfcCode) {
    const styles = [];
    const styleRegex = /<style[^>]*>[\s\S]*?<\/style>/gi;
    let match;
    while ((match = styleRegex.exec(sfcCode)) !== null) {
      const styleTag = match[0];
      const css = styleTag.replace(/<style[^>]*>/i, '').replace(/<\/style>/i, '');
      styles.push(css);
    }
    return styles.join('\n');
  }

  async compile(code, options = {}) {
    this.engine.log('VueAdapter: Compiling code');
    // Для Vue не выполняем TS-трансформацию – работаем с исходным кодом (IIFE обёртывание дальше)
    return code;
  }

  validate(code) {
    this.engine.log('VueAdapter: Validating code');
    return {
      isValid: true,
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

      // ✅ НОВАЯ АРХИТЕКТУРА: Используем UniversalCodeSanitizer
      const sanitizer = new UniversalCodeSanitizer('svelte');
      const sanitizationResult = sanitizer.sanitizeCode(sourceFile.content);
      
      // Логируем прохождение через UniversalCodeSanitizer
      sanitizationResult.logs.forEach(log => console.log(`[SvelteAdapter] ${log}`));
      
      if (!sanitizationResult.success) {
        throw new Error(`Code sanitization failed: ${sanitizationResult.logs.join(', ')}`);
      }
      
      const finalCode = sanitizationResult.cleanCode;
      console.log('[SvelteAdapter] ✅ UniversalCodeSanitizer: Code sanitized successfully');
      console.log('[SvelteAdapter] ✅ UniversalCodeSanitizer: IIFE wrapped:', sanitizationResult.isWrappedInIIFE);

      // Трансформация Svelte -> JS
      const transformedCode = this.transformSvelteComponent(finalCode, spec.name);

      // Извлекаем стили из Svelte
      const styles = this.extractSvelteStyles(sourceFile.content);

      console.log('[SvelteAdapter] ✅ Svelte code ready for iframe execution');

      // Создаем данные для Svelte sandbox
      const renderData = {
        componentCode: transformedCode,
        componentName: spec.name,
        props: props,
        framework: 'svelte',
        files: files,
        styles: styles
      };

      this.engine.log('SvelteAdapter: Render data prepared', renderData);
      
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

  transformSvelteComponent(svelteCode, componentName) {
    // Простейшая трансформация: извлекаем <script> и HTML
    const scriptMatch = svelteCode.match(/<script[^>]*>[\s\S]*?<\/script>/i);
    const html = svelteCode.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').trim();

    const script = scriptMatch ? scriptMatch[0].replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '') : '';

    // Оборачиваем в функцию
    const jsCode = `${script}\nfunction ${componentName}(props){\n  return ${JSON.stringify(html)};\n}`;

    return jsCode;
  }

  extractSvelteStyles(svelteCode) {
    const styles = [];
    const styleRegex = /<style[^>]*>[\s\S]*?<\/style>/gi;
    let match;
    while ((match = styleRegex.exec(svelteCode)) !== null) {
      const styleTag = match[0];
      const css = styleTag.replace(/<style[^>]*>/i, '').replace(/<\/style>/i, '');
      styles.push(css);
    }
    return styles.join('\n');
  }

  async compile(code, options = {}) {
    this.engine.log('SvelteAdapter: Compiling code');
    // Для Svelte не выполняем TS-трансформацию – работаем с исходным кодом
    return code;
  }

  validate(code) {
    this.engine.log('SvelteAdapter: Validating code');
    return {
      isValid: true,
      framework: 'svelte'
    };
  }
}

if (typeof window !== 'undefined') {
  window.ReactAdapter = ReactAdapter;
  window.VueAdapter = VueAdapter;
  window.SvelteAdapter = SvelteAdapter;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ReactAdapter, VueAdapter, SvelteAdapter };
}