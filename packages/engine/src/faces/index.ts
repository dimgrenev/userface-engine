/**
 * Экспорты системы Face
 */

// Основные классы
import { FaceSystem } from './FaceSystem';
export { FaceSystem as default } from './FaceSystem';
export { FacesGenerator } from './FacesGenerator';
export { FacesRenderer } from './FacesRenderer';
export { FacesManager } from './FacesManager';
export { FaceSystem } from './FaceSystem';

// Типы
export * from './types';

// Утилиты для быстрого создания системы
export const createFaceSystem = (config?: {
  generatorConfig?: import('./types').FaceGeneratorConfig;
  useIndexedDB?: boolean;
}) => {
  return new FaceSystem(config);
};

// Утилиты для работы с Face
export const FaceUtils = {
  /**
   * Создает пустой Face
   */
  createEmpty: FaceSystem.createEmpty,
  
  /**
   * Валидирует структуру Face
   */
  validateStructure: FaceSystem.validateStructure,
  
  /**
   * Клонирует Face
   */
  clone: FaceSystem.clone,
  
  /**
   * Сравнивает Face
   */
  compare: FaceSystem.compare,
  
  /**
   * Конвертирует Face в JSON
   */
  toJSON: FaceSystem.toJSON,
  
  /**
   * Создает Face из JSON
   */
  fromJSON: FaceSystem.fromJSON
};