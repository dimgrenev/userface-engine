import { z, ZodSchema, ZodType } from 'zod';

/**
 * Zod валидатор для props компонентов
 */
export class ZodPropsValidator {
  private schemas: Map<string, ZodSchema> = new Map();

  /**
   * Создание Zod схемы из props спецификации
   */
  createSchema(props: Array<{
    name: string;
    type: string;
    required: boolean;
    defaultValue?: any;
    options?: string[];
  }>): ZodSchema {
    const schemaObject: Record<string, ZodType> = {};

    props.forEach(prop => {
      let zodType = this.getZodTypeFromString(prop.type, prop.options);

      // Если не обязательный, делаем optional
      if (!prop.required) {
        zodType = zodType.optional();
      }

      // Добавляем default значение если есть
      if (prop.defaultValue !== undefined) {
        zodType = zodType.default(prop.defaultValue);
      }

      schemaObject[prop.name] = zodType;
    });

    return z.object(schemaObject);
  }

  /**
   * Маппинг строкового типа в Zod тип
   */
  private getZodTypeFromString(type: string, options?: string[]): ZodType {
    const lowerType = type.toLowerCase().trim();

    // Обработка enum/select типов
    if (options && options.length > 0) {
      return z.enum(options as [string, ...string[]]);
    }

    // Базовые типы
    switch (lowerType) {
      case 'string':
        return z.string();
      
      case 'number':
        return z.number();
      
      case 'boolean':
        return z.boolean();
      
      case 'array':
        return z.array(z.any());
      
      case 'object':
        return z.record(z.string(), z.any());
      
      case 'function':
        return z.any(); // Упрощено: функции как any
      
      case 'date':
        return z.date();
      
      // React специфичные типы
      case 'node':
      case 'element':
      case 'reactnode':
      case 'reactelement':
        return z.any(); // React элементы не валидируем строго
      
      // Union типы и все остальное
      default:
        return z.any();
    }
  }

  /**
   * Валидация props
   */
  validate(componentName: string, props: Record<string, any>): {
    success: boolean;
    data?: any;
    errors?: string[];
  } {
    const schema = this.schemas.get(componentName);
    if (!schema) {
      return {
        success: false,
        errors: [`No validation schema found for component: ${componentName}`]
      };
    }

    try {
      const result = schema.parse(props);
      return {
        success: true,
        data: result
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          success: false,
          errors: error.issues.map((err: any) => 
            `${err.path.join('.')}: ${err.message}`
          )
        };
      }
      
      return {
        success: false,
        errors: [error instanceof Error ? error.message : 'Validation failed']
      };
    }
  }

  /**
   * Регистрация схемы для компонента
   */
  registerSchema(componentName: string, props: Array<{
    name: string;
    type: string;
    required: boolean;
    defaultValue?: any;
    options?: string[];
  }>): void {
    const schema = this.createSchema(props);
    this.schemas.set(componentName, schema);
  }

  /**
   * Получение схемы компонента
   */
  getSchema(componentName: string): ZodSchema | undefined {
    return this.schemas.get(componentName);
  }

  /**
   * Удаление схемы
   */
  removeSchema(componentName: string): void {
    this.schemas.delete(componentName);
  }

  /**
   * Очистка всех схем
   */
  clearSchemas(): void {
    this.schemas.clear();
  }

  /**
   * Получение списка зарегистрированных компонентов
   */
  getRegisteredComponents(): string[] {
    return Array.from(this.schemas.keys());
  }
}

// Экспорт singleton instance
export const zodPropsValidator = new ZodPropsValidator();