/**
 * SOURCE OF TRUTH (browser runtime)
 * This file is copied to public/runtime/engine/codeSanitizer.js by engine/scripts/build-public.js.
 * Do not edit public/runtime/engine/codeSanitizer.js directly.
 *
 * Universal Code Sanitizer - Browser Compatible Version
 * Централизованная очистка, валидация и IIFE-обёртка для всех путей рендеринга
 */

class UniversalCodeSanitizer {
  constructor(framework = 'react') {
    this.framework = framework;
    this.logs = [];
  }

  /**
   * Главный метод: полная санитизация кода
   */
  sanitizeCode(code) {
    this.logs = [];
    this.logs.push(`[${this.framework}Sanitizer] 🧹 Starting universal code sanitization...`);

    try {
      // 1. Начальная валидация
      const initialValidation = this.validateCodeInternal(code);
      this.logs.push(`[${this.framework}Sanitizer] 📊 Initial validation - Imports: ${initialValidation.hasImports}, Exports: ${initialValidation.hasExports}, CommonJS: ${initialValidation.hasCommonJS}`);

      // 2. Основная очистка
      let cleanedCode = this.cleanCodeForIframe(code);
      this.logs.push(`[${this.framework}Sanitizer] 🧹 Primary cleaning completed`);

      // 3. Fallback очистка
      cleanedCode = this.fallbackCleanModularSyntax(cleanedCode);
      this.logs.push(`[${this.framework}Sanitizer] 🔧 Fallback cleaning completed`);

      // 4. Финальная валидация перед IIFE
      const finalValidation = this.validateCodeInternal(cleanedCode);
      this.logs.push(`[${this.framework}Sanitizer] ✅ Final validation before IIFE - Imports: ${finalValidation.hasImports}, Exports: ${finalValidation.hasExports}, CommonJS: ${finalValidation.hasCommonJS}`);

      if (finalValidation.hasImports || finalValidation.hasExports || finalValidation.hasCommonJS) {
        this.logs.push(`[${this.framework}Sanitizer] ❌ CRITICAL: Code still contains modular syntax after cleaning!`);
        throw new Error('Code contains forbidden modular syntax after cleaning');
      }

      // 5. IIFE обёртка
      const iifeCode = this.wrapInIIFE(cleanedCode);
      this.logs.push(`[${this.framework}Sanitizer] 🔄 IIFE wrapping completed`);

      // 6. Финальная проверка IIFE
      const iifeValidation = this.validateCodeInternal(iifeCode);
      const isWrappedInIIFE = this.isCodeWrappedInIIFE(iifeCode);

      this.logs.push(`[${this.framework}Sanitizer] ✅ Sanitization completed successfully`);
      this.logs.push(`[${this.framework}Sanitizer] 📊 Final result - IIFE wrapped: ${isWrappedInIIFE}, Length: ${iifeCode.length}`);

      return {
        cleanCode: iifeCode,
        success: true,
        logs: [...this.logs],
        hasImports: iifeValidation.hasImports,
        hasExports: iifeValidation.hasExports,
        hasCommonJS: iifeValidation.hasCommonJS,
        isWrappedInIIFE: isWrappedInIIFE
      };

    } catch (error) {
      this.logs.push(`[${this.framework}Sanitizer] ❌ Sanitization failed: ${error.message}`);
      return {
        cleanCode: code,
        success: false,
        logs: [...this.logs],
        hasImports: true,
        hasExports: true,
        hasCommonJS: true,
        isWrappedInIIFE: false
      };
    }
  }

  /**
   * Основная очистка кода
   */
  cleanCodeForIframe(code) {
    this.logs.push(`[${this.framework}Sanitizer] 🧹 Starting primary code cleaning...`);

    let cleaned = code;

    // Для React полностью доверяем Babel TS/JSX трансформации
    if (this.framework === 'react') {
      this.logs.push(`[${this.framework}Sanitizer] 🔄 Starting JSX transformation (Babel first, no TS regex stripping)...`);
      cleaned = this.transformJSX(code);
      this.logs.push(`[${this.framework}Sanitizer] ✅ JSX transformation completed`);
    } else {
      // 🔥 АГРЕССИВНАЯ ОЧИСТКА TYPESCRIPT — для не-React путей
      cleaned = cleaned
        // CS-005: TypeScript `declare` statements (must come before interface/type stripping)
        .replace(/^\s*declare\s+(module|namespace|global)\s+[^{]*\{[\s\S]*?\}\s*;?\s*$/gm, '')
        .replace(/^\s*declare\s+(?:module|namespace|global|interface|type|enum|class|function|const|let|var)\b[^;{]*;\s*$/gm, '')
        // Interface definitions (многострочные и однострочные)
        .replace(/interface\s+\w+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
        .replace(/interface\s+\w+\s*extends\s+[\w,\s]+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
        // Type aliases - КРИТИЧЕСКИ ИСПРАВЛЕННЫХ regex для type Props = {...}
        .replace(/type\s+[A-Za-z_$][\w$]*\s*=\s*\{(?:[^{}]*|\{[^{}]*\})*\}\s*;?\s*/g, '')
        .replace(/export\s+type\s+[A-Za-z_$][\w$]*\s*=\s*\{(?:[^{}]*|\{[^{}]*\})*\}\s*;?\s*/g, '')
        // Type aliases для простых типов (union, primitive, etc.)
        .replace(/type\s+[A-Za-z_$][\w$]*\s*=\s*[^;{=\n]+[;\n]?\s*/g, '')
        .replace(/export\s+type\s+[A-Za-z_$][\w$]*\s*=\s*[^;{=\n]+[;\n]?\s*/g, '')
        // Enum definitions  
        .replace(/enum\s+\w+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
        .replace(/export\s+enum\s+\w+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
        // TypeScript parameter type annotations (оригинальные паттерны)
        .replace(/\(\s*(\{[^}]*\})\s*:\s*[A-Za-z_$][\w$]*\s*\)/g, '($1)')
        .replace(/\(\s*([^:)]+)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+\s*\)/g, '($1)')
        // Убираем аннотации вида name: Type в сигнатурах (используем lookbehind в современных браузерах)
        .replace(/(?<=\(|,)\s*(\w+)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+(?=\s*[,)=])/g, '$1')
        // TypeScript inline type literals в параметрах — только внутри сигнатур
        .replace(/(?<=\()\s*(\w+)\s*:\s*\{[^}]*\}(?=\s*[,)=])/g, '$1')
        // TypeScript generic type parameters (безопасно): удаляем только когда за ними следует '('
        .replace(/([A-Za-z_$][\w$]*)<[^>]+>(\s*\()/g, '$1$2')
        // TypeScript return type annotations
        .replace(/\)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+\s*=>/g, ') =>')
        .replace(/\)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+\s*\{/g, ') {')
        // as типы и non-null assertions
        .replace(/\s+as\s+[A-Za-z_$][\w$<>|&\[\]?]+/g, '')
        .replace(/!\s*(?=[;\],}])/g, '')
        // Optional chaining с типами
        .replace(/\?\.\s*([a-zA-Z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+/g, '?.$1');
    }

    // Основные паттерны для всех фреймворков
    cleaned = cleaned
      // Standard imports
      .replace(/import\s+.*?from\s+['"].*?['"];?\s*\n?/g, '')
      // Destructured imports
      .replace(/import\s+\{[^}]*\}\s+from\s+['"].*?['"];?\s*\n?/g, '')
      // Multiline imports
      .replace(/import\s*\{[^}]*\n[^}]*\}\s*from\s+['"].*?['"];?\s*\n?/g, '')
      // Type-only imports (TypeScript)
      .replace(/import\s+type\s+.*?from\s+['"].*?['"];?\s*\n?/g, '')
      .replace(/import\s+type\s+\{[^}]*\}\s+from\s+['"].*?['"];?\s*\n?/g, '')
      // CSS imports
      .replace(/import\s+['"].*?\.(css|scss|sass|less)['"];?\s*\n?/g, '')
      // Side effect imports
      .replace(/import\s+['"].*?['"];?\s*\n?/g, '')
      // Exports — handle re-exports with `from '...'` suffix first
      .replace(/export\s+\{[^}]*\}\s*from\s+['"][^'"]*['"];?\s*/g, '')
      .replace(/export\s+\*\s*(?:as\s+\w+\s*)?from\s+['"][^'"]*['"];?\s*/g, '')
      .replace(/export\s+type\s+\{[^}]*\}\s*(?:from\s+['"][^'"]*['"])?\s*;?\s*/g, '')
      .replace(/export\s+type\s+.*?;\s*/g, '')
      // Anonymous export default function/class → named to avoid syntax error
      .replace(/export\s+default\s+function\s*\(/g, 'function _DefaultExport(')
      .replace(/export\s+default\s+class\s*\{/g, 'class _DefaultExport {')
      .replace(/export\s+default\s+/g, '')
      .replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ')
      .replace(/export\s+\{[^}]*\}/g, '')
      .replace(/export\s+\*/g, '')
      // CommonJS — handle module.exports.X before module.exports
      .replace(/module\.exports\.(\w+)/g, 'const fallbackExport_$1')
      .replace(/module\.exports/g, 'const fallbackExport')
      .replace(/exports\./g, 'const fallbackExport_')
      .replace(/require\s*\(\s*['"][^'"]*['"]\s*\)/g, '(function(){return{}})()');

    // Фреймворк-специфичная очистка
    if (this.framework === 'vue') {
      cleaned = cleaned
        // Vue CSS imports in style sections
        .replace(/@import\s+['"].*?['"];?\s*\n?/g, '')
        // TypeScript annotations (более агрессивно для Vue)
        .replace(/:\s*[A-Za-z_$][\w$]*(?=\s*[=,)}])/g, '')
        .replace(/interface\s+\w+\s*\{[\s\S]*?\}/g, '')
        .replace(/type\s+\w+\s*=\s*[\s\S]*?;/g, '');
    }

    if (this.framework === 'svelte') {
      cleaned = cleaned
        // Svelte context="module" exports handling
        .replace(/<script\s+context="module"[^>]*>[\s\S]*?<\/script>/gi, '');
    }

    cleaned = cleaned.trim();
    this.logs.push(`[${this.framework}Sanitizer] 🔧 Primary cleaning applied`);
    return cleaned;
  }

  /**
   * Fallback агрессивная очистка
   */
  fallbackCleanModularSyntax(code) {
    this.logs.push(`[${this.framework}Sanitizer] 🔧 Applying fallback aggressive cleaning...`);

    let cleaned = code;

    // 🔥 ФИНАЛЬНОЕ УДАЛЕНИЕ ВСЕХ TS КОНСТРУКЦИЙ - построчно для лучшего контроля
    cleaned = cleaned
      // CS-005: declare statements
      .replace(/^\s*declare\s+.*$/gm, '')
      // Убираем оставшиеся interfaces, types, enums построчно
      .replace(/^.*?\binterface\b.*$/gm, '')
      .replace(/^.*?\btype\s+\w+\s*=.*$/gm, '')
      .replace(/^.*?\benum\b.*$/gm, '')
      // Убираем многострочные type определения
      .replace(/^type\s+\w+\s*=\s*\{[\s\S]*?\}\s*;?\s*$/gm, '')
      // Убираем export type/interface/enum строки (НЕ трогаем объектные литералы)
      .replace(/^.*?export\s+(type|interface|enum)\b.*$/gm, '');

    cleaned = cleaned
      // Any remaining export patterns
      .replace(/^\s*export\s+/gm, '')
      .replace(/;\s*export\s+/g, '; ')
      // Any remaining import patterns (but preserve import.meta)
      .replace(/^\s*import\s+(?!\.meta\b).*$/gm, '')
      // CommonJS patterns
      .replace(/module\.exports/g, 'const fallbackExport')
      .replace(/exports\./g, 'const fallbackExport_')
      .replace(/require\s*\(\s*['"][^'"]*['"]\s*\)/g, '(function(){return{}})()');

    // Фреймворк-специфичная fallback очистка
    if (this.framework === 'vue') {
      cleaned = cleaned.replace(/@import\s+.*$/gm, '');
    }

    // Удаляем пустые строки, оставшиеся после удаления импортов
    cleaned = cleaned.replace(/^\s*[\r\n]/gm, '');

    cleaned = cleaned.trim();
    this.logs.push(`[${this.framework}Sanitizer] 🔧 Fallback cleaning completed`);
    return cleaned;
  }

  /**
   * Валидация кода на наличие модульного синтаксиса
   */
  validateCodeInternal(code) {
    const hasImports = /\bimport\s+(?!\.meta\b)/.test(code);
    const hasExports = /\bexport\s+/.test(code);
    const hasCommonJS = /\b(module\.exports|exports\.|require\()\b/.test(code);

    return { hasImports, hasExports, hasCommonJS };
  }

  /**
   * Проверка, завёрнут ли код в IIFE
   */
  isCodeWrappedInIIFE(code) {
    const trimmed = code.trim();
    return trimmed.startsWith('(function()') && trimmed.endsWith('})();');
  }

  /**
   * IIFE обёртка с определением компонента
   */
  wrapInIIFE(code) {
    this.logs.push(`[${this.framework}Sanitizer] 🔄 Wrapping code in IIFE...`);

    // Проверяем, если уже завёрнут
    if (this.isCodeWrappedInIIFE(code)) {
      this.logs.push(`[${this.framework}Sanitizer] 🔄 Code already wrapped in IIFE`);
      return code;
    }

    // Определяем имя компонента
    const componentName = this.detectComponentName(code);
    this.logs.push(`[${this.framework}Sanitizer] 🔄 Detected component name: ${componentName}`);

    // Создаём IIFE с возвратом компонента
    const iifeCode = '(function() {\n' +
      code +
      '\n\n' +
      '// Return main component for usage\n' +
      'if (typeof ' + componentName + ' !== "undefined") {\n' +
      '  return ' + componentName + ';\n' +
      '}\n' +
      'if (typeof globalThis !== "undefined" && typeof globalThis.' + componentName + ' !== "undefined") {\n' +
      '  return globalThis.' + componentName + ';\n' +
      '}\n' +
      '\n' +
      '// Fallback: find last defined function/class/const\n' +
      'const lastDefined = (function() {\n' +
      '  try {\n' +
      '    const names = Object.getOwnPropertyNames(this).filter(name => \n' +
      '      typeof this[name] === "function" || typeof this[name] === "object"\n' +
      '    );\n' +
      '    return this[names[names.length - 1]];\n' +
      '  } catch (e) {\n' +
      '    return null;\n' +
      '  }\n' +
      '}).call({});\n' +
      '\n' +
      'return lastDefined;\n' +
      '})();';

    this.logs.push(`[${this.framework}Sanitizer] 🔄 IIFE wrapping completed`);
    return iifeCode;
  }

  /**
   * Определение имени компонента
   */
  detectComponentName(code) {
    // Для разных фреймворков разные паттерны
    if (this.framework === 'react') {
      // React: ищем JSX возвращающую функцию или класс
      const reactMatch = code.match(/(?:const|let|var|function|class)\s+([A-Z][a-zA-Z0-9]*)/);
      return reactMatch ? reactMatch[1] : 'ReactComponent';
    }

    if (this.framework === 'vue') {
      // Vue: ищем defineComponent или объект с template
      const vueMatch = code.match(/(?:const|let|var)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:defineComponent|{)/);
      return vueMatch ? vueMatch[1] : 'VueComponent';
    }

    if (this.framework === 'svelte') {
      // Svelte: ищем компонент или SFC структуру
      const svelteMatch = code.match(/(?:const|let|var|function|class)\s+([A-Z][a-zA-Z0-9]*)/);
      if (code.includes('<template>') || code.includes('<script>')) {
        return 'SvelteComponent';
      }
      return svelteMatch ? svelteMatch[1] : 'SvelteComponent';
    }

    // Fallback: любой компонент
    const genericMatch = code.match(/(?:const|let|var|function|class)\s+([A-Z][a-zA-Z0-9]*)/);
    return genericMatch ? genericMatch[1] : 'Component';
  }

  /**
   * Публичный метод для получения логов
   */
  getLogs() {
    return [...this.logs];
  }

  /**
   * Статический метод для быстрой санитизации
   */
  static sanitize(code, framework = 'react') {
    const sanitizer = new UniversalCodeSanitizer(framework);
    return sanitizer.sanitizeCode(code);
  }

  /**
   * Примитивная (но безопасная) трансформация JSX в React.createElement.
   * Это не полноценный парсер, но покрывает типичные случаи однокомпонентных превью.
   * Если Babel доступен в окне, используем его для корректной трансформации.
   */
  transformJSX(input) {
    try {
      // Если доступен Babel Standalone, пробуем ТОЛЬКО им (более надёжно, чем регексы)
      const babel = (typeof window !== 'undefined') ? window.Babel : undefined;
      if (babel && typeof babel.transform === 'function') {
        try {
          const cfg = (typeof window !== 'undefined' && window.WORKING_BABEL_CONFIG)
            ? window.WORKING_BABEL_CONFIG
            : {
                presets: [
                  'typescript',
                  ['react', { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' }]
                ],
                sourceType: 'module',
                filename: 'component.tsx',
                compact: false,
                parserOpts: { plugins: ['jsx', 'typescript'] }
              };
          const result = babel.transform(input, cfg);
          if (result && result.code) return result.code;
        } catch (e) {
          this.logs.push(`[${this.framework}Sanitizer] ⚠️ Babel JSX transform failed, falling back: ${e && e.message}`);
          throw e;
        }
      }
      throw new Error('Babel not available for JSX transform');
    } catch (e) {
      this.logs.push(`[${this.framework}Sanitizer] ❌ Babel unavailable or failed: ${e && e.message}`);
      // Жестко валим вместо опасного фоллбэка на регексы
      throw e;
    }
    // Недостижимо: либо вернули код из Babel, либо бросили исключение
  }

  _tagToRef(tag) {
    // Низкий регистр считаем DOM-тегом, иначе компонентом из области видимости
    if (/^[a-z]/.test(tag)) return `'${tag}'`;
    return tag;
  }

  _wrapChildren(inner) {
    if (!inner) return '';
    // Если это уже выражение в фигурных скобках, пробуем извлечь
    const exprMatch = inner.match(/^\{([\s\S]*)\}$/);
    if (exprMatch) return exprMatch[1].trim();
    // Иначе трактуем как строку
    return JSON.stringify(inner);
  }

  _jsxAttrsToPropsAndChildren(attrText) {
    let propsCode = 'null';
    let children = '';
    const props = {};

    // className -> className, другие атрибуты как строки, {expr} как выражение
    const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|\{([\s\S]*?)\})/g;
    let m;
    while ((m = regex.exec(attrText)) !== null) {
      const name = m[1] === 'class' ? 'className' : m[1];
      const strVal = m[3] ?? m[4];
      const exprVal = m[5];
      if (exprVal !== undefined) {
        props[name] = { type: 'expr', value: exprVal };
      } else {
        props[name] = { type: 'str', value: strVal ?? '' };
      }
    }

    const entries = Object.entries(props);
    if (entries.length > 0) {
      const parts = entries.map(([k, v]) => {
        if (v.type === 'expr') return `${JSON.stringify(k)}: (${v.value})`;
        return `${JSON.stringify(k)}: ${JSON.stringify(v.value)}`;
      });
      propsCode = `{ ${parts.join(', ')} }`;
    }

    return { props: propsCode, children };
  }
}

// Экспорт для Node.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UniversalCodeSanitizer };
}

// Экспорт для браузера
if (typeof window !== 'undefined') {
  window.UniversalCodeSanitizer = UniversalCodeSanitizer;
  console.log('✅ UniversalCodeSanitizer exported to window');
}

/**
 * Экспорт удобных функций
 */
function sanitizeReactCode(code) {
  return UniversalCodeSanitizer.sanitize(code, 'react');
}

function sanitizeVueCode(code) {
  return UniversalCodeSanitizer.sanitize(code, 'vue');
}

function sanitizeSvelteCode(code) {
  return UniversalCodeSanitizer.sanitize(code, 'svelte');
}

function sanitizeUniversalCode(code, framework) {
  return UniversalCodeSanitizer.sanitize(code, framework);
}

// Экспорт функций для браузера
if (typeof window !== 'undefined') {
  window.sanitizeReactCode = sanitizeReactCode;
  window.sanitizeVueCode = sanitizeVueCode;
  window.sanitizeSvelteCode = sanitizeSvelteCode;
  window.sanitizeUniversalCode = sanitizeUniversalCode;
}
