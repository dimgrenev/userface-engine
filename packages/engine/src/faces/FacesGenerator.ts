/**
 * Генератор JSON-спецификаций компонентов (Faces)
 * Автоматически анализирует компоненты и создает универсальные описания
 */

import {
  ComponentFace,
  FaceGenerationResult,
  FaceGeneratorConfig,
  PropDefinition,
  StyleDefinition,
  DependencyDefinition,
  ComponentExample,
  FrameworkType,
  PropType,
  StyleType
} from './types';
import { VFSEntry } from '../core-engine';

// Тип для отдельного файла
interface FileEntry {
  name: string;
  content: string;
  path?: string; // Добавляем path для совместимости
}

/**
 * Анализатор TypeScript/JavaScript кода
 */
class CodeAnalyzer {
  /**
   * Извлекает определения пропсов из TypeScript интерфейса
   */
  extractPropsFromInterface(code: string): PropDefinition[] {
    const props: PropDefinition[] = [];
    
    // Регулярные выражения для анализа TypeScript
    const interfaceRegex = /interface\s+(\w+Props)\s*{([^}]+)}/g;
    const propRegex = /(\w+)(\?)?:\s*([^;\n]+);?/g;
    
    let interfaceMatch;
    while ((interfaceMatch = interfaceRegex.exec(code)) !== null) {
      const interfaceBody = interfaceMatch[2];
      
      let propMatch;
      while ((propMatch = propRegex.exec(interfaceBody)) !== null) {
        const [, name, optional, type] = propMatch;
        
        props.push({
          name: name.trim(),
          type: this.mapTypeScriptType(type.trim()),
          required: !optional,
          description: this.extractJSDocComment(code, name)
        });
      }
    }
    
    return props;
  }
  
  /**
   * Извлекает пропсы из React.FC или компонента
   */
  extractPropsFromComponent(code: string): PropDefinition[] {
    const props: PropDefinition[] = [];
    
    // Анализ деструктуризации пропсов
    const destructuringRegex = /const\s+\w+[^=]*=\s*\([^)]*{([^}]+)}[^)]*\)/g;
    const propRegex = /(\w+)(?:\s*=\s*([^,}]+))?/g;
    
    let match;
    while ((match = destructuringRegex.exec(code)) !== null) {
      const propsBody = match[1];
      
      let propMatch;
      while ((propMatch = propRegex.exec(propsBody)) !== null) {
        const [, name, defaultValue] = propMatch;
        
        props.push({
          name: name.trim(),
          type: this.inferTypeFromUsage(code, name.trim()),
          required: !defaultValue,
          defaultValue: defaultValue ? this.parseDefaultValue(defaultValue.trim()) : undefined
        });
      }
    }
    
    return props;
  }
  
  /**
   * Анализирует Vue компонент
   */
  extractPropsFromVue(code: string): PropDefinition[] {
    const props: PropDefinition[] = [];
    
    // Vue 3 Composition API
    const definePropsRegex = /defineProps<([^>]+)>/g;
    const propsObjectRegex = /props:\s*{([^}]+)}/g;
    
    // Анализ defineProps
    let match;
    while ((match = definePropsRegex.exec(code)) !== null) {
      const propsType = match[1];
      props.push(...this.parseVuePropsType(propsType));
    }
    
    // Анализ объекта props
    while ((match = propsObjectRegex.exec(code)) !== null) {
      const propsObject = match[1];
      props.push(...this.parseVuePropsObject(propsObject));
    }
    
    return props;
  }
  
  /**
   * Анализирует Svelte компонент
   */
  extractPropsFromSvelte(code: string): PropDefinition[] {
    const props: PropDefinition[] = [];
    
    // Svelte export let
    const exportRegex = /export\s+let\s+(\w+)(?:\s*=\s*([^;\n]+))?/g;
    
    let match;
    while ((match = exportRegex.exec(code)) !== null) {
      const [, name, defaultValue] = match;
      
      props.push({
        name: name.trim(),
        type: this.inferTypeFromUsage(code, name.trim()),
        required: !defaultValue,
        defaultValue: defaultValue ? this.parseDefaultValue(defaultValue.trim()) : undefined
      });
    }
    
    return props;
  }
  
  private mapTypeScriptType(tsType: string): PropType {
    const type = tsType.toLowerCase().trim();
    
    if (type.includes('string')) return 'string';
    if (type.includes('number')) return 'number';
    if (type.includes('boolean')) return 'boolean';
    if (type.includes('function') || type.includes('=>')) return 'function';
    if (type.includes('react.reactnode') || type.includes('reactnode')) return 'node';
    if (type.includes('react.reactelement') || type.includes('reactelement')) return 'element';
    if (type.includes('[]') || type.includes('array')) return 'array';
    if (type.includes('{') || type.includes('object')) return 'object';
    
    return 'any';
  }
  
  private inferTypeFromUsage(code: string, propName: string): PropType {
    // Простая эвристика для определения типа по использованию
    const usageRegex = new RegExp(`${propName}\\s*[.\\[]`, 'g');
    
    if (code.includes(`${propName}.length`)) return 'array';
    if (code.includes(`${propName}.map`)) return 'array';
    if (code.includes(`${propName}.toString()`)) return 'string';
    if (code.includes(`${propName} +`) || code.includes(`+ ${propName}`)) return 'number';
    if (code.includes(`${propName} &&`) || code.includes(`!${propName}`)) return 'boolean';
    if (code.includes(`${propName}(`)) return 'function';
    
    return 'any';
  }
  
  private parseDefaultValue(value: string): any {
    try {
      // Попытка парсинга как JSON
      return JSON.parse(value);
    } catch {
      // Если не JSON, возвращаем как строку
      return value.replace(/["']/g, '');
    }
  }
  
  private extractJSDocComment(code: string, propName: string): string | undefined {
    const commentRegex = new RegExp(`\/\*\*([^*]|\*(?!\/))*\*\/\s*${propName}`, 'g');
    const match = commentRegex.exec(code);
    
    if (match) {
      return match[0]
        .replace(/\/\*\*|\*\//g, '')
        .replace(/\*\s*/g, '')
        .trim();
    }
    
    return undefined;
  }
  
  private parseVuePropsType(propsType: string): PropDefinition[] {
    // Упрощенный парсер для Vue props типов
    const props: PropDefinition[] = [];
    const propRegex = /(\w+)(\?)?:\s*([^;,}]+)/g;
    
    let match;
    while ((match = propRegex.exec(propsType)) !== null) {
      const [, name, optional, type] = match;
      
      props.push({
        name: name.trim(),
        type: this.mapTypeScriptType(type.trim()),
        required: !optional
      });
    }
    
    return props;
  }
  
  private parseVuePropsObject(propsObject: string): PropDefinition[] {
    // Парсер для Vue props объекта
    const props: PropDefinition[] = [];
    // Упрощенная реализация
    return props;
  }
}

/**
 * Анализатор стилей
 */
class StyleAnalyzer {
  /**
   * Анализирует CSS/SCSS файлы
   */
  analyzeStyleFile(content: string, filename: string): StyleDefinition {
    const extension = filename.split('.').pop()?.toLowerCase();
    
    return {
      type: this.getStyleType(extension || 'css'),
      source: content,
      variables: this.extractCSSVariables(content),
      classes: this.extractCSSClasses(content),
      scoped: filename.includes('.module.') || content.includes(':local')
    };
  }
  
  /**
   * Анализирует styled-components
   */
  analyzeStyledComponents(code: string): StyleDefinition[] {
    const styles: StyleDefinition[] = [];
    
    // Поиск styled-components
    const styledRegex = /const\s+(\w+)\s*=\s*styled\.[\w.]+`([^`]+)`/g;
    
    let match;
    while ((match = styledRegex.exec(code)) !== null) {
      const [, componentName, styles_content] = match;
      
      styles.push({
        type: 'styled-components',
        source: styles_content,
        variables: this.extractCSSVariables(styles_content),
        classes: [componentName]
      });
    }
    
    return styles;
  }
  
  private getStyleType(extension: string): StyleType {
    switch (extension) {
      case 'scss': return 'scss';
      case 'sass': return 'sass';
      case 'less': return 'less';
      default: return 'css';
    }
  }
  
  private extractCSSVariables(content: string): Record<string, any> {
    const variables: Record<string, any> = {};
    const varRegex = /--([\w-]+):\s*([^;\n]+)/g;
    
    let match;
    while ((match = varRegex.exec(content)) !== null) {
      const [, name, value] = match;
      variables[name] = value.trim();
    }
    
    return variables;
  }
  
  private extractCSSClasses(content: string): string[] {
    const classes: string[] = [];
    const classRegex = /\.([\w-]+)\s*{/g;
    
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      classes.push(match[1]);
    }
    
    return [...new Set(classes)];
  }
}

/**
 * Анализатор зависимостей
 */
class DependencyAnalyzer {
  /**
   * Анализирует импорты в файле
   */
  analyzeImports(code: string): DependencyDefinition[] {
    const dependencies: DependencyDefinition[] = [];
    
    // ES6 импорты
    const importRegex = /import\s+[^'"]*['"]([^'"]+)['"]/g;
    
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const importPath = match[1];
      
      if (!importPath.startsWith('.')) {
        // Внешняя зависимость
        dependencies.push({
          name: importPath.split('/')[0],
          version: '*',
          type: 'npm'
        });
      } else {
        // Локальная зависимость
        dependencies.push({
          name: importPath,
          version: '*',
          type: 'local',
          source: importPath
        });
      }
    }
    
    return dependencies;
  }
  
  /**
   * Анализирует package.json
   */
  analyzePackageJson(packageJson: any): DependencyDefinition[] {
    const dependencies: DependencyDefinition[] = [];
    
    // Обычные зависимости
    if (packageJson.dependencies) {
      for (const [name, version] of Object.entries(packageJson.dependencies)) {
        dependencies.push({
          name,
          version: version as string,
          type: 'npm'
        });
      }
    }
    
    // Dev зависимости
    if (packageJson.devDependencies) {
      for (const [name, version] of Object.entries(packageJson.devDependencies)) {
        dependencies.push({
          name,
          version: version as string,
          type: 'npm',
          devDependency: true
        });
      }
    }
    
    return dependencies;
  }
}

/**
 * Основной генератор Face
 */
export class FacesGenerator {
  private codeAnalyzer = new CodeAnalyzer();
  private styleAnalyzer = new StyleAnalyzer();
  private dependencyAnalyzer = new DependencyAnalyzer();
  private config?: Partial<FaceGeneratorConfig>;

  constructor(config?: Partial<FaceGeneratorConfig>) {
    this.config = config;
  }
  
  /**
   * Генерирует Face из файлов компонента
   */
  async generateFace(
    files: FileEntry[],
    config: Partial<FaceGeneratorConfig> = {}
  ): Promise<FaceGenerationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];
    
    try {
      // Определяем основной файл компонента
      const mainFile = this.findMainComponentFile(files);
      if (!mainFile) {
        errors.push('Не найден основной файл компонента');
        return this.createErrorResult(errors, warnings, startTime, files.length);
      }
      
      // Определяем фреймворк
      const framework = this.detectFramework(mainFile, files);
      
      // Анализируем компонент
      const componentName = this.extractComponentName(mainFile);
      const props = await this.analyzeProps(mainFile, framework, config);
      const styles = await this.analyzeStyles(files, config);
      const dependencies = await this.analyzeDependencies(files, config);
      const examples = await this.generateExamples(props, config);
      
      // Создаем Face
      const face: ComponentFace = {
        id: this.generateId(componentName, framework),
        name: componentName,
        framework,
        version: '1.0.0',
        props,
        styles,
        dependencies,
        examples,
        // Вкладываем сериализуемый snapshot схемы для валидации на рантайме
        // (PropsEditor и валидатор смогут регистрировать её напрямую)
        // Не расширяем типы здесь, оставляем как часть структуры при экспорте в JSON
        // @ts-ignore – поле будет сохранено в JSON face файла
        schema: { kind: 'zod-like', props: props.map(p => ({
          name: p.name,
          type: p.type,
          required: p.required,
          defaultValue: p.defaultValue,
          options: p.validation?.enum
        })) },
        renderConfig: {
          isolateStyles: true,
          sandbox: {
            permissions: ['scripts'],
            restrictions: ['network']
          },
          performance: {
            lazy: false,
            preload: true,
            cacheStrategy: 'memory'
          }
        },
        metadata: {
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: '1.0.0',
          hash: this.calculateHash(files),
          sourceFiles: files.map(f => f.path || f.name),
          complexity: this.calculateComplexity(props, styles, dependencies),
          size: {
            lines: this.countLines(files),
            bytes: this.countBytes(files),
            dependencies: dependencies.length
          }
        }
      };
      
      return {
        success: true,
        face,
        errors,
        warnings,
        stats: {
          processingTime: Date.now() - startTime,
          filesAnalyzed: files.length,
          propsDetected: props.length,
          stylesProcessed: styles.length
        }
      };
      
    } catch (error) {
      errors.push(`Ошибка генерации Face: ${error}`);
      return this.createErrorResult(errors, warnings, startTime, files.length);
    }
  }
  
  private findMainComponentFile(files: FileEntry[]): FileEntry | null {
    // Ищем основной файл компонента
    const componentFiles = files.filter(f => 
      /\.(tsx?|vue|svelte)$/.test(f.path || f.name) && 
      !(f.path || f.name).includes('.test.') &&
      !(f.path || f.name).includes('.spec.')
    );
    
    // Приоритет: index файлы, затем файлы с именем папки
    const indexFile = componentFiles.find(f => (f.path || f.name).includes('index.'));
    if (indexFile) return indexFile;
    
    // Возвращаем первый найденный файл компонента
    return componentFiles[0] || null;
  }
  
  private detectFramework(mainFile: FileEntry, files: FileEntry[]): FrameworkType {
    const extension = (mainFile.path || mainFile.name).split('.').pop()?.toLowerCase();
    const content = mainFile.content || '';
    
    if (extension === 'vue') return 'vue';
    if (extension === 'svelte') return 'svelte';
    
    // Проверяем содержимое для React
    if (content.includes('import React') || 
        content.includes('from "react"') ||
        content.includes('jsx') ||
        extension === 'tsx') {
      return 'react';
    }
    
    // Проверяем package.json
    const packageFile = files.find(f => (f.path || f.name).endsWith('package.json'));
    if (packageFile) {
      try {
        const pkg = JSON.parse(packageFile.content || '{}');
        if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'react';
        if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return 'vue';
        if (pkg.dependencies?.svelte || pkg.devDependencies?.svelte) return 'svelte';
      } catch {}
    }
    
    return 'unknown';
  }
  
  private extractComponentName(file: FileEntry): string {
    const filename = (file.path || file.name).split('/').pop() || '';
    const name = filename.split('.')[0];
    
    // Если это index файл, берем имя папки
    if (name === 'index') {
      const parts = (file.path || file.name).split('/');
      return parts[parts.length - 2] || 'Component';
    }
    
    return name;
  }
  
  private async analyzeProps(
    file: FileEntry,
    framework: FrameworkType,
    config: Partial<FaceGeneratorConfig>
  ): Promise<PropDefinition[]> {
    const content = file.content || '';
    
    switch (framework) {
      case 'react':
        return [
          ...this.codeAnalyzer.extractPropsFromInterface(content),
          ...this.codeAnalyzer.extractPropsFromComponent(content)
        ];
      case 'vue':
        return this.codeAnalyzer.extractPropsFromVue(content);
      case 'svelte':
        return this.codeAnalyzer.extractPropsFromSvelte(content);
      default:
        return [];
    }
  }
  
  private async analyzeStyles(
    files: FileEntry[],
    config: Partial<FaceGeneratorConfig>
  ): Promise<StyleDefinition[]> {
    const styles: StyleDefinition[] = [];
    
    // Анализируем файлы стилей
    const styleFiles = files.filter(f => 
      /\.(css|scss|sass|less)$/.test(f.path || f.name)
    );
    
    for (const file of styleFiles) {
      styles.push(this.styleAnalyzer.analyzeStyleFile(file.content || '', file.path || file.name));
    }
    
    // Анализируем styled-components в JS/TS файлах
    const codeFiles = files.filter(f => 
      /\.(js|jsx|ts|tsx)$/.test(f.path || f.name)
    );
    
    for (const file of codeFiles) {
      const styledComponents = this.styleAnalyzer.analyzeStyledComponents(file.content || '');
      styles.push(...styledComponents);
    }
    
    return styles;
  }
  
  private async analyzeDependencies(
    files: FileEntry[],
    config: Partial<FaceGeneratorConfig>
  ): Promise<DependencyDefinition[]> {
    const dependencies: DependencyDefinition[] = [];
    
    // Анализируем package.json
    const packageFile = files.find(f => (f.path || f.name).endsWith('package.json'));
    if (packageFile) {
      try {
        const pkg = JSON.parse(packageFile.content || '{}');
        dependencies.push(...this.dependencyAnalyzer.analyzePackageJson(pkg));
      } catch {}
    }
    
    // Анализируем импорты в файлах
    const codeFiles = files.filter(f => 
      /\.(js|jsx|ts|tsx|vue|svelte)$/.test(f.path || f.name)
    );
    
    for (const file of codeFiles) {
      const imports = this.dependencyAnalyzer.analyzeImports(file.content || '');
      dependencies.push(...imports);
    }
    
    // Удаляем дубликаты
    return this.deduplicateDependencies(dependencies);
  }
  
  private async generateExamples(
    props: PropDefinition[],
    config: Partial<FaceGeneratorConfig>
  ): Promise<ComponentExample[]> {
    const examples: ComponentExample[] = [];
    
    if (config.exampleGeneration?.generateBasic !== false) {
      // Базовый пример
      const basicProps: Record<string, any> = {};
      
      for (const prop of props) {
        if (prop.required) {
          basicProps[prop.name] = this.generateExampleValue(prop);
        }
      }
      
      examples.push({
        name: 'Базовый пример',
        description: 'Пример с минимальными обязательными пропсами',
        props: basicProps
      });
    }
    
    return examples;
  }
  
  private generateExampleValue(prop: PropDefinition): any {
    if (prop.defaultValue !== undefined) {
      return prop.defaultValue;
    }
    
    switch (prop.type) {
      case 'string': return 'Пример текста';
      case 'number': return 42;
      case 'boolean': return true;
      case 'array': return [];
      case 'object': return {};
      case 'function': return '() => {}';
      default: return null;
    }
  }
  
  private generateId(name: string, framework: FrameworkType): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    return `${framework}-${name.toLowerCase()}-${timestamp}-${random}`;
  }
  
  private calculateHash(files: FileEntry[]): string {
    const content = files.map(f => f.content || '').join('');
    // Простой hash (в реальности лучше использовать crypto)
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }
  
  private calculateComplexity(
    props: PropDefinition[],
    styles: StyleDefinition[],
    dependencies: DependencyDefinition[]
  ): 'simple' | 'medium' | 'complex' {
    const score = props.length + styles.length + dependencies.length;
    
    if (score <= 5) return 'simple';
    if (score <= 15) return 'medium';
    return 'complex';
  }
  
  private countLines(files: FileEntry[]): number {
    return files.reduce((total, file) => {
      return total + (file.content?.split('\n').length || 0);
    }, 0);
  }
  
  private countBytes(files: FileEntry[]): number {
    return files.reduce((total, file) => {
      return total + (file.content?.length || 0);
    }, 0);
  }
  
  private deduplicateDependencies(dependencies: DependencyDefinition[]): DependencyDefinition[] {
    const seen = new Set<string>();
    return dependencies.filter(dep => {
      const key = `${dep.name}-${dep.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  
  private createErrorResult(
    errors: string[],
    warnings: string[],
    startTime: number,
    filesCount: number
  ): FaceGenerationResult {
    return {
      success: false,
      errors,
      warnings,
      stats: {
        processingTime: Date.now() - startTime,
        filesAnalyzed: filesCount,
        propsDetected: 0,
        stylesProcessed: 0
      }
    };
  }
}