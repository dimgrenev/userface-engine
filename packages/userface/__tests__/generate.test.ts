import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGeneratedComponentFiles,
  generateComponentScaffold,
  normalizeComponentName,
} from '../lib/generate.js';

describe('userface generate helpers', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'uf-generate-'));
    await mkdir(join(tempRoot, 'packages/face-ui-react'), { recursive: true });
    await writeFile(join(tempRoot, 'packages/face-ui-react/index.ts'), "// existing exports\n");
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('normalizes component names to PascalCase', () => {
    expect(normalizeComponentName('empty-state')).toBe('EmptyState');
    expect(normalizeComponentName(' status pill ')).toBe('StatusPill');
  });

  it('builds scaffold files including barrel exports', async () => {
    const scaffold = buildGeneratedComponentFiles({
      name: 'empty-state',
      cwd: tempRoot,
    });

    expect(scaffold.name).toBe('EmptyState');
    expect(scaffold.componentDir).toBe('packages/face-ui-react/EmptyState');
    expect(scaffold.files.map((file) => file.path)).toEqual([
      'packages/face-ui-react/EmptyState/EmptyState.tsx',
      'packages/face-ui-react/EmptyState/EmptyState.json',
      'packages/face-ui-react/index.ts',
    ]);
    expect(scaffold.files[2].content).toContain("export { EmptyState, emptyStateAnatomy } from './EmptyState/EmptyState'");
  });

  it('writes a new scaffold to disk and updates the barrel', async () => {
    const result = generateComponentScaffold({
      name: 'StatusPill',
      cwd: tempRoot,
    });

    expect(result.created).toBe(true);

    const componentSource = await readFile(join(tempRoot, 'packages/face-ui-react/StatusPill/StatusPill.tsx'), 'utf-8');
    const componentContract = JSON.parse(
      await readFile(join(tempRoot, 'packages/face-ui-react/StatusPill/StatusPill.json'), 'utf-8'),
    );
    const indexSource = await readFile(join(tempRoot, 'packages/face-ui-react/index.ts'), 'utf-8');

    expect(componentSource).toContain('export interface StatusPillProps');
    expect(componentSource).toContain("createAnatomy('status-pill')");
    expect(componentContract.name).toBe('StatusPill');
    expect(indexSource).toContain("export { StatusPill, statusPillAnatomy } from './StatusPill/StatusPill'");
  });
});
