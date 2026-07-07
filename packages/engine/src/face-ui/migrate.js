import { FACE_UI_SCHEMA, FACE_UI_SCHEMA_VERSION } from './types';
import { isFaceUiDoc } from './schema';
/**
 * Migration layer for Face UI documents.
 * Validates documents against the latest supported face schema.
 */
export function migrateFaceUiDoc(raw, options = {}) {
    if (!raw || typeof raw !== 'object') {
        if (options.strict)
            throw new Error('Face UI document must be an object.');
        return null;
    }
    const doc = raw;
    if (isFaceUiDoc(doc)) {
        return {
            ...doc,
            schema: FACE_UI_SCHEMA,
            'schema-version': FACE_UI_SCHEMA_VERSION,
        };
    }
    // Future migrations will go here
    // if (doc.schema === 'face' && doc['schema-version'] === 2) { ... }
    if (options.strict)
        throw new Error('Unrecognized Face UI document format.');
    return null;
}
