import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const cliPath = resolve(repoRoot, 'packages/userface/bin/userface.js');

function runUserface(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe('userface umbrella CLI engine forwarding', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'uf-engine-forwarding-'));
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2));
  });

  afterEach(async () => {
    if (!tempRoot) return;
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  });

  it('advertises and forwards the primary engine surface', () => {
    const help = runUserface(tempRoot, ['--help']);

    expect(help.status, help.stderr || help.stdout).toBe(0);
    expect(help.stdout).toContain('userface connect');
    expect(help.stdout).toContain('userface mcp-serve');
    expect(help.stdout).toContain('userface proof-schema');

    const schema = runUserface(tempRoot, ['proof-schema']);
    expect(schema.status, schema.stderr || schema.stdout).toBe(0);
    const parsed = JSON.parse(schema.stdout);
    expect(parsed.$id).toBe('https://userface.dev/schemas/userface-proof@1.json');
  });

  it('forwards trust doctor to @userface/engine', () => {
    const result = runUserface(tempRoot, ['trust', '--offline']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.schema).toBe('userface-proof@1');
    expect(proof.target.kind).toBe('trust');
    expect(proof.repo.rootHash).toMatch(/^sha256:/);
    expect(proof.egress.network).toBe(false);
  });

  it('forwards readiness to @userface/engine through the buyer-facing command name', async () => {
    await mkdir(join(tempRoot, 'src/components/Button'), { recursive: true });
    await writeFile(join(tempRoot, 'package.json'), JSON.stringify({
      name: 'readiness-demo',
      dependencies: {
        next: '15.0.0',
        react: '18.3.1',
      },
      devDependencies: {
        typescript: '5.0.0',
      },
    }, null, 2));
    await writeFile(join(tempRoot, 'tsconfig.json'), '{}');
    await writeFile(join(tempRoot, 'src/components/Button/Button.tsx'), [
      'export interface ButtonProps {',
      '  tone?: "primary" | "secondary";',
      '}',
      '',
      'export function Button({ tone = "primary" }: ButtonProps) {',
      '  return <button data-tone={tone}>{tone}</button>;',
      '}',
      '',
    ].join('\n'));
    await writeFile(join(tempRoot, 'src/components/Button/face.json'), JSON.stringify({
      name: 'Button',
      props: {
        tone: {
          type: 'enum',
          options: ['primary', 'secondary'],
        },
      },
    }, null, 2));

    const result = runUserface(tempRoot, ['readiness', '--root', '.', '--format', 'json']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe('userface-readiness@1');
    expect(report.repo.framework).toBe('react');
    expect(report.components.discovered).toBe(1);
    expect(report.components.contracted).toBe(1);
    expect(report.proof.schema).toBe('userface-proof@1');
    expect(report.proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
  });

  it('forwards guard to @userface/engine through the buyer-facing command name', async () => {
    await writeFile(join(tempRoot, 'screen.ui.json'), JSON.stringify({
      schema: 'face',
      'schema-version': 1,
      root: {
        type: 'Card',
        children: [{ type: 'Button' }],
      },
    }, null, 2));

    const result = runUserface(tempRoot, [
      'guard',
      'screen.ui.json',
      '--offline',
      '--fail-on',
      'warning',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.schema).toBe('userface-proof@1');
    expect(proof.target.kind).toBe('pr_gate');
    expect(proof.target.paths).toEqual(['screen.ui.json']);
    expect(proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
  });
});
