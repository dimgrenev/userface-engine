import type { FaceUiDoc } from './types';

export interface MigrationOptions {
  /**
   * If true, throws an error if the document is completely unrecognized or cannot be migrated.
   * If false, returns null in those cases.
   */
  strict?: boolean;
}

/**
 * Migration layer for Face UI documents.
 * Upgrades older versions (or legacy formats) to the latest supported version (ui@1).
 */
export function migrateFaceUiDoc(raw: unknown, options: MigrationOptions = {}): FaceUiDoc | null {
  if (!raw || typeof raw !== 'object') {
    if (options.strict) throw new Error('Face UI document must be an object.');
    return null;
  }

  const doc = raw as Record<string, any>;
  let version = doc.version;

  // 1. Detect legacy or unspecified version
  if (!version) {
    // If it looks like a ui@1 document but misses version, assume ui@1.
    if (doc.root && typeof doc.root === 'object' && doc.root.type) {
      version = 'ui@1';
      doc.version = 'ui@1';
    } else {
      if (options.strict) throw new Error('Unrecognized Face UI document format.');
      return null;
    }
  }

  // 2. Process migrations sequentially
  if (version === 'ui@1') {
    // Current version, nothing to do.
    return doc as FaceUiDoc;
  }

  // Future migrations will go here
  // if (version === 'ui@2') { ... }

  if (options.strict) throw new Error(`Unsupported Face UI version: ${version}`);
  return null;
}
