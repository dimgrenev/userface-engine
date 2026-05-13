/**
 * Менеджер JSON-спецификаций компонентов (Faces)
 * Обеспечивает сохранение, загрузку, экспорт и импорт Face
 */

import {
  ComponentFace,
  FacesBundle,
  FaceImportResult,
  FaceCache,
  FaceSystemEvents,
  IFaceSystem,
  FaceGenerationResult,
  FaceValidationResult,
  FaceRenderResult,
  FaceGeneratorConfig
} from './types';
import { FacesGenerator } from './FacesGenerator';
import { FacesRenderer } from './FacesRenderer';


/**
 * Усиленная реализация кэша в памяти с автоочисткой
 */
class MemoryFaceCache implements FaceCache {
  private cache = new Map<string, { face: ComponentFace; expires?: number }>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private defaultTTL = 3600000; // 1 час по умолчанию
  
  constructor() {
    // Автоочистка каждые 5 минут
    this.scheduleCleanup();
  }
  
  async get(key: string): Promise<ComponentFace | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // Проверяем TTL
    if (entry.expires && Date.now() > entry.expires) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.face;
  }
  
  async set(key: string, face: ComponentFace, ttl?: number): Promise<void> {
    const expires = ttl ? Date.now() + ttl : Date.now() + this.defaultTTL;
    this.cache.set(key, { face, expires });
  }
  
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }
  
  async clear(): Promise<void> {
    this.cache.clear();
  }
  
  async keys(): Promise<string[]> {
    return Array.from(this.cache.keys());
  }
  
  async size(): Promise<number> {
    return this.cache.size;
  }
  
  private scheduleCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, 300000); // 5 минут
  }
  
  private performCleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires && now > entry.expires) {
        this.cache.delete(key);
      }
    }
  }
  
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cache.clear();
  }
}

/**
 * Хранилище Face в localStorage с retry и фоллбэками
 */
class LocalStorageFaceStorage {
  private readonly prefix = 'faces_';
  private readonly maxRetries = 3;
  
  async save(face: ComponentFace): Promise<void> {
    return this.withRetry(async () => {
      try {
        const key = this.prefix + face.id;
        const data = JSON.stringify(face);
        
        // Проверяем размер перед сохранением
        if (data.length > 5 * 1024 * 1024) { // 5MB лимит
          throw new Error('Face слишком большой для localStorage');
        }
        
        localStorage.setItem(key, data);
      } catch (error) {
        if (this.isQuotaExceeded(error)) {
          // Попытка очистки старых записей
          await this.cleanupOldEntries();
          // Повторная попытка
          const key = this.prefix + face.id;
          localStorage.setItem(key, JSON.stringify(face));
        } else {
          throw error as Error;
        }
      }
    });
  }
  
  async load(id: string): Promise<ComponentFace | null> {
    return this.withRetry(async () => {
      try {
        const key = this.prefix + id;
        const data = localStorage.getItem(key);
        if (!data) return null;
        
        const parsed = JSON.parse(data);
        // Валидация структуры
        if (!this.isValidFace(parsed)) {
          console.warn(`Невалидная структура Face ${id}, удаляем`);
          localStorage.removeItem(key);
          return null;
        }
        
        return parsed;
      } catch (error) {
        console.error(`Ошибка загрузки Face ${id}:`, error);
        return null;
      }
    });
  }
  
  async delete(id: string): Promise<void> {
    const key = this.prefix + id;
    localStorage.removeItem(key);
  }
  
  async list(): Promise<ComponentFace[]> {
    const faces: ComponentFace[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        try {
          const data = localStorage.getItem(key);
          if (data) {
            faces.push(JSON.parse(data));
          }
        } catch (error) {
          console.error(`Ошибка парсинга Face из ${key}:`, error);
        }
      }
    }
    
    return faces;
  }
  
  async clear(): Promise<void> {
    const keysToDelete: string[] = [];
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(this.prefix)) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => localStorage.removeItem(key));
  }

  // Хелперы: retry, очистка старых, проверки и валидация
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = Math.pow(2, attempt) * 100; // 100ms, 200ms, 400ms
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError as Error;
  }

  private async cleanupOldEntries(): Promise<void> {
    try {
      const faces = await this.list();
      if (!faces || faces.length === 0) return;
      // Сортируем по дате обновления (самые новые остаются)
      const sorted = faces.sort((a, b) =>
        new Date(b?.metadata?.updatedAt ?? 0).getTime() - new Date(a?.metadata?.updatedAt ?? 0).getTime()
      );
      // Удаляем 50% самых старых
      const toDelete = sorted.slice(Math.floor(sorted.length / 2));
      for (const face of toDelete) {
        await this.delete(face.id);
      }
    } catch (error) {
      console.error('Ошибка очистки старых записей:', error);
    }
  }

  private isQuotaExceeded(error: unknown): boolean {
    const e = error as any;
    return (
      e?.name === 'QuotaExceededError' ||
      e?.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e?.code === 22 ||
      e?.code === 1014
    );
  }

  private isValidFace(obj: any): obj is ComponentFace {
    return (
      obj && typeof obj === 'object' &&
      typeof obj.id === 'string' &&
      typeof obj.name === 'string' &&
      !!obj.framework && !!obj.metadata
    );
  }
}

/**
 * Хранилище Face в IndexedDB (для больших данных)
 */
class IndexedDBFaceStorage {
  private dbName = 'FacesDB';
  private storeName = 'faces';
  private version = 1;
  private db: IDBDatabase | null = null;
  
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('name', 'name', { unique: false });
          store.createIndex('framework', 'framework', { unique: false });
          store.createIndex('createdAt', 'metadata.createdAt', { unique: false });
        }
      };
    });
  }
  
  async save(face: ComponentFace): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(face);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  
  async load(id: string): Promise<ComponentFace | null> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }
  
  async delete(id: string): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(id);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  
  async list(): Promise<ComponentFace[]> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
  
  async clear(): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
  
  async search(query: {
    name?: string;
    framework?: string;
    tags?: string[];
  }): Promise<ComponentFace[]> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const results = request.result.filter(face => {
          if (query.name && !face.name.toLowerCase().includes(query.name.toLowerCase())) {
            return false;
          }
          if (query.framework && face.framework !== query.framework) {
            return false;
          }
          if (query.tags && query.tags.length > 0) {
            const faceTags = face.metadata.tags || [];
            if (!query.tags.some(tag => faceTags.includes(tag))) {
              return false;
            }
          }
          return true;
        });
        resolve(results);
      };
    });
  }
}

/**
 * Система событий для Face
 */
class FaceEventEmitter {
  private listeners = new Map<keyof FaceSystemEvents, Function[]>();
  
  on<K extends keyof FaceSystemEvents>(
    event: K,
    listener: (data: FaceSystemEvents[K]) => void
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }
  
  off<K extends keyof FaceSystemEvents>(
    event: K,
    listener: (data: FaceSystemEvents[K]) => void
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      const index = eventListeners.indexOf(listener);
      if (index > -1) {
        eventListeners.splice(index, 1);
      }
    }
  }
  
  emit<K extends keyof FaceSystemEvents>(
    event: K,
    data: FaceSystemEvents[K]
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach(listener => {
        try {
          listener(data);
        } catch (error) {
          console.error(`Ошибка в обработчике события ${event}:`, error);
        }
      });
    }
  }
}

/**
 * Основной менеджер Face с усиленной автоматизацией
 */
export class FacesManager implements IFaceSystem {
  private cache: FaceCache;
  private storage: LocalStorageFaceStorage | IndexedDBFaceStorage;
  private fallbackStorage: LocalStorageFaceStorage | null = null;
  private eventEmitter = new FaceEventEmitter();
  private useIndexedDB: boolean;
  private generator: FacesGenerator;
  private renderer: FacesRenderer;
  
  constructor(options: {
    useIndexedDB?: boolean;
    cache?: FaceCache;
    generatorConfig?: FaceGeneratorConfig;
  } = {}) {
    this.useIndexedDB = options.useIndexedDB ?? true;
    this.cache = options.cache || new MemoryFaceCache();
    
    // Настройка основного хранилища с фоллбэком
    if (this.useIndexedDB && typeof indexedDB !== 'undefined') {
      this.storage = new IndexedDBFaceStorage();
      this.fallbackStorage = new LocalStorageFaceStorage(); // Фоллбэк
    } else {
      this.storage = new LocalStorageFaceStorage();
    }

    // Инициализация генератора и рендерера
    this.generator = new FacesGenerator(options.generatorConfig);
    this.renderer = new FacesRenderer();
  }
  
  /**
   * Сохраняет Face с автоматическими фоллбэками
   */
  async saveFace(face: ComponentFace): Promise<void> {
    // Обновляем метаданные
    face.metadata.updatedAt = new Date().toISOString();
    
    const errors: string[] = [];
    
    try {
      // Основное хранилище
      await this.storage.save(face);
    } catch (error) {
      errors.push(`Основное хранилище: ${error}`);
      
      // Фоллбэк хранилище
      if (this.fallbackStorage) {
        try {
          await this.fallbackStorage.save(face);
          this.eventEmitter.emit('face:error', { 
            error: new Error('Использован фоллбэк для сохранения'), 
            context: { action: 'save_fallback', faceId: face.id } 
          });
        } catch (fallbackError) {
          errors.push(`Фоллбэк хранилище: ${fallbackError}`);
          this.eventEmitter.emit('face:error', { 
            error: new Error(errors.join('; ')), 
            context: { action: 'save', faceId: face.id } 
          });
          throw new Error(`Все хранилища недоступны: ${errors.join('; ')}`);
        }
      } else {
        this.eventEmitter.emit('face:error', { 
          error: error as Error, 
          context: { action: 'save', faceId: face.id } 
        });
        throw error;
      }
    }
    
    try {
      // Кэшируем с автоматическим TTL
      await this.cache.set(face.id, face);
      this.eventEmitter.emit('face:cached', { key: face.id, face });
    } catch (cacheError) {
      // Кэш не критичен, только логируем
      console.warn('Ошибка кэширования:', cacheError);
    }
  }
  
  /**
   * Загружает Face с автоматическими фоллбэками
   */
  async loadFace(id: string): Promise<ComponentFace | null> {
    try {
      // Сначала кэш
      let face = await this.cache.get(id);
      if (face) return face;
      
      // Основное хранилище
      try {
        face = await this.storage.load(id);
      } catch (error) {
        console.warn('Ошибка основного хранилища:', error);
        
        // Фоллбэк хранилище
        if (this.fallbackStorage) {
          face = await this.fallbackStorage.load(id);
        }
      }
      
      if (face) {
        // Автокэширование
        try {
          await this.cache.set(id, face);
        } catch (cacheError) {
          console.warn('Ошибка кэширования при загрузке:', cacheError);
        }
      }
      
      return face;
      
    } catch (error) {
      this.eventEmitter.emit('face:error', { 
        error: error as Error, 
        context: { action: 'load', faceId: id } 
      });
      return null;
    }
  }
  
  /**
   * Удаляет Face
   */
  async deleteFace(id: string): Promise<void> {
    try {
      // Удаляем из хранилища
      await this.storage.delete(id);
      
      // Удаляем из кэша
      await this.cache.delete(id);
      
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'delete', faceId: id } });
      throw error;
    }
  }
  
  /**
   * Получает список всех Face
   */
  async listFaces(): Promise<ComponentFace[]> {
    try {
      return await this.storage.list();
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'list' } });
      return [];
    }
  }
  
  /**
   * Поиск Face
   */
  async searchFaces(query: {
    name?: string;
    framework?: string;
    tags?: string[];
  }): Promise<ComponentFace[]> {
    try {
      if (this.storage instanceof IndexedDBFaceStorage) {
        return await this.storage.search(query);
      } else {
        // Простой поиск для localStorage
        const allFaces = await this.listFaces();
        return allFaces.filter(face => {
          if (query.name && !face.name.toLowerCase().includes(query.name.toLowerCase())) {
            return false;
          }
          if (query.framework && face.framework !== query.framework) {
            return false;
          }
          if (query.tags && query.tags.length > 0) {
            const faceTags = face.metadata.tags || [];
            if (!query.tags.some(tag => faceTags.includes(tag))) {
              return false;
            }
          }
          return true;
        });
      }
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'search', query } });
      return [];
    }
  }
  
  /**
   * Экспортирует Face в пакет
   */
  async exportFaces(ids: string[]): Promise<FacesBundle> {
    try {
      const faces: ComponentFace[] = [];
      const allDependencies = new Map<string, any>();
      
      // Загружаем все Face
      for (const id of ids) {
        const face = await this.loadFace(id);
        if (face) {
          faces.push(face);
          
          // Собираем зависимости
          for (const dep of face.dependencies) {
            const key = `${dep.name}@${dep.version}`;
            if (!allDependencies.has(key)) {
              allDependencies.set(key, dep);
            }
          }
        }
      }
      
      const bundleData = JSON.stringify({
        faces,
        dependencies: Array.from(allDependencies.values())
      });
      
      const bundle: FacesBundle = {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        faces,
        dependencies: Array.from(allDependencies.values()),
        metadata: {
          totalSize: bundleData.length,
          compression: 'none',
          checksum: this.calculateChecksum(bundleData)
        }
      };
      
      return bundle;
      
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'export', ids } });
      throw error;
    }
  }
  
  /**
   * Импортирует Face из пакета
   */
  async importFaces(bundle: FacesBundle): Promise<FaceImportResult> {
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    const conflicts: any[] = [];
    
    try {
      // Проверяем версию пакета
      if (!bundle.version || !bundle.faces) {
        errors.push('Неверный формат пакета Face');
        return { success: false, imported, skipped, errors, conflicts };
      }
      
      // Проверяем контрольную сумму
      const bundleData = JSON.stringify({
        faces: bundle.faces,
        dependencies: bundle.dependencies
      });
      
      if (bundle.metadata.checksum !== this.calculateChecksum(bundleData)) {
        errors.push('Контрольная сумма пакета не совпадает');
        return { success: false, imported, skipped, errors, conflicts };
      }
      
      // Импортируем каждый Face
      for (const face of bundle.faces) {
        try {
          // Проверяем конфликты
          const existing = await this.loadFace(face.id);
          if (existing) {
            conflicts.push({
              id: face.id,
              reason: 'Face с таким ID уже существует',
              resolution: 'skip'
            });
            skipped.push(face.id);
            continue;
          }
          
          // Сохраняем Face
          await this.saveFace(face);
          imported.push(face.id);
          
        } catch (error) {
          errors.push(`Ошибка импорта Face ${face.id}: ${error}`);
          skipped.push(face.id);
        }
      }
      
      return {
        success: errors.length === 0,
        imported,
        skipped,
        errors,
        conflicts
      };
      
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'import', bundle } });
      errors.push(`Общая ошибка импорта: ${error}`);
      return { success: false, imported, skipped, errors, conflicts };
    }
  }
  
  /**
   * Очищает все Face
   */
  async clearAllFaces(): Promise<void> {
    try {
      await this.storage.clear();
      await this.cache.clear();
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'clear' } });
      throw error;
    }
  }
  
  /**
   * Получает статистику Face
   */
  async getStatistics(): Promise<{
    total: number;
    byFramework: Record<string, number>;
    byComplexity: Record<string, number>;
    totalSize: number;
    cacheSize: number;
  }> {
    try {
      const faces = await this.listFaces();
      const byFramework: Record<string, number> = {};
      const byComplexity: Record<string, number> = {};
      let totalSize = 0;
      
      for (const face of faces) {
        // По фреймворкам
        byFramework[face.framework] = (byFramework[face.framework] || 0) + 1;
        
        // По сложности
        const complexity = face.metadata.complexity || 'unknown';
        byComplexity[complexity] = (byComplexity[complexity] || 0) + 1;
        
        // Размер
        totalSize += face.metadata.size?.bytes || 0;
      }
      
      return {
        total: faces.length,
        byFramework,
        byComplexity,
        totalSize,
        cacheSize: await this.cache.size()
      };
      
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'statistics' } });
      return {
        total: 0,
        byFramework: {},
        byComplexity: {},
        totalSize: 0,
        cacheSize: 0
      };
    }
  }
  
  // Методы для совместимости с IFaceSystem
  async generateFace(files: any[], config?: Partial<FaceGeneratorConfig>): Promise<FaceGenerationResult> {
    try {
      const result = await this.generator.generateFace(files as any, config || {});
      if (result.success && result.face) {
        // Автосохранение и событие
        await this.saveFace(result.face);
        this.eventEmitter.emit('face:generated', { face: result.face, stats: result.stats });
      }
      return result;
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'generate' } });
      return {
        success: false,
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
  
  async validateFace(face: ComponentFace): Promise<FaceValidationResult> {
    try {
      const result = await this.renderer.validateFace(face);
      this.eventEmitter.emit('face:validated', { face, result });
      return result;
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'validate', faceId: face?.id } });
      return {
        valid: false,
        errors: [{ field: 'unknown', message: String(error), severity: 'error' }],
        warnings: [],
        score: 0
      };
    }
  }
  
  async renderFromFace(face: ComponentFace, props: Record<string, any> = {}): Promise<FaceRenderResult> {
    try {
      const result = await this.renderer.renderFromFace(face, props);
      this.eventEmitter.emit('face:rendered', { face, result });
      return result;
    } catch (error) {
      this.eventEmitter.emit('face:error', { error: error as Error, context: { action: 'render', faceId: face?.id } });
      return {
        success: false,
        html: '',
        css: '',
        errors: [String(error)],
        warnings: [],
        performance: { renderTime: 0, memoryUsage: 0, cacheHit: false }
      };
    }
  }
  
  /**
   * Подписка на события
   */
  on<K extends keyof FaceSystemEvents>(
    event: K,
    listener: (data: FaceSystemEvents[K]) => void
  ): void {
    this.eventEmitter.on(event, listener);
  }
  
  /**
   * Отписка от событий
   */
  off<K extends keyof FaceSystemEvents>(
    event: K,
    listener: (data: FaceSystemEvents[K]) => void
  ): void {
    this.eventEmitter.off(event, listener);
  }
  
  private calculateChecksum(data: string): string {
    // Простая контрольная сумма (в реальности лучше использовать crypto)
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }
}