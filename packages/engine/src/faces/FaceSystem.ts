/**
 * Основная система Face - объединяет генерацию, рендеринг и управление JSON-спецификациями
 */

import {
  ComponentFace,
  FaceGenerationResult,
  FaceValidationResult,
  FaceRenderResult,
  FacesBundle,
  FaceImportResult,
  FaceGeneratorConfig,
  IFaceSystem,
  FaceSystemEvents
} from './types';
import { FacesGenerator } from './FacesGenerator';
import { FacesRenderer } from './FacesRenderer';
import { FacesManager } from './FacesManager';

/**
 * Интерфейс для файловой записи
 */
interface FileEntry {
  name: string;
  content: string;
  path?: string;
}

/**
 * Основная система Face
 */
export class FaceSystem implements IFaceSystem {
  private generator: FacesGenerator;
  private renderer: FacesRenderer;
  private manager: FacesManager;
  
  constructor(config: {
    generatorConfig?: FaceGeneratorConfig;
    useIndexedDB?: boolean;
  } = {}) {
    this.generator = new FacesGenerator(config.generatorConfig);
    this.renderer = new FacesRenderer();
    this.manager = new FacesManager({ useIndexedDB: config.useIndexedDB });
  }
  
  /**
   * Анализирует компонент и генерирует Face
   */
  async generateFace(files: FileEntry[], config?: Partial<FaceGeneratorConfig>): Promise<FaceGenerationResult> {
    try {
      const result = await this.generator.generateFace(files);
      
      if (result.success && result.face) {
        // Автоматически сохраняем сгенерированный Face
        await this.manager.saveFace(result.face);
      }
      
      return result;
    } catch (error) {
      return {
        success: false,
        face: undefined,
        errors: [`Ошибка генерации Face: ${error}`],
        warnings: [],
        stats: {
          processingTime: 0,
          filesAnalyzed: 0,
          propsDetected: 0,
          stylesProcessed: 0
        }
      };
    }
  }
  
  /**
   * Валидирует Face
   */
  async validateFace(face: ComponentFace): Promise<FaceValidationResult> {
    return this.renderer.validateFace(face);
  }
  
  /**
   * Рендерит компонент из Face
   */
  async renderFromFace(
    face: ComponentFace,
    props: Record<string, any>
  ): Promise<FaceRenderResult> {
    return this.renderer.renderFromFace(face, props);
  }
  
  /**
   * Загружает Face по ID и рендерит его
   */
  async renderById(
    faceId: string,
    props: Record<string, any> = {}
  ): Promise<FaceRenderResult> {
    const face = await this.manager.loadFace(faceId);
    
    if (!face) {
      return {
        success: false,
        html: '',
        css: '',
        errors: [`Face с ID ${faceId} не найден`],
        warnings: [],
        performance: {
          renderTime: 0,
          memoryUsage: 0,
          cacheHit: false
        }
      };
    }
    
    return this.renderFromFace(face, props);
  }
  
  /**
   * Анализирует компонент, генерирует Face и сразу рендерит его
   */
  async analyzeAndRender(
    files: FileEntry[],
    props: Record<string, any> = {},
    options?: {
      saveFace?: boolean;
    }
  ): Promise<{
    generation: FaceGenerationResult;
    render: FaceRenderResult;
  }> {
    // Генерируем Face
    const generation = await this.generateFace(files);
    
    let render: FaceRenderResult;
    
    if (generation.success && generation.face) {
      // Рендерим из Face
      render = await this.renderFromFace(generation.face, props);
      
      // Опционально сохраняем Face
      if (options?.saveFace !== false) {
        try {
          await this.manager.saveFace(generation.face);
        } catch (error) {
          console.warn('Не удалось сохранить Face:', error);
        }
      }
    } else {
      render = {
        success: false,
        html: '',
        css: '',
        errors: ['Не удалось сгенерировать Face для рендеринга'],
        warnings: [],
        performance: {
          renderTime: 0,
          memoryUsage: 0,
          cacheHit: false
        }
      };
    }
    
    return { generation, render };
  }
  
  /**
   * Получает Face по ID
   */
  async loadFace(id: string): Promise<ComponentFace | null> {
    return this.manager.loadFace(id);
  }
  
  /**
   * Получает Face по ID (алиас для loadFace)
   */
  async getFace(id: string): Promise<ComponentFace | null> {
    return this.loadFace(id);
  }
  
  /**
   * Сохраняет Face
   */
  async saveFace(face: ComponentFace): Promise<void> {
    return this.manager.saveFace(face);
  }
  
  /**
   * Удаляет Face
   */
  async deleteFace(id: string): Promise<void> {
    return this.manager.deleteFace(id);
  }
  
  /**
   * Получает список всех Face
   */
  async listFaces(): Promise<ComponentFace[]> {
    return this.manager.listFaces();
  }
  
  /**
   * Поиск Face
   */
  async searchFaces(query: {
    name?: string;
    framework?: string;
    tags?: string[];
  }): Promise<ComponentFace[]> {
    return this.manager.searchFaces(query);
  }
  
  /**
   * Экспортирует Face в пакет
   */
  async exportFaces(ids: string[]): Promise<FacesBundle> {
    return this.manager.exportFaces(ids);
  }
  
  /**
   * Импортирует Face из пакета
   */
  async importFaces(bundle: FacesBundle): Promise<FaceImportResult> {
    return this.manager.importFaces(bundle);
  }
  
  /**
   * Получает статистику системы
   */
  async getStatistics(): Promise<{
    faces: {
      total: number;
      byFramework: Record<string, number>;
      byComplexity: Record<string, number>;
      totalSize: number;
      cacheSize: number;
    };
  }> {
    const facesStats = await this.manager.getStatistics();
    
    return {
      faces: facesStats
    };
  }
  
  /**
   * Очищает все данные системы
   */
  async clearAll(): Promise<void> {
    await this.manager.clearAllFaces();
  }
  
  /**
   * Подписка на события системы
   */
  on<K extends keyof FaceSystemEvents>(
    event: K,
    listener: (data: FaceSystemEvents[K]) => void
  ): void {
    this.manager.on(event, listener);
  }
  
  /**
   * Отписка от событий системы
   */
  off<K extends keyof FaceSystemEvents>(
    event: K,
    listener: (data: FaceSystemEvents[K]) => void
  ): void {
    this.manager.off(event, listener);
  }
  
  /**
   * Создает Face из JSON
   */
  static fromJSON(json: string): ComponentFace {
    try {
      const data = JSON.parse(json);
      
      // Валидируем основные поля
      if (!data.id || !data.name || !data.framework) {
        throw new Error('Отсутствуют обязательные поля Face');
      }
      
      return data as ComponentFace;
    } catch (error) {
      throw new Error(`Ошибка парсинга Face JSON: ${error}`);
    }
  }
  
  /**
   * Конвертирует Face в JSON
   */
  static toJSON(face: ComponentFace, pretty = false): string {
    return JSON.stringify(face, null, pretty ? 2 : 0);
  }
  
  /**
   * Создает пустой Face с базовой структурой
   */
  static createEmpty(name: string, framework: 'react' | 'vue' | 'svelte'): ComponentFace {
    const now = new Date().toISOString();
    
    return {
      id: `face_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name,
      framework,
      version: '1.0.0',
      props: [],
      styles: [],
      dependencies: [],
      slots: [],
      events: [],
      methods: [],
      examples: [],
      renderConfig: {
        isolateStyles: true,
        sandbox: {
          permissions: [],
          restrictions: []
        },
        performance: {
          lazy: false,
          preload: false,
          cacheStrategy: 'memory'
        }
      },
      metadata: {
        createdAt: now,
        updatedAt: now,
        version: '1.0.0',
        hash: '',
        sourceFiles: [],
        author: '',
        tags: [],
        category: 'component',
        complexity: 'simple',
        size: {
          bytes: 0,
          lines: 0,
          dependencies: 0
        }
      }
    };
  }
  
  /**
   * Валидирует структуру Face
   */
  static validateStructure(face: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    // Проверяем обязательные поля
    const requiredFields = ['id', 'name', 'framework', 'version'];
    for (const field of requiredFields) {
      if (!face[field]) {
        errors.push(`Отсутствует обязательное поле: ${field}`);
      }
    }
    
    // Проверяем тип фреймворка
    if (face.framework && !['react', 'vue', 'svelte'].includes(face.framework)) {
      errors.push(`Неподдерживаемый фреймворк: ${face.framework}`);
    }
    
    // Проверяем массивы
    const arrayFields = ['props', 'styles', 'dependencies', 'slots', 'events', 'methods', 'examples'];
    for (const field of arrayFields) {
      if (face[field] && !Array.isArray(face[field])) {
        errors.push(`Поле ${field} должно быть массивом`);
      }
    }
    
    // Проверяем метаданные
    if (face.metadata) {
      if (!face.metadata.createdAt) {
        errors.push('Отсутствует metadata.createdAt');
      }
      if (!face.metadata.updatedAt) {
        errors.push('Отсутствует metadata.updatedAt');
      }
    } else {
      errors.push('Отсутствует объект metadata');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * Клонирует Face с новым ID
   */
  static clone(face: ComponentFace, newName?: string): ComponentFace {
    const cloned = JSON.parse(JSON.stringify(face));
    const now = new Date().toISOString();
    
    cloned.id = `face_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    cloned.name = newName || `${face.name}_copy`;
    cloned.metadata.createdAt = now;
    cloned.metadata.updatedAt = now;
    
    return cloned;
  }
  
  /**
   * Сравнивает два Face
   */
  static compare(face1: ComponentFace, face2: ComponentFace): {
    identical: boolean;
    differences: string[];
  } {
    const differences: string[] = [];
    
    // Сравниваем основные поля
    const fieldsToCompare = ['name', 'framework', 'version'];
    for (const field of fieldsToCompare) {
      if (face1[field as keyof ComponentFace] !== face2[field as keyof ComponentFace]) {
        differences.push(`Различие в поле ${field}`);
      }
    }
    
    // Сравниваем количество элементов в массивах
    const arrayFields = ['props', 'styles', 'dependencies', 'slots', 'events', 'methods', 'examples'];
    for (const field of arrayFields) {
      const arr1 = face1[field as keyof ComponentFace] as any[];
      const arr2 = face2[field as keyof ComponentFace] as any[];
      
      if (arr1.length !== arr2.length) {
        differences.push(`Различие в количестве элементов ${field}`);
      }
    }
    
    return {
      identical: differences.length === 0,
      differences
    };
  }
}

// Экспортируем основной класс как default
export default FaceSystem;

// Экспортируем все типы для удобства
export * from './types';
export { FacesGenerator } from './FacesGenerator';
export { FacesRenderer } from './FacesRenderer';
export { FacesManager } from './FacesManager';