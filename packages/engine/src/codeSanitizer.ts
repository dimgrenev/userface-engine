/**
 * Unified Code Sanitizer Module
 * Централизованная очистка, валидация и IIFE-обёртка для всех путей рендеринга
 */

export type Framework = 'react' | 'vue' | 'svelte';

export interface SanitizationResult {
  cleanCode: string;
  success: boolean;
  logs: string[];
  hasImports: boolean;
  hasExports: boolean;
  hasCommonJS: boolean;
  isWrappedInIIFE: boolean;
}

export interface ValidationResult {
  hasImports: boolean;
  hasExports: boolean;
  hasCommonJS: boolean;
}

/**
 * Единый класс для санитизации кода
 */
export class UniversalCodeSanitizer {
  private logs: string[] = [];

  constructor(private framework: Framework = 'react') {
    this.logs = [];
  }

  /**
   * Главный метод: полная санитизация кода
   */
  public sanitizeCode(code: string): SanitizationResult {
    this.logs = [];
    this.logs.push(`[${this.framework}Sanitizer] 🧹 Starting universal code sanitization...`);

    try {
      // Security-only cleaning; do not attempt TS/ESM stripping here anymore.
      // That is handled by transpiler (esbuild/SWC) upstream.
      let cleanedCode = this.sanitizeForSecurity(code);
      const isWrappedInIIFE = this.isCodeWrappedInIIFE(cleanedCode);
      const v = this.validateCodeInternal(cleanedCode);
      this.logs.push(`[${this.framework}Sanitizer] ✅ Security sanitization completed`);
      return {
        cleanCode: cleanedCode,
        success: true,
        logs: [...this.logs],
        hasImports: v.hasImports,
        hasExports: v.hasExports,
        hasCommonJS: v.hasCommonJS,
        isWrappedInIIFE
      };

    } catch (error: any) {
      this.logs.push(`[${this.framework}Sanitizer] ❌ Sanitization failed: ${error.message}`);
      return {
        cleanCode: code,
        success: false,
        logs: [...this.logs],
        hasImports: false,
        hasExports: false,
        hasCommonJS: false,
        isWrappedInIIFE: false
      };
    }
  }

  /**
   * Основная очистка кода
   */
  private cleanCodeForIframe(code: string): string {
    this.logs.push(`[${this.framework}Sanitizer] 🧹 Starting primary code cleaning...`);

    let cleaned = code;

    // 🔥 АГРЕССИВНАЯ ОЧИСТКА TYPESCRIPT - удаляем ВСЕ TS конструкции
    cleaned = cleaned
      // Interface definitions (многострочные и однострочные)
      .replace(/interface\s+\w+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
      .replace(/interface\s+\w+\s*extends\s+[\w,\s]+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
      // Type aliases - КРИТИЧЕСКИ ВАЖНОЕ ИСПРАВЛЕНИЕ для type Props = {...}
      .replace(/type\s+[A-Za-z_$][\w$]*\s*=\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*;?\s*/g, '')
      .replace(/type\s+[A-Za-z_$][\w$]*\s*=\s*[^;{=]+;?\s*/g, '')
      .replace(/export\s+type\s+[A-Za-z_$][\w$]*\s*=\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}\s*;?\s*/g, '')
      .replace(/export\s+type\s+[A-Za-z_$][\w$]*\s*=\s*[^;{=]+;?\s*/g, '')
      // Enum definitions  
      .replace(/enum\s+\w+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
      .replace(/export\s+enum\s+\w+\s*\{[\s\S]*?\}\s*;?\s*/g, '')
      // TypeScript parameter type annotations - более точные паттерны
      .replace(/\(\s*(\{[^}]*\})\s*:\s*[A-Za-z_$][\w$]*\s*\)/g, '($1)')
      .replace(/\(\s*([^:)]+)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+\s*\)/g, '($1)')
      .replace(/(\w+)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+(?=\s*[,=)}\]])/g, '$1')
      // TypeScript inline type literals in parameters
      .replace(/(\w+)\s*:\s*\{[^}]*\}(?=\s*[,=)}\]])/g, '$1')
      // TypeScript generic type parameters (safe): strip only when followed by a '('
      .replace(/([A-Za-z_$][\w$]*)<[^>]+>(\s*\()/g, '$1$2')
      // TypeScript return type annotations
      .replace(/\)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+\s*=>/g, ') =>')
      .replace(/\)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+\s*\{/g, ') {')
      // as типы и non-null assertions
      .replace(/\s+as\s+[A-Za-z_$][\w$<>|&\[\]?]+/g, '')
      .replace(/!\s*(?=[;\],}])/g, '')
      // Optional chaining с типами
      .replace(/\?\.\s*([a-zA-Z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>|&\[\]?]+/g, '?.$1');

    // 🔧 JSX ТРАНСФОРМАЦИЯ в React.createElement (для React фреймворка)
    if (this.framework === 'react') {
      this.logs.push(`[${this.framework}Sanitizer] 🔄 Starting JSX transformation...`);
      cleaned = this.transformJSX(cleaned);
      this.logs.push(`[${this.framework}Sanitizer] ✅ JSX transformation completed`);
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
      // Exports
      .replace(/export\s+default\s+/g, '')
      .replace(/export\s+(const|let|var|function|class)\s+/g, '$1 ')
      .replace(/export\s+\{[^}]*\}/g, '')
      .replace(/export\s+\*/g, '')
      // CommonJS
      .replace(/module\.exports/g, 'const fallbackExport')
      .replace(/exports\./g, 'const fallbackExport_')
      .replace(/require\(/g, '(function(){return{};})(');

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
  private fallbackCleanModularSyntax(code: string): string {
    this.logs.push(`[${this.framework}Sanitizer] 🔧 Applying fallback aggressive cleaning...`);

    let cleaned = code;

    // 🔥 ФИНАЛЬНОЕ УДАЛЕНИЕ ВСЕХ TS КОНСТРУКЦИЙ
    cleaned = cleaned
      // Убираем оставшиеся interfaces, types, enums построчно
      .replace(/^.*?\binterface\b.*$/gm, '')
      .replace(/^.*?\btype\s+\w+\s*=.*$/gm, '')
      .replace(/^.*?\benum\b.*$/gm, '')
      // Убираем строки содержащие только TS декларации
      .replace(/^.*?:\s*[A-Z][\w<>|&\[\]]+\s*[;,]?\s*$/gm, '')
      // Убираем export type/interface/enum строки
      .replace(/^.*?export\s+(type|interface|enum)\b.*$/gm, '');

    cleaned = cleaned
      // Any remaining export patterns
      .replace(/^\s*export\s+/gm, '')
      .replace(/;\s*export\s+/g, '; ')
      // Any remaining import patterns
      .replace(/^\s*import\s+.*$/gm, '')
      // CommonJS patterns
      .replace(/module\.exports/g, 'const fallbackExport')
      .replace(/exports\./g, 'const fallbackExport_')
      .replace(/require\(/g, '(function(){return{};})(');

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
  private validateCodeInternal(code: string): ValidationResult {
    const hasImports = /\bimport\s+/.test(code);
    const hasExports = /\bexport\s+/.test(code);
    const hasCommonJS = /\b(module\.exports|exports\.|require\()\b/.test(code);

    return { hasImports, hasExports, hasCommonJS };
  }

  /**
   * Проверка, завёрнут ли код в IIFE
   */
  private isCodeWrappedInIIFE(code: string): boolean {
    const trimmed = code.trim();
    return trimmed.startsWith('(function()') && trimmed.endsWith('})();');
  }

  /**
   * IIFE обёртка с определением компонента
   */
  private wrapInIIFE(code: string): string {
    this.logs.push(`[${this.framework}Sanitizer] 🔄 Wrapping code in IIFE...`);

    // Проверяем, если уже завёрнут
    if (this.isCodeWrappedInIIFE(code)) {
      this.logs.push(`[${this.framework}Sanitizer] 🔄 Code already wrapped in IIFE`);
      return code;
    }

    // Определяем имя компонента
    let componentName = this.detectComponentName(code);
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
  private detectComponentName(code: string): string {
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
  public getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Очистка кода от опасных конструкций, которые могут нарушить работу песочницы.
   * Этот метод НЕ занимается транспиляцией или удалением TS/ESM синтаксиса.
   * @param code - Код для очистки
   * @returns Очищенный код
   */
  public sanitizeForSecurity(code: string): string {
    this.logs.push(`[SecuritySanitizer] 🛡️ Starting security sanitization...`);
    
    let cleaned = code;

    // Удаляем опасные вызовы, которые могут повлиять на родительское окно
    cleaned = cleaned.replace(/window\.top/g, 'self');
    cleaned = cleaned.replace(/window\.parent/g, 'self');
    cleaned = cleaned.replace(/window\.opener/g, 'null');
    
    // Заменяем eval на безопасную заглушку
    cleaned = cleaned.replace(/eval\s*\(/g, '(() => undefined)(');

    // Удаляем теги <script>, которые могли случайно попасть в код
    cleaned = cleaned.replace(/<\/?script>/gi, '');

    this.logs.push(`[SecuritySanitizer] ✅ Security sanitization completed.`);
    return cleaned;
  }

  /**
   * Статический метод для быстрой санитизации
   */
  public static sanitize(code: string, framework: Framework = 'react'): SanitizationResult {
    const sanitizer = new UniversalCodeSanitizer(framework);
    return sanitizer.sanitizeCode(code);
  }

  /**
   * Примитивная (но безопасная) трансформация JSX в React.createElement.
   * Это не полноценный парсер, но покрывает типичные случаи однокомпонентных превью.
   * Если Babel доступен в окне, используем его для корректной трансформации.
   */
  private transformJSX(input: string): string {
    try {
      // В TypeScript контексте Babel обычно недоступен, используем fallback
    } catch (e: any) {
      this.logs.push(`[${this.framework}Sanitizer] ⚠️ Babel JSX transform failed, falling back: ${e && e.message}`);
    }

    // Фоллбек: очень простая трансформация для базовых тегов/компонентов
    let code = input;

    // 1) Преобразуем фрагменты <>...</>
    // Сначала обрабатываем пустые фрагменты, чтобы не получить лишнюю запятую перед закрывающей скобкой
    code = code.replace(/<>\s*<\/>/g, 'React.createElement(React.Fragment, null)');
    // Затем обрабатываем непустые фрагменты
    code = code.replace(/<>/g, 'React.createElement(React.Fragment, null, ').replace(/<\/>/g, ')');

    // 2) Обрабатываем самозакрывающиеся теги <Tag a={b} />
    code = code.replace(/<([A-Za-z_][\w.]*)\s*([^>]*)\/>/g, (m, tag, attrs) => {
      // Парсим атрибуты
      const parsedAttrs = this.parseJSXAttributes(attrs.trim());
      const propsObj = parsedAttrs ? `, ${parsedAttrs}` : ', null';
      return `React.createElement(${tag}${propsObj})`;
    });

    // 3) Обрабатываем открывающие и закрывающие теги <Tag>...</Tag>
    // Это сложнее, так как нужно учесть вложенность
    code = this.transformJSXPairs(code);

    // 4) Преобразуем выражения JSX в фигурных скобках (простая обработка)
    // {variable} -> уже валидный JavaScript, оставляем как есть
    
    this.logs.push(`[${this.framework}Sanitizer] ✅ JSX fallback transformation applied`);
    return code;
  }

  /**
   * Парсинг атрибутов JSX
   */
  private parseJSXAttributes(attrString: string): string {
    if (!attrString) return 'null';
    
    const attrs: string[] = [];
    // Простой парсер атрибутов: attr="value" или attr={expression}
    const attrRegex = /(\w+)=(?:"([^"]*)"|{([^}]*)})/g;
    let match;
    
    while ((match = attrRegex.exec(attrString)) !== null) {
      const [, name, stringValue, exprValue] = match;
      if (stringValue !== undefined) {
        attrs.push(`${name}: "${stringValue}"`);
      } else if (exprValue !== undefined) {
        attrs.push(`${name}: ${exprValue}`);
      }
    }
    
    // Обрабатываем булевые атрибуты
    const booleanAttrRegex = /\b(\w+)(?!=)/g;
    const processedAttrs = new Set(attrs.map(a => a.split(':')[0]));
    let boolMatch;
    
    while ((boolMatch = booleanAttrRegex.exec(attrString)) !== null) {
      const attrName = boolMatch[1];
      if (!processedAttrs.has(attrName)) {
        attrs.push(`${attrName}: true`);
      }
    }
    
    return attrs.length > 0 ? `{ ${attrs.join(', ')} }` : 'null';
  }

  /**
   * Обработка пар открывающих/закрывающих JSX тегов
   */
  private transformJSXPairs(code: string): string {
    // Рекурсивно обрабатываем JSX теги изнутри наружу
    let result = code;
    let changed = true;
    
    while (changed) {
      changed = false;
      
      // Ищем самую внутреннюю пару тегов (без вложенных JSX тегов)
      const tagRegex = /<([A-Za-z_][\w.]*)\s*([^>]*)>([^<]*(?:<(?!\/?\w)[^<]*)*)<\/\1>/g;
      
      result = result.replace(tagRegex, (match, tagName, attrs, children) => {
        changed = true;
        const parsedAttrs = this.parseJSXAttributes(attrs.trim());
        const propsObj = parsedAttrs ? `, ${parsedAttrs}` : ', null';
        
        // Обрабатываем детей
        const processedChildren = children.trim() ? `, ${children.trim()}` : '';
        
        return `React.createElement(${tagName}${propsObj}${processedChildren})`;
      });
    }
    
    return result;
  }

  private _tagToRef(tag: string): string {
    // Низкий регистр считаем DOM-тегом, иначе компонентом из области видимости
    if (/^[a-z]/.test(tag)) return `'${tag}'`;
    return tag;
  }

  private _wrapChildren(inner: string): string {
    if (!inner) return '';
    // Если это уже выражение в фигурных скобках, пробуем извлечь
    const exprMatch = inner.match(/^\{([\s\S]*)\}$/);
    if (exprMatch) return exprMatch[1].trim();
    // Иначе трактуем как строку
    return JSON.stringify(inner);
  }

  private _jsxAttrsToPropsAndChildren(attrText: string): { props: string; children: string } {
    let propsCode = 'null';
    let children = '';
    const props: Record<string, { type: 'expr' | 'str'; value: string }> = {};

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

/**
 * Экспорт удобных функций
 */
export function sanitizeReactCode(code: string): SanitizationResult {
  return UniversalCodeSanitizer.sanitize(code, 'react');
}

export function sanitizeVueCode(code: string): SanitizationResult {
  return UniversalCodeSanitizer.sanitize(code, 'vue');
}

export function sanitizeSvelteCode(code: string): SanitizationResult {
  return UniversalCodeSanitizer.sanitize(code, 'svelte');
}

/**
 * Универсальная функция санитизации
 */
export function sanitizeUniversalCode(code: string, framework: Framework): SanitizationResult {
  return UniversalCodeSanitizer.sanitize(code, framework);
}