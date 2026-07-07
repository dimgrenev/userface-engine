import type { FaceUiDoc } from './types';
import {
  FACE_UI_SCHEMA,
  FACE_UI_SCHEMA_VERSION,
} from './types';
import { isFaceUiDoc } from './schema';

export interface MigrationOptions {
  /**
   * If true, throws an error if the document is completely unrecognized or cannot be migrated.
   * If false, returns null in those cases.
   */
  strict?: boolean;
}

/**
 * Migration layer for Face UI documents.
 * Validates documents against the latest supported face schema.
 */
export function migrateFaceUiDoc(raw: unknown, options: MigrationOptions = {}): FaceUiDoc | null {
  if (!raw || typeof raw !== 'object') {
    if (options.strict) throw new Error('Face UI document must be an object.');
    return null;
  }

  const doc = raw as Record<string, any>;
  if (isFaceUiDoc(doc)) {
    return {
      ...doc,
      schema: FACE_UI_SCHEMA,
      'schema-version': FACE_UI_SCHEMA_VERSION,
    } as FaceUiDoc;
  }

  // Future migrations will go here
  // if (doc.schema === 'face' && doc['schema-version'] === 2) { ... }

  if (options.strict) {
    throw new Error('Unrecognized Face UI document format.');
  }
  return null;
}
