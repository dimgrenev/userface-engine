import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createReceipt,
  evaluateReadiness,
  loadManifest,
  redactError,
} = require('../../../../scripts/evals/external-react-readiness.cjs') as {
  createReceipt: (results: unknown[], engineVersion: string, startedAt: number, finishedAt: number) => Record<string, unknown>;
  evaluateReadiness: (target: Record<string, unknown>, report: Record<string, unknown>, mode: string, durationMs: number) => Record<string, any>;
  loadManifest: (path?: string) => { targets: Array<Record<string, any>> };
  redactError: (error: unknown, roots: string[]) => string;
};

const target = {
  id: 'fixture-ui',
  repository: 'https://github.com/example/fixture-ui.git',
  sha: 'a'.repeat(40),
  componentsDir: 'packages/react/src/components',
  expected: {
    status: 'partial',
    minScore: 75,
    maxScore: 100,
    minComponents: 10,
    maxComponents: 20,
    minProps: 30,
  },
};

function readinessReport() {
  return {
    schemaVersion: 'userface-readiness@1',
    status: 'partial',
    score: 77,
    repo: { framework: 'react' },
    components: { discovered: 15, props: 45, contracted: 0 },
    tokenStyleRisks: { status: 'passed' },
    guard: { offlineCore: true, canRun: true },
    proof: {
      id: 'ufp_fixture',
      repo: { commit: target.sha },
      egress: {
        mode: 'offline',
        measurement: 'zero_upload',
        modelCalls: 0,
        filesSent: 0,
        bytesSent: 0,
        absolutePathsSent: false,
        remoteTelemetry: false,
        network: false,
      },
    },
  };
}

describe('external React readiness release gate', () => {
  it('pins diverse public targets with bounded quality expectations', () => {
    const manifest = loadManifest(resolve(__dirname, '../../../../scripts/evals/external-react-readiness.targets.json'));

    expect(manifest.targets.map((entry) => entry.id)).toEqual([
      'radix-themes',
      'chakra-ui',
      'mantine',
      'patternfly-react',
      'shadcn-ui',
    ]);
    for (const entry of manifest.targets) {
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.expected.minComponents).toBeGreaterThan(0);
      expect(entry.expected.maxComponents).toBeGreaterThanOrEqual(entry.expected.minComponents);
      expect(entry.expected.minProps).toBeGreaterThan(0);
      expect(entry.expected.status).toBe('blocked');
      expect(entry.expected.maxScore).toBeLessThanOrEqual(55);
    }
  });

  it('passes only a pinned React report with strict zero egress', () => {
    const result = evaluateReadiness(target, readinessReport(), 'local', 25);

    expect(result).toMatchObject({
      id: 'fixture-ui',
      status: 'passed',
      mode: 'local',
      metrics: { components: 15, props: 45, styleStatus: 'passed' },
      proof: { modelCalls: 0, filesSent: 0, bytesSent: 0, network: false },
      assertions: { passed: 12, total: 12 },
      failures: [],
    });
  });

  it('fails component regressions and any claimed network egress', () => {
    const report = readinessReport();
    report.components.props = 0;
    report.proof.egress.network = true;
    const result = evaluateReadiness(target, report, 'local', 25);

    expect(result.status).toBe('failed');
    expect(result.failures.map((failure: { id: string }) => failure.id)).toEqual(['props', 'zero-egress']);
  });

  it('creates an aggregate receipt without checkout paths', () => {
    const result = evaluateReadiness(target, readinessReport(), 'local', 25);
    const receipt = createReceipt([result], '0.1.0', 1_000, 1_025);
    const serialized = JSON.stringify(receipt);

    expect(receipt).toMatchObject({
      schemaVersion: 'userface-external-readiness-eval@1',
      status: 'passed',
      totals: { targets: 1, passed: 1, failed: 0, components: 15, props: 45 },
    });
    expect(serialized).not.toContain('/tmp/');
    expect(serialized).not.toContain('/Users/');
  });

  it('redacts transient checkout paths from execution failures', () => {
    const root = '/tmp/userface-external-readiness-secret/target';
    expect(redactError(new Error(`failed in ${root}/package.json`), [root])).toBe('failed in <checkout>/package.json');
  });
});
