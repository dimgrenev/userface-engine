/**
 * Типы для системы JSON-спецификаций компонентов (Faces)
 * Обеспечивает универсальное описание компонентов любых фреймворков
 */

export type FrameworkType = 'react' | 'vue' | 'svelte' | 'angular' | 'unknown';
export type PropType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'function' | 'node' | 'element' | 'any';
export type StyleType = 'css' | 'scss' | 'sass' | 'less' | 'styled-components' | 'css-modules' | 'emotion';

/**
 * Определение пропса компонента
 */
export interface PropDefinition {
  name: string;
  type: PropType;
  required: boolean;
  defaultValue?: any;
  description?: string;
  examples?: any[];
  validation?: {
    min?: number;
    max?: number;
    pattern?: string;
    enum?: any[];
    custom?: string; // Custom validation function as string
  };
  // Для сложных типов
  children?: PropDefinition[]; // Для object/array
  unionTypes?: PropType[]; // Для union types
  genericType?: string; // Для generic types
}

/**
 * Определение стилей компонента
 */
export interface StyleDefinition {
  type: StyleType;
  source: string; // Исходный код стилей
  compiled?: string; // Скомпилированный CSS
  variables?: Record<string, any>; // CSS переменные
  classes?: string[]; // Доступные CSS классы
  dependencies?: string[]; // Зависимости стилей
  scoped?: boolean; // Изолированные стили
  media?: string[]; // Media queries
}

/**
 * Определение зависимости
 */
export interface DependencyDefinition {
  name: string;
  version: string;
  type: 'npm' | 'local' | 'cdn' | 'builtin';
  source?: string; // Для local зависимостей
  url?: string; // Для CDN
  optional?: boolean;
  devDependency?: boolean;
}

/**
 * Определение слота (для Vue/Svelte)
 */
export interface SlotDefinition {
  name: string;
  required: boolean;
  description?: string;
  props?: PropDefinition[]; // Scoped slots
}

/**
 * Определение события
 */
export interface EventDefinition {
  name: string;
  description?: string;
  payload?: PropDefinition; // Тип payload события
  examples?: any[];
}

/**
 * Определение метода/функции компонента
 */
export interface MethodDefinition {
  name: string;
  description?: string;
  parameters?: PropDefinition[];
  returnType?: PropType;
  examples?: string[];
}

/**
 * Метаданные компонента
 */
export interface ComponentMetadata {
  createdAt: string;
  updatedAt: string;
  version: string;
  hash: string; // Hash исходных файлов
  sourceFiles: string[]; // Пути к исходным файлам
  author?: string;
  license?: string;
  repository?: string;
  tags?: string[];
  category?: string;
  complexity?: 'simple' | 'medium' | 'complex';
  size?: {
    lines: number;
    bytes: number;
    dependencies: number;
  };
}

/**
 * Основная структура Face (JSON-спецификация компонента)
 */
export interface ComponentFace {
  // Основная информация
  id: string; // Уникальный идентификатор
  name: string; // Имя компонента
  displayName?: string; // Отображаемое имя
  description?: string;
  
  // Техническая информация
  framework: FrameworkType;
  version: string; // Версия Face схемы
  
  // Определения
  props: PropDefinition[];
  styles: StyleDefinition[];
  dependencies: DependencyDefinition[];
  // Снимок схемы для рантайм-валидации (сериализуемый)
  schema?: {
    kind: 'zod-like';
    props: Array<{
      name: string;
      type: PropType | string;
      required: boolean;
      defaultValue?: any;
      options?: any[];
    }>
  };
  
  // Фреймворк-специфичные определения
  slots?: SlotDefinition[]; // Vue/Svelte
  events?: EventDefinition[]; // Vue/Svelte
  methods?: MethodDefinition[]; // Публичные методы
  
  // Конфигурация рендеринга
  renderConfig: {
    wrapper?: string; // HTML wrapper
    isolateStyles?: boolean;
    sandbox?: {
      permissions: string[];
      restrictions: string[];
    };
    performance?: {
      lazy?: boolean;
      preload?: boolean;
      cacheStrategy?: 'memory' | 'disk' | 'none';
    };
  };
  
  // Примеры использования
  examples?: ComponentExample[];

  // Именованные состояния компонента (ручные + авто-генерированные)
  states?: Record<string, Record<string, any>>;
  
  // Метаданные
  metadata: ComponentMetadata;
}

/**
 * Пример использования компонента
 */
export interface ComponentExample {
  name: string;
  description?: string;
  props: Record<string, any>;
  code?: string; // Код примера
  preview?: string; // URL превью или base64 изображения
}

/**
 * Результат генерации Face
 */
export interface FaceGenerationResult {
  success: boolean;
  face?: ComponentFace;
  errors: string[];
  warnings: string[];
  stats: {
    processingTime: number;
    filesAnalyzed: number;
    propsDetected: number;
    stylesProcessed: number;
  };
}

/**
 * Результат валидации Face
 */
export interface FaceValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  score: number; // 0-100, качество Face
}

export interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}

/**
 * Результат рендеринга из Face
 */
export interface FaceRenderResult {
  success: boolean;
  html?: string;
  css?: string;
  errors: string[];
  warnings: string[];
  performance: {
    renderTime: number;
    memoryUsage: number;
    cacheHit: boolean;
  };
}

/**
 * Пакет Face для экспорта/импорта
 */
export interface FacesBundle {
  version: string;
  createdAt: string;
  faces: ComponentFace[];
  dependencies: DependencyDefinition[];
  metadata: {
    totalSize: number;
    compression: string;
    checksum: string;
  };
}

/**
 * Результат импорта Face
 */
export interface FaceImportResult {
  success: boolean;
  imported: string[]; // IDs импортированных Face
  skipped: string[]; // IDs пропущенных Face
  errors: string[];
  conflicts: {
    id: string;
    reason: string;
    resolution: 'skip' | 'overwrite' | 'rename';
  }[];
}

/**
 * Конфигурация генератора Face
 */
export interface FaceGeneratorConfig {
  // Анализ пропсов
  propAnalysis: {
    includePrivate: boolean;
    inferTypes: boolean;
    extractExamples: boolean;
    analyzeValidation: boolean;
  };
  
  // Обработка стилей
  styleProcessing: {
    compileScss: boolean;
    extractVariables: boolean;
    optimizeCss: boolean;
    generateClasses: boolean;
  };
  
  // Анализ зависимостей
  dependencyAnalysis: {
    includeDevDeps: boolean;
    resolveVersions: boolean;
    checkCompatibility: boolean;
  };
  
  // Генерация примеров
  exampleGeneration: {
    generateBasic: boolean;
    generateAdvanced: boolean;
    includeEdgeCases: boolean;
    maxExamples: number;
  };
  
  // Оптимизация
  optimization: {
    minifyOutput: boolean;
    removeComments: boolean;
    compressMetadata: boolean;
  };
}

/**
 * Кэш для Face
 */
export interface FaceCache {
  get(key: string): Promise<ComponentFace | null>;
  set(key: string, face: ComponentFace, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  size(): Promise<number>;
}

/**
 * События системы Face
 */
export interface FaceSystemEvents {
  'face:generated': { face: ComponentFace; stats: any };
  'face:validated': { face: ComponentFace; result: FaceValidationResult };
  'face:rendered': { face: ComponentFace; result: FaceRenderResult };
  'face:cached': { key: string; face: ComponentFace };
  'face:error': { error: Error; context: any };
}

/**
 * Интерфейс для работы с Face системой
 */
export interface IFaceSystem {
  // Генерация
  generateFace(files: any[], config?: Partial<FaceGeneratorConfig>): Promise<FaceGenerationResult>;
  
  // Валидация
  validateFace(face: ComponentFace): Promise<FaceValidationResult>;
  
  // Рендеринг
  renderFromFace(face: ComponentFace, props: Record<string, any>): Promise<FaceRenderResult>;
  
  // Управление
  saveFace(face: ComponentFace): Promise<void>;
  loadFace(id: string): Promise<ComponentFace | null>;
  deleteFace(id: string): Promise<void>;
  listFaces(): Promise<ComponentFace[]>;
  
  // Экспорт/Импорт
  exportFaces(ids: string[]): Promise<FacesBundle>;
  importFaces(bundle: FacesBundle): Promise<FaceImportResult>;
  
  // События
  on<K extends keyof FaceSystemEvents>(event: K, listener: (data: FaceSystemEvents[K]) => void): void;
  off<K extends keyof FaceSystemEvents>(event: K, listener: (data: FaceSystemEvents[K]) => void): void;
}