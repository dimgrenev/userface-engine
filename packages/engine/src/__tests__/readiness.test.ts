import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createReadinessReport, renderReadinessReportMarkdown } from '../readiness';

let tmpRoot: string | null = null;

function createFixture(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'userface-readiness-'));
  mkdirSync(join(tmpRoot, 'src/components/Button'), { recursive: true });
  mkdirSync(join(tmpRoot, 'src/app'), { recursive: true });
  mkdirSync(join(tmpRoot, 'src/screens'), { recursive: true });
  writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({
    dependencies: {
      next: '15.0.0',
      react: '18.3.1',
    },
    devDependencies: {
      typescript: '5.0.0',
    },
  }, null, 2));
  writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
  writeFileSync(join(tmpRoot, 'src/app/globals.css'), ':root { --color-accent: #2f6df6; --radius-control: 6px; }');
  writeFileSync(join(tmpRoot, 'src/components/Button/Button.tsx'), 'export function Button(props: { variant?: "primary" | "secondary" }) { return <button>{props.variant}</button>; }');
  writeFileSync(join(tmpRoot, 'src/components/Button/face.json'), JSON.stringify({
    name: 'Button',
    props: {
      variant: {
        type: 'enum',
        options: ['primary', 'secondary'],
      },
    },
    states: [{ name: 'Default', props: { variant: 'primary' } }],
  }, null, 2));
  writeFileSync(join(tmpRoot, 'src/screens/home.json'), JSON.stringify({
    version: 'ui@1',
    root: {
      type: 'Button',
      props: { variant: 'primary' },
    },
  }, null, 2));
  return tmpRoot;
}

function createExternalStyleFixture(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'userface-readiness-external-'));
  mkdirSync(join(tmpRoot, 'src/ui/Button'), { recursive: true });
  mkdirSync(join(tmpRoot, 'src/ui/Card'), { recursive: true });
  mkdirSync(join(tmpRoot, 'screens'), { recursive: true });
  writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({
    scripts: {
      dev: 'vite --host 127.0.0.1',
    },
    dependencies: {
      '@vitejs/plugin-react': 'latest',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      typescript: '5.0.0',
      vite: 'latest',
    },
  }, null, 2));
  writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
  writeFileSync(join(tmpRoot, 'tailwind.config.ts'), 'export default { content: ["./src/**/*.{ts,tsx}"] };\n');
  writeFileSync(join(tmpRoot, 'src/ui/Button/Button.tsx'), [
    'export type ButtonTone = "primary" | "secondary";',
    'export interface ButtonProps {',
    '  tone?: ButtonTone;',
    '  children?: string;',
    '}',
    '',
    'export function Button({ tone = "primary", children = "Continue" }: ButtonProps) {',
    '  return <button data-tone={tone}>{children}</button>;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(tmpRoot, 'src/ui/Card/Card.tsx'), [
    'export interface CardProps {',
    '  title?: string;',
    '  children?: React.ReactNode;',
    '}',
    '',
    'export function Card({ title, children }: CardProps) {',
    '  return <section>{title ? <h2>{title}</h2> : null}{children}</section>;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(tmpRoot, 'screens/account.json'), JSON.stringify({
    version: 'ui@1',
    root: {
      type: 'Card',
      props: { title: 'Account' },
      children: [
        { type: 'Button', props: { tone: 'primary', children: 'Update plan' } },
      ],
    },
  }, null, 2));
  return tmpRoot;
}

function createConfiguredReadinessFixture(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'userface-readiness-configured-'));
  mkdirSync(join(tmpRoot, 'packages/app-ui/Hero'), { recursive: true });
  mkdirSync(join(tmpRoot, 'src/app'), { recursive: true });
  mkdirSync(join(tmpRoot, 'screens'), { recursive: true });
  writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({
    dependencies: {
      react: '18.3.1',
    },
    devDependencies: {
      typescript: '5.0.0',
    },
  }, null, 2));
  writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
  writeFileSync(join(tmpRoot, 'src/app/globals.css'), ':root { --color-accent: #2f6df6; }\n');
  writeFileSync(join(tmpRoot, 'packages/app-ui/Hero/Hero.tsx'), [
    'export interface HeroProps {',
    '  title: string;',
    '}',
    'export function Hero({ title }: HeroProps) {',
    '  return <section>{title}</section>;',
    '}',
  ].join('\n'));
  writeFileSync(join(tmpRoot, 'packages/app-ui/Hero/Hero.json'), JSON.stringify({
    name: 'Hero',
    props: {
      title: { type: 'string', required: true },
    },
    states: [
      { name: 'Default', props: { title: 'Build UI' } },
    ],
  }, null, 2));
  writeFileSync(join(tmpRoot, 'screens/home.ui.json'), JSON.stringify({
    version: 'ui@1',
    root: {
      type: 'Hero',
      props: { title: 'Build UI' },
    },
  }, null, 2));
  writeFileSync(join(tmpRoot, 'userface.config.json'), JSON.stringify({
    readiness: {
      componentsDir: 'packages/app-ui',
      uiDocuments: ['screens/home.ui.json'],
    },
  }, null, 2));
  return tmpRoot;
}

function repoRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(join('packages', 'engine'))) return resolve(cwd, '../..');
  return cwd;
}

function runCli(args: string[], cwd: string, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [
    resolve(repoRoot(), 'node_modules/tsx/dist/cli.mjs'),
    resolve(repoRoot(), 'packages/engine/src/cli.ts'),
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
  expect(result.status, result.stderr || result.stdout).toBe(expectedStatus);
  return result;
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

describe('readiness report', () => {
  it('reports a ready React TypeScript repo with component contracts and ui documents', () => {
    const root = createFixture();
    const report = createReadinessReport({ root });

    expect(report.schemaVersion).toBe('userface-readiness@1');
    expect(report.status).toBe('ready');
    expect(report.repo.framework).toBe('react');
    expect(report.repo.typescript).toBe(true);
    expect(report.components.discovered).toBe(1);
    expect(report.components.contracted).toBe(1);
    expect(report.uiDocuments.discovered).toBe(1);
    expect(report.guard.canRun).toBe(true);
    expect(report.pilot).toEqual(expect.objectContaining({
      verdict: 'ready',
      canRunFirstScreenPilot: true,
    }));
    expect(report.components.safe).toEqual([
      expect.objectContaining({
        name: 'Button',
        path: 'src/components/Button',
      }),
    ]);
    expect(report.components.unsafe).toEqual([]);
    expect(report.tokenStyleRisks.status).toBe('passed');
    expect(report.renderPreviewReadiness.status).toBe('passed');
    expect(report.proof.schema).toBe('userface-proof@1');
    expect(report.proof.status).toBe('passed');
    expect(report.proof.egress.modelCalls).toBe(0);
  });

  it('keeps default ui@1 discovery focused on product screens, not fixtures or dependencies', () => {
    const root = createFixture();
    mkdirSync(join(root, 'fixtures'), { recursive: true });
    mkdirSync(join(root, 'node_modules/@demo/package/screens'), { recursive: true });
    writeFileSync(join(root, 'fixtures/broken.json'), JSON.stringify({
      version: 'ui@1',
      root: { type: 'MissingFixtureComponent' },
    }, null, 2));
    writeFileSync(join(root, 'node_modules/@demo/package/screens/dependency.json'), JSON.stringify({
      version: 'ui@1',
      root: { type: 'DependencyComponent' },
    }, null, 2));

    const report = createReadinessReport({ root });

    expect(report.uiDocuments).toEqual({
      discovered: 1,
      sample: ['src/screens/home.json'],
    });
    expect(report.firstScreen.candidate).toBe('src/screens/home.json');
  });

  it('reports a limited pilot for an external-style React repo with TypeScript prop signal but weak curated contract coverage', () => {
    const root = createExternalStyleFixture();
    const report = createReadinessReport({ root });

    expect(report.status).toBe('partial');
    expect(report.repo.framework).toBe('react');
    expect(report.components.root).toBe(join(root, 'src/ui'));
    expect(report.components.discovered).toBe(2);
    expect(report.components.contracted).toBe(0);
    expect(report.components.contractCoverage).toBe(0);
    expect(report.components.props).toBeGreaterThan(0);
    expect(report.uiDocuments.sample).toEqual(['screens/account.json']);
    expect(report.composition.status).toBe('passed');
    expect(report.pilot).toEqual(expect.objectContaining({
      verdict: 'limited',
      canRunFirstScreenPilot: true,
    }));
    expect(report.pilot.summary).toContain('limited first-screen pilot');
    expect(report.pilot.requiredFixes.join('\n')).toContain('face.json');
    expect(report.checks.find((check) => check.id === 'contracts')?.status).toBe('failed');
  });

  it('blocks repos without framework and component discovery', () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'userface-readiness-empty-'));
    writeFileSync(join(tmpRoot, 'package.json'), '{}');

    const report = createReadinessReport({ root: tmpRoot });

    expect(report.status).toBe('blocked');
    expect(report.checks.find((check) => check.id === 'framework')?.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'components')?.status).toBe('failed');
    expect(report.tokenStyleRisks.status).toBe('warning');
    expect(report.renderPreviewReadiness.status).toBe('warning');
    expect(report.pilot).toEqual(expect.objectContaining({
      verdict: 'blocked',
      canRunFirstScreenPilot: false,
    }));
    expect(report.pilot.blockers).toEqual(expect.arrayContaining([
      'No supported React framework signal was detected.',
      'No component library was discovered.',
    ]));
    expect(report.recommendation.nextSteps.length).toBeGreaterThan(0);
  });

  it('renders buyer-readable markdown', () => {
    const root = createFixture();
    const markdown = renderReadinessReportMarkdown(createReadinessReport({ root }));

    expect(markdown).toContain('# Userface Readiness');
    expect(markdown).toContain('Status: ready');
    expect(markdown).toContain('Proof: ufp_');
    expect(markdown).toContain('Contract coverage: 100%');
    expect(markdown).toContain('## Pilot Feasibility');
    expect(markdown).toContain('Pilot verdict: ready');
    expect(markdown).toContain('## Safe Components');
    expect(markdown).toContain('- Button (src/components/Button)');
    expect(markdown).toContain('## Token/Style Risks');
    expect(markdown).toContain('## Render/Preview Readiness');
  });

  it('persists buyer-grade readiness artifacts under .userface/readiness when requested', () => {
    const root = createFixture();
    const result = runCli(['readiness', '--root', '.', '--write', '--format', 'summary'], root);
    const jsonPath = join(root, '.userface/readiness/userface-readiness-report.json');
    const markdownPath = join(root, '.userface/readiness/userface-readiness-report.md');

    expect(result.stdout).toContain('# Userface Readiness');
    expect(result.stderr).toContain('Readiness JSON: .userface/readiness/userface-readiness-report.json');
    expect(result.stderr).toContain('Readiness Markdown: .userface/readiness/userface-readiness-report.md');
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPath)).toBe(true);
    expect(JSON.parse(readFileSync(jsonPath, 'utf8'))).toEqual(expect.objectContaining({
      schemaVersion: 'userface-readiness@1',
      status: 'ready',
    }));
    expect(readFileSync(markdownPath, 'utf8')).toContain('Status: ready');
  });

  it('uses userface.config.json readiness defaults when CLI flags are omitted', () => {
    const root = createConfiguredReadinessFixture();
    const result = runCli(['readiness', '--no-write', '--format', 'json'], root);
    const report = JSON.parse(result.stdout);

    expect(report.status).toBe('ready');
    expect(report.components.root).toMatch(/packages[\\/]app-ui$/);
    expect(report.components.discovered).toBe(1);
    expect(report.components.contracted).toBe(1);
    expect(report.uiDocuments.sample).toEqual(['screens/home.ui.json']);
    expect(report.firstScreen.candidate).toBe('screens/home.ui.json');
  });

  it('uses readiness registry defaults when guard validates a ui@1 document', () => {
    const root = createConfiguredReadinessFixture();
    const result = runCli(['guard', 'screens/home.ui.json', '--offline', '--format', 'json'], root);
    const proof = JSON.parse(result.stdout);

    expect(proof.status).toBe('passed');
    expect(proof.components).toEqual({
      total: 1,
      contracted: 1,
      used: ['Hero'],
    });
    expect(proof.composition.status).toBe('passed');
    expect(proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      network: false,
    }));
  });
});
