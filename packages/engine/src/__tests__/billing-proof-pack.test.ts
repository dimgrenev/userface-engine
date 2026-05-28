import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const GENERATED_AT = '2026-01-01T00:00:00.000Z';

function repoRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(join('packages', 'engine'))) return resolve(cwd, '../..');
  return cwd;
}

function engineCliPath(): string {
  return resolve(repoRoot(), 'packages/engine/src/cli.ts');
}

function fixtureRoot(): string {
  return resolve(repoRoot(), 'packages/engine/fixtures/billing-dashboard');
}

function expectedPath(name: string): string {
  return resolve(fixtureRoot(), 'expected', name);
}

const guardArgs = [
  '--registry-dir',
  'src/components',
  '--registry-manifest',
  'component-registry.json',
  '--enforce-registry-boundary',
  '--offline',
  '--fail-on',
  'warning',
];

const readinessArgs = ['readiness', '--root', '.', '--ui-doc', 'screens/fixed.ui.json'];

function runCli(args: string[], expectedStatus = 0) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', engineCliPath(), ...args], {
    cwd: fixtureRoot(),
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });

  expect(result.status, result.stderr || result.stdout).toBe(expectedStatus);
  return result.stdout;
}

function normalizePath(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.split(fixtureRoot()).join('<fixture>/billing-dashboard');
}

function normalizeProof(proof: any) {
  return {
    ...proof,
    createdAt: GENERATED_AT,
    ...(proof.repo ? { repo: { rootHash: proof.repo.rootHash } } : {}),
  };
}

function normalizeReadiness(report: any) {
  const componentsRoot = typeof report.components?.root === 'string'
    ? relative(fixtureRoot(), report.components.root)
    : undefined;

  return {
    ...report,
    createdAt: GENERATED_AT,
    ...(report.proof ? { proof: normalizeProof(report.proof) } : {}),
    repo: {
      ...report.repo,
      root: normalizePath(report.repo?.root),
    },
    components: {
      ...report.components,
      ...(componentsRoot ? { root: componentsRoot } : {}),
    },
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.split(fixtureRoot()).join('<fixture>/billing-dashboard');
}

describe('billing dashboard proof pack', () => {
  it('keeps the generated readiness sample current', () => {
    const actual = normalizeReadiness(JSON.parse(runCli([...readinessArgs, '--format', 'json'])));
    const expected = JSON.parse(readFileSync(expectedPath('readiness.json'), 'utf8'));

    expect(actual).toEqual(expected);
    expect(actual.status).toBe('ready');
    expect(actual.guard.canRun).toBe(true);
    expect(actual.proof.schema).toBe('userface-proof@1');
    expect(actual.proof.status).toBe('passed');
  });

  it('keeps the generated readiness markdown current', () => {
    const actual = normalizeMarkdown(runCli([...readinessArgs, '--format', 'markdown']));
    const expected = readFileSync(expectedPath('readiness.md'), 'utf8');

    expect(actual).toBe(expected);
  });

  it('blocks the broken billing dashboard with a real Userface Proof', () => {
    const actual = normalizeProof(JSON.parse(runCli(['guard', 'screens/broken.ui.json', ...guardArgs], 1)));
    const expected = JSON.parse(readFileSync(expectedPath('broken.userface-proof.json'), 'utf8'));

    expect(actual).toEqual(expected);
    expect(actual.schema).toBe('userface-proof@1');
    expect(actual.status).toBe('blocked');
    expect(actual.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
  });

  it('keeps the broken proof markdown current', () => {
    const actual = runCli(['guard', 'screens/broken.ui.json', ...guardArgs, '--format', 'markdown'], 1);
    const expected = readFileSync(expectedPath('broken.userface-proof.md'), 'utf8');

    expect(actual).toBe(expected);
  });

  it('passes the fixed billing dashboard with a real Userface Proof', () => {
    const actual = normalizeProof(JSON.parse(runCli(['guard', 'screens/fixed.ui.json', ...guardArgs, '--preview-artifact', 'artifacts/fixed.preview.svg'])));
    const expected = JSON.parse(readFileSync(expectedPath('fixed.userface-proof.json'), 'utf8'));

    expect(actual).toEqual(expected);
    expect(actual.status).toBe('passed');
    expect(actual.composition.status).toBe('passed');
    expect(actual.preview.status).toBe('passed');
    expect(actual.preview.artifacts).toEqual([
      expect.stringMatching(/^artifacts\/fixed\.preview\.svg#sha256:[a-f0-9]{64}$/),
    ]);
  });

  it('keeps the fixed proof markdown current', () => {
    const actual = runCli(['guard', 'screens/fixed.ui.json', ...guardArgs, '--preview-artifact', 'artifacts/fixed.preview.svg', '--format', 'markdown']);
    const expected = readFileSync(expectedPath('fixed.userface-proof.md'), 'utf8');

    expect(actual).toBe(expected);
  });

  it('keeps the generated GitHub PR guard evidence current', () => {
    const outputRoot = mkdtempSync(join(tmpdir(), 'userface-pr-guard-'));
    try {
      const proofPath = join(outputRoot, 'broken.pr.userface-proof.json');
      const summaryPath = join(outputRoot, 'broken.pr-summary.md');
      const expectedSummaryPath = 'artifacts/broken.pr-summary.md';
      const annotations = runCli([
        'guard',
        'screens/broken.ui.json',
        ...guardArgs,
        '--format',
        'github-annotations',
        '--proof',
        proofPath,
        '--summary',
        summaryPath,
      ], 1);
      const proof = normalizeProof(JSON.parse(readFileSync(proofPath, 'utf8')));
      const summary = normalizeMarkdown(readFileSync(summaryPath, 'utf8'));

      if (proof.pr?.summaryPath) proof.pr.summaryPath = expectedSummaryPath;

      expect(proof).toEqual(JSON.parse(readFileSync(expectedPath('broken.pr.userface-proof.json'), 'utf8')));
      expect(summary).toBe(readFileSync(expectedPath('broken.pr-summary.md'), 'utf8'));
      expect(annotations).toBe(readFileSync(expectedPath('broken.github-annotations.txt'), 'utf8'));
      expect(proof.pr.provider).toBe('github');
      expect(proof.pr.annotations).toBeGreaterThan(0);
      expect(proof.pr.summaryPath).toBe(expectedSummaryPath);
      expect(annotations).toContain('::error');
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });

  it('keeps the generated trust proof current', () => {
    const actual = normalizeProof(JSON.parse(runCli(['trust', '--offline'])));
    const expected = JSON.parse(readFileSync(expectedPath('trust.userface-proof.json'), 'utf8'));

    expect(actual).toEqual(expected);
    expect(actual.target.kind).toBe('trust');
    expect(actual.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
  });

  it('keeps the trust proof markdown current', () => {
    const actual = runCli(['trust', '--offline', '--format', 'markdown']);
    const expected = readFileSync(expectedPath('trust.userface-proof.md'), 'utf8');

    expect(actual).toBe(expected);
  });
});
