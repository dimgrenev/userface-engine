import type { FaceUiRegistry } from './types';

/**
 * Create a static registry from a pre-loaded component map.
 * Used for built-in libraries (face-ui-react) where all components are already imported.
 */
export function createFaceUiRegistry(components: Record<string, any>): FaceUiRegistry {
  const map = { ...(components || {}) };
  return {
    resolve(type: string) {
      return map[type] ?? null;
    },
  };
}

/**
 * Create a merged registry: static (library) + dynamic (user project).
 * User components take precedence over library components with the same name.
 * Unknown components return a fallback placeholder.
 */
export function createMergedRegistry(
  libraryComponents: Record<string, any>,
  userComponents: Record<string, any>,
): FaceUiRegistry {
  const library = { ...(libraryComponents || {}) };
  const user = { ...(userComponents || {}) };
  return {
    resolve(type: string) {
      // User project components take precedence
      return user[type] ?? library[type] ?? null;
    },
  };
}
