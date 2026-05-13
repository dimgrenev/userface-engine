import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
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
  it('emits aggregate CI JSON for a component path', () => {
    const result = runValidate(['packages/face-ui-react/Button', '--ci']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(String(result.stdout || '{}'));
    expect(payload.totalComponents).toBe(1);
    expect(payload.failed).toBe(0);
    expect(payload.results[0].component).toBe('Button');
    expect(payload.results[0].violationsTotal).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.affectedFiles)).toBe(true);
  });

  it('fails when fail-on warning is requested', () => {
    const result = runValidate(['packages/face-ui-react/Button', '--ci', '--fail-on', 'warning']);

    expect(result.status).toBe(1);
    const payload = JSON.parse(String(result.stdout || '{}'));
    expect(payload.failed).toBe(1);
    expect(payload.results[0].status).toBe('fail');
  });

  it('aggregates a component directory and reports entry files as affected files', { timeout: 15000 }, () => {
    const result = runValidate(['packages/face-ui-react', '--ci']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(String(result.stdout || '{}'));
    expect(payload.totalComponents).toBeGreaterThan(1);
    expect(payload.affectedFiles.some((file: string) => /\.(tsx|jsx|vue|svelte)$/.test(file))).toBe(true);
  });
});
