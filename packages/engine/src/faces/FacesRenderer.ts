/**
 * Рендерер компонентов из JSON-спецификаций (Faces)
 * Обеспечивает универсальный рендеринг компонентов любых фреймворков
 */

import {
  ComponentFace,
  FaceRenderResult,
  FaceValidationResult,
  PropDefinition,
  StyleDefinition,
  FrameworkType
} from './types';

const FRAMEWORK_CDN: Record<string, string> = {
  REACT_DEV: 'https://unpkg.com/react@18/umd/react.development.js',
  REACT_DOM_DEV: 'https://unpkg.com/react-dom@18/umd/react-dom.development.js',
  BABEL_STANDALONE: 'https://unpkg.com/@babel/standalone/babel.min.js',
  VUE_GLOBAL: 'https://unpkg.com/vue@3/dist/vue.global.js',
};

/**
 * Генератор кода для разных фреймворков
 */
class CodeGenerator {
  /**
   * Генерирует React компонент из Face
   */
  generateReactComponent(face: ComponentFace, props: Record<string, any>): string {
    const componentName = face.name;
    const propsInterface = this.generatePropsInterface(face.props, 'React');
    const componentBody = this.generateReactComponentBody(face, props);
    const imports = this.generateReactImports(face);
    
    return `
${imports}

${propsInterface}

const ${componentName}: React.FC<${componentName}Props> = (props) => {
${componentBody}
};

export default ${componentName};
    `.trim();
  }
  
  /**
   * Генерирует Vue компонент из Face
   */
  generateVueComponent(face: ComponentFace, props: Record<string, any>): string {
    const template = this.generateVueTemplate(face, props);
    const script = this.generateVueScript(face, props);
    const styles = this.generateVueStyles(face.styles);
    
    return `
<template>
${template}
</template>

<script setup lang="ts">
${script}
</script>

<style scoped>
${styles}
</style>
    `.trim();
  }
  
  /**
   * Генерирует Svelte компонент из Face
   */
  generateSvelteComponent(face: ComponentFace, props: Record<string, any>): string {
    const script = this.generateSvelteScript(face, props);
    const template = this.generateSvelteTemplate(face, props);
    const styles = this.generateSvelteStyles(face.styles);
    
    return `
<script lang="ts">
${script}
</script>

${template}

<style>
${styles}
</style>
    `.trim();
  }
  
  private generatePropsInterface(props: PropDefinition[], framework: string): string {
    const interfaceName = framework === 'React' ? `${framework}Props` : 'Props';
    
    const propsLines = props.map(prop => {
      const optional = prop.required ? '' : '?';
      const type = this.mapPropTypeToTypeScript(prop);
      const comment = prop.description ? `  /** ${prop.description} */\n` : '';
      
      return `${comment}  ${prop.name}${optional}: ${type};`;
    }).join('\n');
    
    return `interface ${interfaceName} {
${propsLines}
}`;
  }
  
  private generateReactComponentBody(face: ComponentFace, props: Record<string, any>): string {
    // Деструктуризация пропсов
    const propNames = face.props.map(p => p.name).join(', ');
    const destructuring = propNames ? `  const { ${propNames} } = props;` : '';
    
    // Базовая структура компонента
    const jsx = this.generateReactJSX(face, props);
    
    return `
${destructuring}

  return (
${jsx}
  );
    `.trim();
  }
  
  private generateReactJSX(face: ComponentFace, props: Record<string, any>): string {
    // Простая генерация JSX на основе пропсов
    const className = face.styles.length > 0 ? ` className="${face.name.toLowerCase()}"` : '';
    
    // Генерируем содержимое на основе типов пропсов
    const content = this.generateContentFromProps(face.props, props, 'react');
    
    return `    <div${className}>
      <h2>{props.title || '${face.displayName || face.name}'}</h2>
${content}
    </div>`;
  }
  
  private generateVuePropsDefinition(props: PropDefinition[]): string {
    const propsArray = props.map(prop => {
      const type = this.mapPropTypeToVue(prop);
      const required = prop.required ? ', required: true' : '';
      const defaultValue = prop.defaultValue !== undefined 
        ? `, default: ${JSON.stringify(prop.defaultValue)}` 
        : '';
      
      return `  ${prop.name}: { type: ${type}${required}${defaultValue} }`;
    }).join(',\n');
    
    return `const props = defineProps({
${propsArray}
});`;
  }
  
  private generateVueTemplate(face: ComponentFace, props: Record<string, any>): string {
    const className = face.styles.length > 0 ? ` class="${face.name.toLowerCase()}"` : '';
    const content = this.generateContentFromProps(face.props, props, 'vue');
    
    return `  <div${className}>
    <h2>{{ title || '${face.displayName || face.name}' }}</h2>
${content}
  </div>`;
  }
  
  private generateVueScript(face: ComponentFace, _props: Record<string, any>): string {
    const propsDefinition = this.generateVuePropsDefinition(face.props);
    const imports = this.generateVueImports(face);
    
    return `
${imports}

${propsDefinition}
    `.trim();
  }
  
  private generateSvelteScript(face: ComponentFace, _props: Record<string, any>): string {
    const exports = face.props.map(prop => {
      const defaultValue = prop.defaultValue !== undefined 
        ? ` = ${JSON.stringify(prop.defaultValue)}` 
        : '';
      
      return `  export let ${prop.name}${defaultValue};`;
    }).join('\n');
    
    const imports = this.generateSvelteImports(face);
    
    return `
${imports}

${exports}
    `.trim();
  }
  
  private generateSvelteTemplate(face: ComponentFace, props: Record<string, any>): string {
    const className = face.styles.length > 0 ? ` class="${face.name.toLowerCase()}"` : '';
    const content = this.generateContentFromProps(face.props, props, 'svelte');
    
    return `<div${className}>
  <h2>{title || '${face.displayName || face.name}'}</h2>
${content}
</div>`;
  }
  
  private generateContentFromProps(
    props: PropDefinition[], 
    values: Record<string, any>, 
    framework: 'react' | 'vue' | 'svelte'
  ): string {
    const lines: string[] = [];
    
    for (const prop of props) {
      const value = values[prop.name];
      if (value === undefined) continue;
      
      switch (prop.type) {
        case 'string':
          lines.push(this.generateStringDisplay(prop.name, framework));
          break;
        case 'number':
          lines.push(this.generateNumberDisplay(prop.name, framework));
          break;
        case 'boolean':
          lines.push(this.generateBooleanDisplay(prop.name, framework));
          break;
        case 'array':
          lines.push(this.generateArrayDisplay(prop.name, framework));
          break;
        case 'object':
          lines.push(this.generateObjectDisplay(prop.name, framework));
          break;
      }
    }
    
    return lines.map(line => `      ${line}`).join('\n');
  }
  
  private generateStringDisplay(propName: string, framework: string): string {
    switch (framework) {
      case 'react':
        return `<p><strong>${propName}:</strong> {${propName}}</p>`;
      case 'vue':
        return `<p><strong>${propName}:</strong> {{ ${propName} }}</p>`;
      case 'svelte':
        return `<p><strong>${propName}:</strong> {${propName}}</p>`;
      default:
        return '';
    }
  }
  
  private generateNumberDisplay(propName: string, framework: string): string {
    switch (framework) {
      case 'react':
        return `<p><strong>${propName}:</strong> {${propName}}</p>`;
      case 'vue':
        return `<p><strong>${propName}:</strong> {{ ${propName} }}</p>`;
      case 'svelte':
        return `<p><strong>${propName}:</strong> {${propName}}</p>`;
      default:
        return '';
    }
  }
  
  private generateBooleanDisplay(propName: string, framework: string): string {
    switch (framework) {
      case 'react':
        return `{${propName} && <p><strong>${propName}:</strong> true</p>}`;
      case 'vue':
        return `<p v-if="${propName}"><strong>${propName}:</strong> true</p>`;
      case 'svelte':
        return `{#if ${propName}}<p><strong>${propName}:</strong> true</p>{/if}`;
      default:
        return '';
    }
  }
  
  private generateArrayDisplay(propName: string, framework: string): string {
    switch (framework) {
      case 'react':
        return `<div><strong>${propName}:</strong> {${propName}?.map((item, i) => <span key={i}>{JSON.stringify(item)} </span>)}</div>`;
      case 'vue':
        return `<div><strong>${propName}:</strong> <span v-for="(item, i) in ${propName}" :key="i">{{ JSON.stringify(item) }} </span></div>`;
      case 'svelte':
        return `<div><strong>${propName}:</strong> {#each ${propName} as item, i}<span>{JSON.stringify(item)} </span>{/each}</div>`;
      default:
        return '';
    }
  }
  
  private generateObjectDisplay(propName: string, framework: string): string {
    switch (framework) {
      case 'react':
        return `<pre><strong>${propName}:</strong> {JSON.stringify(${propName}, null, 2)}</pre>`;
      case 'vue':
        return `<pre><strong>${propName}:</strong> {{ JSON.stringify(${propName}, null, 2) }}</pre>`;
      case 'svelte':
        return `<pre><strong>${propName}:</strong> {JSON.stringify(${propName}, null, 2)}</pre>`;
      default:
        return '';
    }
  }
  
  private generateReactImports(face: ComponentFace): string {
    const imports = ['import React from "react";'];
    
    // Добавляем импорты зависимостей
    for (const dep of face.dependencies) {
      if (dep.type === 'npm' && !dep.devDependency) {
        imports.push(`import ${dep.name} from "${dep.name}";`);
      }
    }
    
    return imports.join('\n');
  }
  
  private generateVueImports(face: ComponentFace): string {
    const imports = ['import { defineProps } from "vue";'];
    
    // Добавляем импорты зависимостей
    for (const dep of face.dependencies) {
      if (dep.type === 'npm' && !dep.devDependency) {
        imports.push(`import ${dep.name} from "${dep.name}";`);
      }
    }
    
    return imports.join('\n');
  }
  
  private generateSvelteImports(face: ComponentFace): string {
    const imports: string[] = [];
    
    // Добавляем импорты зависимостей
    for (const dep of face.dependencies) {
      if (dep.type === 'npm' && !dep.devDependency) {
        imports.push(`import ${dep.name} from "${dep.name}";`);
      }
    }
    
    return imports.join('\n');
  }
  
  private generateVueStyles(styles: StyleDefinition[]): string {
    return styles
      .filter(style => style.type === 'css' || style.compiled)
      .map(style => style.compiled || style.source)
      .join('\n\n');
  }
  
  private generateSvelteStyles(styles: StyleDefinition[]): string {
    return styles
      .filter(style => style.type === 'css' || style.compiled)
      .map(style => style.compiled || style.source)
      .join('\n\n');
  }
  
  private mapPropTypeToTypeScript(prop: PropDefinition): string {
    switch (prop.type) {
      case 'string': return 'string';
      case 'number': return 'number';
      case 'boolean': return 'boolean';
      case 'array': return 'any[]';
      case 'object': return 'Record<string, any>';
      case 'function': return '(...args: any[]) => any';
      case 'node': return 'React.ReactNode';
      case 'element': return 'React.ReactElement';
      default: return 'any';
    }
  }
  
  private mapPropTypeToVue(prop: PropDefinition): string {
    switch (prop.type) {
      case 'string': return 'String';
      case 'number': return 'Number';
      case 'boolean': return 'Boolean';
      case 'array': return 'Array';
      case 'object': return 'Object';
      case 'function': return 'Function';
      default: return 'Object';
    }
  }
}

/**
 * Компилятор стилей с асинхронной обработкой
 */
class StyleCompiler {
  private sassCache = new Map<string, string>();
  private postCssCache = new Map<string, string>();
  private fallbackCache = new Map<string, string>();
  
  // Динамические компиляторы
  private sassCompiler: any = null;
  private postCssProcessor: any = null;
  private lessCompiler: any = null;
  
  /**
   * Компилирует стили для изолированного рендеринга (асинхронно)
   */
  async compileStyles(styles: StyleDefinition[], componentName: string): Promise<string> {
    const compiledStyles: string[] = [];
    
    // Инициализируем компиляторы при первом вызове
    await this.initializeCompilers();
    
    for (const style of styles) {
      try {
        const cacheKey = this.createCacheKey(style, componentName);
        
        // Проверяем кэш сначала
        const cached = this.getFromCache(style.type, cacheKey);
        if (cached) {
          compiledStyles.push(cached);
          continue;
        }
        
        let compiledCss = '';
        
        switch (style.type) {
          case 'css':
            compiledCss = this.scopeCSS(style.source, componentName);
            break;
            
          case 'scss':
          case 'sass':
            compiledCss = await this.compileSass(style.source, componentName, style.type);
            break;
            
          case 'less':
            compiledCss = await this.compileLess(style.source, componentName);
            break;
            
          case 'css-modules':
            compiledCss = this.compileCSSModules(style.source, componentName);
            break;
            
          case 'styled-components':
            compiledCss = this.compileStyledComponents(style.source, componentName);
            break;
            
          default:
            if (style.compiled) {
              compiledCss = this.scopeCSS(style.compiled, componentName);
            } else {
              // Fallback: обрабатываем как обычный CSS
              compiledCss = this.scopeCSS(style.source, componentName);
            }
        }
        
        // Применяем PostCSS оптимизации
        compiledCss = await this.optimizeWithPostCSS(compiledCss, componentName);
        
        // Кэшируем результат
        this.setToCache(style.type, cacheKey, compiledCss);
        
        compiledStyles.push(compiledCss);
        
      } catch (error) {
        console.warn(`Ошибка компиляции стилей для ${componentName}:`, error);
        
        // Fallback: базовая обработка CSS
        const fallbackCss = this.createFallbackCSS(style, componentName);
        compiledStyles.push(fallbackCss);
      }
    }
    
    return compiledStyles.join('\n\n');
  }
  
  /**
   * Инициализация компиляторов с динамическими импортами
   */
  private async initializeCompilers(): Promise<void> {
    try {
      // Инициализируем SASS компилятор
      if (!this.sassCompiler) {
        this.sassCompiler = await this.loadSassCompiler();
      }
      
      // Инициализируем PostCSS
      if (!this.postCssProcessor) {
        this.postCssProcessor = await this.loadPostCSS();
      }
      
      // Инициализируем LESS компилятор
      if (!this.lessCompiler) {
        this.lessCompiler = await this.loadLessCompiler();
      }
      
    } catch (error) {
      console.warn('Некоторые компиляторы стилей недоступны, используем fallback режим:', error);
    }
  }
  
  /**
   * Загрузка SASS компилятора с фоллбэками
   */
  private async loadSassCompiler(): Promise<any> {
    try {
      // Пытаемся загрузить Dart Sass (приоритет)
      const sass = await this.dynamicImport('sass');
      return sass.default || sass;
    } catch {
      try {
        // Fallback на node-sass
        const nodeSass = await this.dynamicImport('node-sass');
        return {
          compileString: (source: string, options: any) => {
            const result = nodeSass.default.renderSync({
              data: source,
              ...options
            });
            return { css: result.css.toString() };
          }
        };
      } catch {
        // Fallback на sassnano (минимальный CSS препроцессор)
        return this.createMinimalSassProcessor();
      }
    }
  }
  
  /**
   * Загрузка PostCSS с плагинами
   */
  private async loadPostCSS(): Promise<any> {
    try {
      const postcss = await this.dynamicImport('postcss');
      const autoprefixer = await this.dynamicImport('autoprefixer');
      const cssnano = await this.dynamicImport('cssnano');
      
      const processor = postcss.default([
        autoprefixer.default(),
        cssnano.default({ preset: 'default' })
      ]);
      
      return processor;
    } catch {
      // Fallback: базовая минификация
      return {
        process: (css: string) => Promise.resolve({
          css: this.minifyCSS(css)
        })
      };
    }
  }
  
  /**
   * Загрузка LESS компилятора
   */
  private async loadLessCompiler(): Promise<any> {
    try {
      const less = await this.dynamicImport('less');
      return less.default || less;
    } catch {
      // Fallback: обрабатываем как SCSS
      return null;
    }
  }
  
  /**
   * Безопасный динамический импорт без строгой проверки типов модулей
   */
  private async dynamicImport(moduleName: string): Promise<any> {
    // Используем eval для избежания проверки модулей на этапе типов
    const importer: any = (0, eval)('import');
    return importer(moduleName);
  }
  
  /**
   * Компиляция SASS/SCSS с автовосстановлением
   */
  private async compileSass(source: string, componentName: string, type: 'sass' | 'scss'): Promise<string> {
    if (!this.sassCompiler) {
      return this.createFallbackSass(source, componentName);
    }
    
    try {
      const result = this.sassCompiler.compileString(source, {
        syntax: type,
        style: 'expanded',
        sourceMap: false,
        loadPaths: ['node_modules']
      });
      
      return this.scopeCSS(result.css, componentName);
      
    } catch (error) {
      console.warn(`SASS компиляция failed для ${componentName}, используем fallback:`, error);
      return this.createFallbackSass(source, componentName);
    }
  }
  
  /**
   * Компиляция LESS
   */
  private async compileLess(source: string, componentName: string): Promise<string> {
    if (!this.lessCompiler) {
      // Обрабатываем как SCSS fallback
      return this.createFallbackSass(source, componentName);
    }
    
    try {
      const result = await this.lessCompiler.render(source, {
        compress: false,
        paths: ['node_modules']
      });
      
      return this.scopeCSS(result.css, componentName);
      
    } catch (error) {
      console.warn(`LESS компиляция failed для ${componentName}, используем fallback:`, error);
      return this.createFallbackSass(source, componentName);
    }
  }
  
  /**
   * Оптимизация CSS через PostCSS
   */
  private async optimizeWithPostCSS(css: string, componentName: string): Promise<string> {
    if (!this.postCssProcessor) {
      return this.minifyCSS(css);
    }
    
    try {
      const result = await this.postCssProcessor.process(css, { from: undefined });
      return result.css;
    } catch (error) {
      console.warn(`PostCSS оптимизация failed для ${componentName}:`, error);
      return this.minifyCSS(css);
    }
  }
  
  /**
   * Создание минимального SASS процессора (fallback)
   */
  private createMinimalSassProcessor(): any {
    return {
      compileString: (source: string) => {
        // Базовая обработка SASS/SCSS переменных
        let processed = source;
        
        // Обрабатываем переменные $var: value;
        const variables = new Map<string, string>();
        processed = processed.replace(/\$([a-zA-Z_][\w-]*)\s*:\s*([^;]+);/g, (match, name, value) => {
          variables.set(name, value.trim());
          return '';
        });
        
        // Заменяем использование переменных
        variables.forEach((value, name) => {
          const regex = new RegExp(`\\$${name}\\b`, 'g');
          processed = processed.replace(regex, value);
        });
        
        // Обрабатываем нестинг (простой)
        processed = this.processNesting(processed);
        
        return { css: processed };
      }
    };
  }
  
  /**
   * Обработка CSS нестинга (простая)
   */
  private processNesting(css: string): string {
    // Простая обработка нестинга - раскрываем один уровень
    return css.replace(/([^{}]+)\s*{\s*([^{}]*(?:{[^{}]*}[^{}]*)*)\s*}/g, (match: string, selector: string, content: string) => {
      const trimmedSelector = selector.trim();
      
      // Ищем вложенные правила
      const nested: string[] = [];
      const nonNested: string[] = [];
      
      content.replace(/([^{}]+)(\{[^{}]*\})/g, (nestedMatch: string, nestedSelector: string, nestedContent: string) => {
        const combinedSelector = nestedSelector.trim().startsWith('&') 
          ? nestedSelector.trim().replace('&', trimmedSelector)
          : `${trimmedSelector} ${nestedSelector.trim()}`;
        
        nested.push(`${combinedSelector} ${nestedContent}`);
        return '';
      });
      
      // Остальное содержимое - обычные свойства
      const cleanContent = content.replace(/([^{}]+)(\{[^{}]*\})/g, '');
      if (cleanContent.trim()) {
        nonNested.push(`${trimmedSelector} { ${cleanContent} }`);
      }
      
      return [...nonNested, ...nested].join('\n');
    });
  }
  
  /**
   * Fallback SASS компиляция
   */
  private createFallbackSass(source: string, componentName: string): string {
    try {
      const processor = this.createMinimalSassProcessor();
      const result = processor.compileString(source);
      return this.scopeCSS(result.css, componentName);
    } catch {
      // Последний fallback - обрабатываем как обычный CSS
      return this.scopeCSS(source, componentName);
    }
  }
  
  /**
   * Fallback CSS генерация при ошибках
   */
  private createFallbackCSS(style: StyleDefinition, componentName: string): string {
    const fallbackCSS = `
/* Fallback CSS для ${componentName} - оригинальный тип: ${style.type} */
.${componentName.toLowerCase()}-fallback {
  /* Базовые стили при ошибке компиляции */
  font-family: inherit;
  color: inherit;
}

/* Исходный код (закомментирован): 
${style.source.split('\n').map(line => `   ${line}`).join('\n')}
*/
    `.trim();
    
    return fallbackCSS;
  }
  
  /**
   * Простая минификация CSS
   */
  private minifyCSS(css: string): string {
    return css
      .replace(/\/\*[\s\S]*?\*\//g, '') // Удаляем комментарии
      .replace(/\s+/g, ' ') // Сжимаем пробелы
      .replace(/;\s*}/g, '}') // Убираем последние точки с запятой
      .replace(/\s*{\s*/g, '{') // Убираем пробелы вокруг {
      .replace(/}\s*/g, '}') // Убираем пробелы после }
      .replace(/:\s*/g, ':') // Убираем пробелы после :
      .replace(/;\s*/g, ';') // Убираем пробелы после ;
      .trim();
  }
  
  /**
   * Кэширование
   */
  private createCacheKey(style: StyleDefinition, componentName: string): string {
    return `${componentName}_${style.type}_${this.generateHash(style.source)}`;
  }
  
  private getFromCache(type: string, key: string): string | null {
    switch (type) {
      case 'scss':
      case 'sass':
        return this.sassCache.get(key) || null;
      case 'css':
      case 'css-modules':
      case 'styled-components':
        return this.postCssCache.get(key) || null;
      default:
        return this.fallbackCache.get(key) || null;
    }
  }
  
  private setToCache(type: string, key: string, value: string): void {
    switch (type) {
      case 'scss':
      case 'sass':
        this.sassCache.set(key, value);
        break;
      case 'css':
      case 'css-modules':
      case 'styled-components':
        this.postCssCache.set(key, value);
        break;
      default:
        this.fallbackCache.set(key, value);
    }
    
    // Автоочистка кэша при превышении лимита
    this.cleanupCacheIfNeeded();
  }
  
  private cleanupCacheIfNeeded(): void {
    const maxCacheSize = 100;
    
    [this.sassCache, this.postCssCache, this.fallbackCache].forEach(cache => {
      if (cache.size > maxCacheSize) {
        const entries = Array.from(cache.entries());
        // Удаляем первые 30% записей (FIFO)
        const toDelete = entries.slice(0, Math.floor(entries.length * 0.3));
        toDelete.forEach(([key]) => cache.delete(key));
      }
    });
  }
  
  private scopeCSS(css: string, componentName: string): string {
    const scopeClass = `.${componentName.toLowerCase()}`;
    
    // Простое добавление scope к селекторам
    return css.replace(/([^{}]+){/g, (match, selector) => {
      const trimmedSelector = selector.trim();
      if (trimmedSelector.startsWith('@') || trimmedSelector.includes('keyframes')) {
        return match; // Не изменяем at-rules
      }
      return `${scopeClass} ${trimmedSelector} {`;
    });
  }
  
  private compileCSSModules(css: string, componentName: string): string {
    // Простая эмуляция CSS Modules
    const modulePrefix = componentName.toLowerCase();
    
    return css.replace(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g, (match, className) => {
      return `.${modulePrefix}_${className}_${this.generateHash(className)}`;
    });
  }
  
  private compileStyledComponents(css: string, componentName: string): string {
    // Простая компиляция styled-components
    const styledClass = `.${componentName.toLowerCase()}-styled`;
    
    return `${styledClass} {
${css}
}`;
  }
  
  private generateHash(input: string): string {
    // Простой hash для CSS Modules
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).substr(0, 6);
  }
}

/**
 * Валидатор Face
 */
class FaceValidator {
  /**
   * Валидирует Face перед рендерингом
   */
  validateFace(face: ComponentFace): FaceValidationResult {
    const errors: any[] = [];
    const warnings: any[] = [];
    let score = 100;
    
    // Проверка обязательных полей
    if (!face.id) {
      errors.push({ field: 'id', message: 'ID компонента обязателен', severity: 'error' });
      score -= 20;
    }
    
    if (!face.name) {
      errors.push({ field: 'name', message: 'Имя компонента обязательно', severity: 'error' });
      score -= 20;
    }
    
    if (!face.framework || !['react', 'vue', 'svelte'].includes(face.framework)) {
      errors.push({ field: 'framework', message: 'Неподдерживаемый фреймворк', severity: 'error' });
      score -= 30;
    }
    
    // Проверка пропсов
    if (!face.props || !Array.isArray(face.props)) {
      warnings.push({ field: 'props', message: 'Пропсы не определены', suggestion: 'Добавьте определения пропсов' });
      score -= 10;
    } else {
      for (const prop of face.props) {
        if (!prop.name) {
          errors.push({ field: 'props', message: `Пропс без имени`, severity: 'error' });
          score -= 5;
        }
        if (!prop.type) {
          warnings.push({ field: 'props', message: `Пропс ${prop.name} без типа`, suggestion: 'Укажите тип пропса' });
          score -= 2;
        }
      }
    }
    
    // Проверка стилей
    if (!face.styles || face.styles.length === 0) {
      warnings.push({ field: 'styles', message: 'Стили не определены', suggestion: 'Добавьте стили для лучшего отображения' });
      score -= 5;
    }
    
    // Проверка метаданных
    if (!face.metadata) {
      warnings.push({ field: 'metadata', message: 'Метаданные отсутствуют', suggestion: 'Добавьте метаданные' });
      score -= 5;
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      score: Math.max(0, score)
    };
  }
  
  /**
   * Валидирует пропсы для рендеринга
   */
  validateProps(face: ComponentFace, props: Record<string, any>): FaceValidationResult {
    const errors: any[] = [];
    const warnings: any[] = [];
    let score = 100;
    
    // Проверяем обязательные пропсы
    for (const propDef of face.props) {
      if (propDef.required && !(propDef.name in props)) {
        errors.push({
          field: propDef.name,
          message: `Обязательный пропс ${propDef.name} не предоставлен`,
          severity: 'error'
        });
        score -= 15;
      }
      
      // Проверяем типы
      if (propDef.name in props) {
        const value = props[propDef.name];
        if (!this.validatePropType(value, propDef)) {
          warnings.push({
            field: propDef.name,
            message: `Пропс ${propDef.name} имеет неверный тип`,
            suggestion: `Ожидается ${propDef.type}`
          });
          score -= 5;
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      score: Math.max(0, score)
    };
  }
  
  private validatePropType(value: any, propDef: PropDefinition): boolean {
    switch (propDef.type) {
      case 'string':
        return typeof value === 'string';
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return typeof value === 'object' && value !== null && !Array.isArray(value);
      case 'function':
        return typeof value === 'function';
      default:
        return true; // any type
    }
  }
}

/**
 * Основной рендерер Face
 */
export class FacesRenderer {
  private codeGenerator = new CodeGenerator();
  private styleCompiler = new StyleCompiler();
  private validator = new FaceValidator();
  // Кэш рендеров в памяти
  private renderCache = new Map<string, { html: string; css: string; createdAt: number; expiresAt?: number }>();
  private cachePrefix = 'face_render_';
  private defaultRenderCacheTTL = 3600000; // 1 час TTL для кэша рендера
  
  /**
   * Рендерит компонент из Face
   */
  async renderFromFace(
    face: ComponentFace,
    props: Record<string, any> = {}
  ): Promise<FaceRenderResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    
    try {
      // Валидация Face
      const faceValidation = this.validator.validateFace(face);
      if (!faceValidation.valid) {
        errors.push(...faceValidation.errors.map(e => e.message));
        return this.createErrorResult(errors, warnings, startTime);
      }
      
      // Валидация пропсов
      const propsValidation = this.validator.validateProps(face, props);
      if (!propsValidation.valid) {
        errors.push(...propsValidation.errors.map(e => e.message));
        return this.createErrorResult(errors, warnings, startTime);
      }
      
      warnings.push(...propsValidation.warnings.map(w => w.message));
      
      // Проверяем кэш согласно стратегии
      const strategy = this.getCacheStrategy(face);
      const cacheKey = this.makeCacheKey(face, props);
      const cached = await this.getFromCache(strategy, cacheKey);
      if (cached) {
        return {
          success: true,
          html: cached.html,
          css: cached.css,
          errors,
          warnings,
          performance: {
            renderTime: Date.now() - startTime,
            memoryUsage: this.estimateMemoryUsage(face),
            cacheHit: true
          }
        };
      }
      
      // Генерация кода компонента
      let componentCode: string;
      switch (face.framework) {
        case 'react':
          componentCode = this.codeGenerator.generateReactComponent(face, props);
          break;
        case 'vue':
          componentCode = this.codeGenerator.generateVueComponent(face, props);
          break;
        case 'svelte':
          componentCode = this.codeGenerator.generateSvelteComponent(face, props);
          break;
        default:
          errors.push(`Неподдерживаемый фреймворк: ${face.framework}`);
          return this.createErrorResult(errors, warnings, startTime);
      }
      
      // Компиляция стилей
      const compiledStyles = await this.styleCompiler.compileStyles(face.styles, face.name);
      
      // Создание HTML для рендеринга
      const html = this.createRenderHTML(componentCode, compiledStyles, face);
      
      // Сохраняем в кэш по стратегии
      await this.setToCache(strategy, cacheKey, { html, css: compiledStyles });
      
      return {
        success: true,
        html,
        css: compiledStyles,
        errors,
        warnings,
        performance: {
          renderTime: Date.now() - startTime,
          memoryUsage: this.estimateMemoryUsage(face),
          cacheHit: false
        }
      };
      
    } catch (error) {
      errors.push(`Ошибка рендеринга: ${error}`);
      return this.createErrorResult(errors, warnings, startTime);
    }
  }
  
  /**
   * Валидирует Face
   */
  async validateFace(face: ComponentFace): Promise<FaceValidationResult> {
    return this.validator.validateFace(face);
  }
  
  private createRenderHTML(
    componentCode: string,
    styles: string,
    face: ComponentFace
  ): string {
    const frameworkScripts = this.getFrameworkScripts(face.framework);
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${face.displayName || face.name}</title>
  <style>
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
    }
    ${styles}
  </style>
  ${frameworkScripts}
</head>
<body>
  <div id="app"></div>
  
  <script type="module">
    ${this.wrapComponentForRendering(componentCode, face)}
  </script>
</body>
</html>
    `.trim();
  }
  
  private getFrameworkScripts(framework: FrameworkType): string {
    switch (framework) {
      case 'react':
        return `
  <script crossorigin src="${FRAMEWORK_CDN.REACT_DEV}"></script>
  <script crossorigin src="${FRAMEWORK_CDN.REACT_DOM_DEV}"></script>
  <script src="${FRAMEWORK_CDN.BABEL_STANDALONE}"></script>
        `;
      case 'vue':
        return `
  <script src="${FRAMEWORK_CDN.VUE_GLOBAL}"></script>
        `;
      case 'svelte':
        return `
  <!-- Svelte runtime будет включен в компилированный код -->
        `;
      default:
        return '';
    }
  }
  
  private wrapComponentForRendering(componentCode: string, face: ComponentFace): string {
    switch (face.framework) {
      case 'react':
        return `
    const { createElement, StrictMode } = React;
    const { createRoot } = ReactDOM;
    
    ${componentCode}
    
    const root = createRoot(document.getElementById('app'));
    root.render(createElement(StrictMode, null, createElement(${face.name})));
        `;
      case 'vue':
        return `
    const { createApp } = Vue;
    
    ${componentCode}
    
    createApp(${face.name}).mount('#app');
        `;
      case 'svelte':
        return `
    ${componentCode}
    
    new ${face.name}({
      target: document.getElementById('app')
    });
        `;
      default:
        return componentCode;
    }
  }
  
  private estimateMemoryUsage(face: ComponentFace): number {
    // Простая оценка использования памяти
    const baseSize = 1024; // 1KB базовый размер
    const propsSize = face.props.length * 100;
    const stylesSize = face.styles.reduce((total, style) => total + (style.source?.length || 0), 0);
    const depsSize = face.dependencies.length * 50;
    
    return baseSize + propsSize + stylesSize + depsSize;
  }
  
  private createErrorResult(
    errors: string[],
    warnings: string[],
    startTime: number
  ): FaceRenderResult {
    return {
      success: false,
      errors,
      warnings,
      performance: {
        renderTime: Date.now() - startTime,
        memoryUsage: 0,
        cacheHit: false
      }
    };
  }
  
  // === Кэширование рендеров ===
  private getCacheStrategy(face: ComponentFace): 'memory' | 'disk' | 'none' {
    return face.renderConfig?.performance?.cacheStrategy || 'memory';
  }
  
  private makeCacheKey(face: ComponentFace, props: Record<string, any>): string {
    const base = `${face.id || face.name}|${face.metadata?.hash || 'nohash'}`;
    const propsHash = this.simpleHash(JSON.stringify(props || {}));
    return `${base}|${propsHash}`;
  }
  
  private async getFromCache(strategy: 'memory' | 'disk' | 'none', key: string): Promise<{ html: string; css: string } | null> {
    if (strategy === 'none') return null;
    if (strategy === 'memory') {
      const entry = this.renderCache.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        this.renderCache.delete(key);
        return null;
      }
      return { html: entry.html, css: entry.css };
    }
    // disk
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.cachePrefix + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.html && parsed.css) {
          return { html: parsed.html, css: parsed.css };
        }
      }
    } catch {
      // ignore storage errors
    }
    return null;
  }
  
  private async setToCache(strategy: 'memory' | 'disk' | 'none', key: string, value: { html: string; css: string }): Promise<void> {
    if (strategy === 'none') return;
    const expiresAt = Date.now() + this.defaultRenderCacheTTL;
    if (strategy === 'memory') {
      this.renderCache.set(key, { ...value, createdAt: Date.now(), expiresAt });
      this.cleanupRenderCacheIfNeeded();
      return;
    }
    // disk
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.cachePrefix + key, JSON.stringify({ ...value, createdAt: Date.now(), expiresAt }));
        await this.enforceDiskCacheLimit();
      } else {
        // Фоллбэк в память, если нет localStorage
        this.renderCache.set(key, { ...value, createdAt: Date.now(), expiresAt });
        this.cleanupRenderCacheIfNeeded();
      }
    } catch {
      // Если не получилось записать в localStorage, сохраняем в память
      this.renderCache.set(key, { ...value, createdAt: Date.now(), expiresAt });
      this.cleanupRenderCacheIfNeeded();
    }
  }
  
  private cleanupRenderCacheIfNeeded(): void {
    const maxEntries = 100;
    if (this.renderCache.size <= maxEntries) return;
    const entries = Array.from(this.renderCache.entries());
    // Удаляем самые старые 30%
    entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
    const toDelete = entries.slice(0, Math.floor(entries.length * 0.3));
    for (const [k] of toDelete) this.renderCache.delete(k);
  }

  private async enforceDiskCacheLimit(): Promise<void> {
    try {
      if (typeof localStorage === 'undefined') return;
      const maxEntries = 200; // лимит записей в дисковом кэше
      const keys: { key: string; createdAt: number; expiresAt?: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(this.cachePrefix)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as { createdAt?: number; expiresAt?: number };
          const createdAt = typeof parsed?.createdAt === 'number' ? parsed.createdAt : 0;
          keys.push({ key: k, createdAt, expiresAt: parsed?.expiresAt });
        } catch {
          // Непарсируемые — удаляем
          localStorage.removeItem(k);
        }
      }

      // Удаляем истекшие
      const now = Date.now();
      for (const item of keys) {
        if (item.expiresAt && now > item.expiresAt) {
          localStorage.removeItem(item.key);
        }
      }

      // Применяем лимит по количеству
      const refreshedKeys: { key: string; createdAt: number }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.cachePrefix)) {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as { createdAt?: number };
            refreshedKeys.push({ key: k, createdAt: parsed?.createdAt || 0 });
          } catch {
            localStorage.removeItem(k);
          }
        }
      }

      if (refreshedKeys.length > maxEntries) {
        refreshedKeys.sort((a, b) => a.createdAt - b.createdAt); // старые первыми
        const toRemove = refreshedKeys.slice(0, refreshedKeys.length - maxEntries);
        for (const r of toRemove) localStorage.removeItem(r.key);
      }
    } catch {
      // игнорируем ошибки доступа к localStorage
    }
  }
  
  private simpleHash(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const chr = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }
  
  private scopeCSS(css: string, componentName: string): string {
    const scopeClass = `.${componentName.toLowerCase()}`;
    
    // Простое добавление scope к селекторам
    return css.replace(/([^{}]+){/g, (match, selector) => {
      const trimmedSelector = selector.trim();
      if (trimmedSelector.startsWith('@') || trimmedSelector.includes('keyframes')) {
        return match; // Не изменяем at-rules
      }
      return `${scopeClass} ${trimmedSelector} {`;
    });
  }
  
  private compileCSSModules(css: string, componentName: string): string {
    // Простая эмуляция CSS Modules
    const modulePrefix = componentName.toLowerCase();
    
    return css.replace(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g, (match, className) => {
      return `.${modulePrefix}_${className}_${this.generateHash(className)}`;
    });
  }
  
  private compileStyledComponents(css: string, componentName: string): string {
    // Простая компиляция styled-components
    const styledClass = `.${componentName.toLowerCase()}-styled`;
    
    return `${styledClass} {
${css}
}`;
  }
  
  private generateHash(input: string): string {
    // Простой hash для CSS Modules
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).substr(0, 6);
  }
}
