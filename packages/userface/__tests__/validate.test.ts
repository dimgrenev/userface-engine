import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cliPath = resolve(repoRoot, 'packages/userface/bin/userface.js');

function runValidate(args: string[]) {
  return spawnSync(process.execPath, [cliPath, 'validate', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('userface validate CLI', () => {
  let tempRoot = '';
  let componentsRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'uf-validate-'));
    componentsRoot = join(tempRoot, 'components');

    await mkdir(join(componentsRoot, 'Button'), { recursive: true });
    await writeFile(join(componentsRoot, 'Button', 'Button.tsx'), `
import * as React from 'react';

export interface ButtonProps {
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}

export function Button({ children, variant = 'primary', disabled = false }: ButtonProps) {
  return <button data-variant={variant} disabled={disabled}>{children}</button>;
}
`);

    await mkdir(join(componentsRoot, 'Card'), { recursive: true });
    await writeFile(join(componentsRoot, 'Card', 'Card.tsx'), `
export interface CardProps {
  title?: string;
}

export function Card({ title }: CardProps) {
  return <section>{title}</section>;
}
`);
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
      componentsRoot = '';
    }
  });

  it('emits aggregate CI JSON for a component path', () => {
    const result = runValidate([join(componentsRoot, 'Button'), '--ci']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(String(result.stdout || '{}'));
    expect(payload.totalComponents).toBe(1);
    expect(payload.failed).toBe(0);
    expect(payload.results[0].component).toBe('Button');
    expect(payload.results[0].violationsTotal).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.affectedFiles)).toBe(true);
  });

  it('fails when fail-on warning is requested', () => {
    const result = runValidate([join(componentsRoot, 'Button'), '--ci', '--fail-on', 'warning']);

    expect(result.status).toBe(1);
    const payload = JSON.parse(String(result.stdout || '{}'));
    expect(payload.failed).toBe(1);
    expect(payload.results[0].status).toBe('fail');
  });

  it('aggregates a component directory and reports entry files as affected files', { timeout: 15000 }, () => {
    const result = runValidate([componentsRoot, '--ci']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(String(result.stdout || '{}'));
    expect(payload.totalComponents).toBeGreaterThan(1);
    expect(payload.affectedFiles.some((file: string) => /\.(tsx|jsx|vue|svelte)$/.test(file))).toBe(true);
  });
});
