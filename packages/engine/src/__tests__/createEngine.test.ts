import { describe, it, expect } from 'vitest';
import { createEngine } from '../createEngine';

describe('createEngine', () => {
  it('returns an engine instance with the correct shape', () => {
    const engine = createEngine();
    expect(engine).toBeDefined();
    expect(typeof engine.analyzeComponent).toBe('function');
    expect(typeof engine.renderFromSpec).toBe('function');
    expect(typeof engine.generateStates).toBe('function');
    expect(typeof engine.getDiagnostics).toBe('function');
  });

  it('getDiagnostics returns metadata', () => {
    const engine = createEngine({ debug: true });
    const diag = engine.getDiagnostics();
    expect(diag.debug).toBe(true);
    expect(typeof diag.createdAt).toBe('number');
  });

  it('generateStates produces entries for boolean props', () => {
    const engine = createEngine();
    const states = engine.generateStates([
      { name: 'disabled', type: 'boolean', required: false, description: 'Disable' },
      { name: 'visible', type: 'boolean', required: false, description: 'Visible' },
    ]);
    expect(Array.isArray(states)).toBe(true);
    expect(states.length).toBeGreaterThan(0);
  });

  it('analyzeComponent rejects without entryPath', async () => {
    const engine = createEngine();
    await expect(engine.analyzeComponent([], {} as any)).rejects.toBeDefined();
  });
});
