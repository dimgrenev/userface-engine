import type { FaceUiDoc } from './types';

/**
 * Immutable document history with undo/redo support.
 * Each entry is a complete FaceUiDoc snapshot (cheap since docs are small JSON).
 */
export class DocHistory {
  private stack: FaceUiDoc[] = [];
  private pointer = -1;
  private limit: number;

  constructor(limit = 100) {
    this.limit = limit;
  }

  /** Push a new document state. Discards any redo history. */
  push(doc: FaceUiDoc): void {
    // Discard redo stack
    this.stack = this.stack.slice(0, this.pointer + 1);
    this.stack.push(doc);
    // Enforce limit
    if (this.stack.length > this.limit) {
      this.stack = this.stack.slice(this.stack.length - this.limit);
    }
    this.pointer = this.stack.length - 1;
  }

  /** Undo: return previous document state, or null if at beginning. */
  undo(): FaceUiDoc | null {
    if (this.pointer <= 0) return null;
    this.pointer -= 1;
    return this.stack[this.pointer];
  }

  /** Redo: return next document state, or null if at end. */
  redo(): FaceUiDoc | null {
    if (this.pointer >= this.stack.length - 1) return null;
    this.pointer += 1;
    return this.stack[this.pointer];
  }

  get canUndo(): boolean {
    return this.pointer > 0;
  }

  get canRedo(): boolean {
    return this.pointer < this.stack.length - 1;
  }

  get current(): FaceUiDoc | null {
    return this.stack[this.pointer] ?? null;
  }

  /** Reset history with a single initial state. */
  reset(doc: FaceUiDoc): void {
    this.stack = [doc];
    this.pointer = 0;
  }
}
