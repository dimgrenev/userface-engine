import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { USERFACE_PROOF_JSON_SCHEMA, validateUserfaceProof } from '../proof';

const REGISTRY_BOUNDARY_RULE_ID = 'composition/registry-boundary-non-public-component';
const tempRoots: string[] = [];

function repoRoot(): string {
  const cwd = process.cwd();
  if (cwd.endsWith(join('packages', 'engine'))) return resolve(cwd, '../..');
  return cwd;
}

function tsxCliPath(): string {
  return resolve(repoRoot(), 'node_modules/tsx/dist/cli.mjs');
}

function engineCliPath(): string {
  return resolve(repoRoot(), 'packages/engine/src/cli.ts');
}

function writeFixtureComponent(packageRoot: string, name: string) {
  mkdirSync(join(packageRoot, name), { recursive: true });
  writeFileSync(join(packageRoot, name, `${name}.tsx`), `export function ${name}() { return null; }\n`);
  writeFileSync(join(packageRoot, name, `${name}.json`), JSON.stringify({ name }));
}

function makeBoundaryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'userface-engine-cli-mcp-boundary-'));
  tempRoots.push(root);

  const packageRoot = join(root, 'packages', 'uf');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@demo/uf' }));
  writeFixtureComponent(packageRoot, 'PublicPanel');
  writeFixtureComponent(packageRoot, 'PrivatePanel');
  writeFileSync(join(packageRoot, 'component-registry.json'), JSON.stringify({
    version: 1,
    package: '@demo/uf',
    defaultRegistryVisibility: 'private',
    components: {
      PublicPanel: {
        registryVisibility: 'public',
        entry: './PublicPanel/PublicPanel.tsx',
        contract: './PublicPanel/PublicPanel.json',
      },
      PrivatePanel: {
        registryVisibility: 'private',
        entry: './PrivatePanel/PrivatePanel.tsx',
        contract: './PrivatePanel/PrivatePanel.json',
      },
    },
  }, null, 2));

  const doc = {
    schema: 'face',
    'schema-version': 1,
    root: {
      type: 'Card',
      children: [
        { type: 'Accordion' },
        { type: 'PublicPanel' },
        { type: 'PrivatePanel' },
      ],
    },
  };
  writeFileSync(join(root, 'screen.ui.json'), JSON.stringify(doc, null, 2));

  return {
    root,
    doc,
    manifestPath: 'packages/uf/component-registry.json',
  };
}

function makeRegistryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'userface-engine-cli-mcp-registry-'));
  tempRoots.push(root);

  const shallowDir = join(root, 'components', 'Shallow');
  mkdirSync(shallowDir, { recursive: true });
  writeFileSync(join(shallowDir, 'Shallow.tsx'), 'export function Shallow() { return null; }\n');

  const nestedDir = join(root, 'components', 'groups', 'Nested');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, 'Nested.tsx'), 'export function Nested() { return null; }\n');

  return root;
}

function makeComponentSourceFixture() {
  const root = mkdtempSync(join(resolve(repoRoot(), 'packages/engine'), '.tmp-userface-engine-guard-source-'));
  tempRoots.push(root);

  mkdirSync(join(root, 'src/components/Input'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'guard-source-fixture',
    private: true,
    dependencies: {
      react: '^19.0.0',
    },
  }, null, 2));
  writeFileSync(join(root, 'src/components/Input/Input.tsx'), [
    'export interface InputProps {',
    '  value?: string;',
    '  onValueChange?: (value: string) => void;',
    '}',
    '',
    'export function Input({ value }: InputProps) {',
    '  return <input value={value} readOnly />;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'src/components/Input/face.json'), JSON.stringify({ name: 'Input' }, null, 2));

  mkdirSync(join(root, 'src/components/Text'), { recursive: true });
  writeFileSync(join(root, 'src/components/Text/Text.tsx'), [
    'export interface TextProps {',
    '  children: string;',
    '  tone?: "default" | "muted";',
    '}',
    '',
    'export function Text({ children }: TextProps) {',
    '  return <span>{children}</span>;',
    '}',
    '',
  ].join('\n'));

  return root;
}

function makeConnectFixture() {
  const root = mkdtempSync(join(resolve(repoRoot(), 'packages/engine'), '.tmp-userface-engine-connect-'));
  tempRoots.push(root);

  mkdirSync(join(root, 'src/components/Button'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'connect-fixture',
    private: true,
    dependencies: {
      react: '^19.0.0',
    },
  }, null, 2));
  writeFileSync(join(root, 'src/components/Button/Button.tsx'), [
    'export interface ButtonProps {',
    '  label?: string;',
    '}',
    '',
    'export function Button({ label = "Button" }: ButtonProps) {',
    '  return <button>{label}</button>;',
    '}',
    '',
  ].join('\n'));

  return root;
}

function runCli(cwd: string, args: string[]) {
  const result = runCliRaw(cwd, args);

  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

function runCliRaw(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCliPath(), engineCliPath(), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });
}

function boundaryComponents(report: any): string[] {
  return (report.violations || [])
    .filter((violation: any) => violation?.ruleId === REGISTRY_BOUNDARY_RULE_ID)
    .map((violation: any) => violation?.location?.component);
}

function commitFixture(root: string) {
  expect(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status).toBe(0);
  expect(spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' }).status).toBe(0);
  expect(spawnSync('git', [
    '-c',
    'user.email=userface@example.test',
    '-c',
    'user.name=Userface Test',
    'commit',
    '-m',
    'initial fixture',
  ], { cwd: root, encoding: 'utf8' }).status).toBe(0);
}

function startMcp(cwd: string) {
  const child = spawn(process.execPath, [tsxCliPath(), engineCliPath(), 'mcp-serve'], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  let nextId = 1;
  let stdoutBuffer = '';
  const pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });

  child.on('exit', (code, signal) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`MCP server exited before response (code=${code}, signal=${signal})`));
    }
    pending.clear();
  });

  return {
    request(method: string, params?: Record<string, unknown>): Promise<any> {
      const id = nextId++;
      const payload = { jsonrpc: '2.0', id, method, params };
      return new Promise((resolveResponse, rejectResponse) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectResponse(new Error(`Timed out waiting for MCP response to ${method}`));
        }, 5000);
        pending.set(id, { resolve: resolveResponse, reject: rejectResponse, timer });
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    },
    async close() {
      child.stdin.end();
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(() => {
          child.kill();
          resolveClose();
        }, 500);
        child.once('close', () => {
          clearTimeout(timer);
          resolveClose();
        });
      });
    },
  };
}

function mcpText(response: any): any {
  expect(response.error).toBeUndefined();
  const text = response.result?.content?.[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('engine CLI and MCP registry-boundary defaults', () => {
  it('shows global help for subcommand --help without executing the subcommand', () => {
    const fixture = makeBoundaryFixture();

    for (const command of ['readiness', 'guard', 'trust']) {
      const result = runCliRaw(fixture.root, [command, '--help']);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toContain('Userface CLI');
      expect(result.stderr).toContain(`userface ${command}`);
      expect(result.stdout).toBe('');
    }
  });

  it('keeps CLI registry-boundary validation default-off and opt-in only', () => {
    const fixture = makeBoundaryFixture();

    const defaultReport = JSON.parse(runCli(fixture.root, [
      'composition-validate',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
    ]));
    expect(boundaryComponents(defaultReport)).toEqual([]);

    const enforcedReport = JSON.parse(runCli(fixture.root, [
      'composition-validate',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--enforce-registry-boundary',
    ]));
    expect(boundaryComponents(enforcedReport)).toEqual(['PrivatePanel']);
  });

  it('makes composition-validate fail when configured severity threshold is met', () => {
    const fixture = makeBoundaryFixture();

    const result = runCliRaw(fixture.root, [
      'composition-validate',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--enforce-registry-boundary',
      '--fail-on',
      'warning',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(boundaryComponents(report)).toEqual(['PrivatePanel']);
  });

  it('emits Userface Proof and fails guard when configured violations block the UI', () => {
    const fixture = makeBoundaryFixture();
    const proofPath = join(fixture.root, 'userface-proof.json');
    const summaryPath = join(fixture.root, 'userface-proof.md');

    const result = runCliRaw(fixture.root, [
      'guard',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--enforce-registry-boundary',
      '--offline',
      '--fail-on',
      'warning',
      '--proof',
      proofPath,
      '--summary',
      summaryPath,
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    expect(proof.schema).toBe('userface-proof@1');
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.repo.rootHash).toMatch(/^sha256:/);
    expect(proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
    expect(boundaryComponents({ violations: proof.composition.violations })).toEqual(['PrivatePanel']);
    expect(readFileSync(summaryPath, 'utf8')).toContain('Userface Proof');
  });

  it('persists guard proof artifacts under .userface/proofs when requested', () => {
    const fixture = makeBoundaryFixture();

    const result = runCliRaw(fixture.root, [
      'guard',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--offline',
      '--fail-on',
      'warning',
      '--write',
      '--format',
      'summary',
    ]);
    const proofPath = join(fixture.root, '.userface/proofs/userface-proof.json');
    const summaryPath = join(fixture.root, '.userface/proofs/userface-proof.md');

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('# Userface Proof');
    expect(result.stderr).toContain('Guard Proof JSON: .userface/proofs/userface-proof.json');
    expect(result.stderr).toContain('Guard Proof Markdown: .userface/proofs/userface-proof.md');
    expect(existsSync(proofPath)).toBe(true);
    expect(existsSync(summaryPath)).toBe(true);
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('passed');
    expect(readFileSync(summaryPath, 'utf8')).toContain('Status: passed');
  });

  it('honors guard policy from --config without requiring duplicated CI flags', () => {
    const fixture = makeBoundaryFixture();
    writeFileSync(join(fixture.root, 'userface.guard.json'), JSON.stringify({
      paths: ['screen.ui.json'],
      registryManifest: fixture.manifestPath,
      enforceRegistryBoundary: true,
      offline: true,
      failOn: 'warning',
      proof: 'configured-proof.json',
      summary: 'configured-proof.md',
    }, null, 2));

    const result = runCliRaw(fixture.root, [
      'guard',
      '--config',
      'userface.guard.json',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(readFileSync(join(fixture.root, 'configured-proof.json'), 'utf8'));
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
    expect(boundaryComponents({ violations: proof.composition.violations })).toEqual(['PrivatePanel']);
    expect(readFileSync(join(fixture.root, 'configured-proof.md'), 'utf8')).toContain('Status: blocked');
  });

  it('emits passing Userface Proof for valid guard input', () => {
    const fixture = makeBoundaryFixture();

    const proof = JSON.parse(runCli(fixture.root, [
      'guard',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--offline',
      '--fail-on',
      'warning',
    ]));

    expect(proof.schema).toBe('userface-proof@1');
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('passed');
    expect(proof.composition.status).toBe('passed');
  });

  it('attaches hashed preview artifacts to guard proof when render evidence is available', () => {
    const fixture = makeBoundaryFixture();
    writeFileSync(join(fixture.root, 'preview.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>');

    const proof = JSON.parse(runCli(fixture.root, [
      'guard',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--offline',
      '--fail-on',
      'warning',
      '--preview-artifact',
      'preview.svg',
    ]));

    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('passed');
    expect(proof.preview.status).toBe('passed');
    expect(proof.preview.artifacts).toEqual([
      expect.stringMatching(/^preview\.svg#sha256:[a-f0-9]{64}$/),
    ]);
  });

  it('blocks --changed when only registry/config/token inputs changed and no concrete target is known', () => {
    const fixture = makeBoundaryFixture();
    commitFixture(fixture.root);
    writeFileSync(join(fixture.root, 'component-registry.json'), JSON.stringify({
      changed: true,
    }, null, 2));

    const result = runCliRaw(fixture.root, [
      'guard',
      '--changed',
      '--offline',
      '--fail-on',
      'warning',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(result.stdout);
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.validation.violations.map((violation: any) => violation.ruleId)).toContain('guard/changed-input-needs-target');
  });

  it('discovers changed face documents and emits guard proof without explicit targets', () => {
    const fixture = makeBoundaryFixture();
    commitFixture(fixture.root);
    const changedDoc = {
      schema: 'face',
      'schema-version': 1,
      root: {
        type: 'Card',
        children: [
          { type: 'PublicPanel' },
          { type: 'PrivatePanel' },
        ],
      },
    };
    writeFileSync(join(fixture.root, 'screen.ui.json'), JSON.stringify(changedDoc, null, 2));

    const result = runCliRaw(fixture.root, [
      'guard',
      '--changed',
      '--registry-manifest',
      fixture.manifestPath,
      '--enforce-registry-boundary',
      '--offline',
      '--fail-on',
      'warning',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(result.stdout);
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.target.paths).toEqual(['screen.ui.json']);
    expect(proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
    expect(boundaryComponents({ violations: proof.composition.violations })).toEqual(['PrivatePanel']);
  });

  it('generates Cursor MCP config with the buyer-facing userface command', () => {
    const root = makeConnectFixture();
    const result = runCliRaw(root, ['connect', '--root', 'src/components']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const mcp = JSON.parse(readFileSync(join(root, '.cursor/mcp.json'), 'utf8'));
    expect(mcp.mcpServers?.userface).toEqual({
      command: 'npx',
      args: ['userface', 'mcp-serve'],
    });
  });

  it('blocks guard proof when requested preview evidence is missing', () => {
    const fixture = makeBoundaryFixture();

    const result = runCliRaw(fixture.root, [
      'guard',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--offline',
      '--fail-on',
      'warning',
      '--preview-artifact',
      'missing.svg',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(result.stdout);
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.preview.status).toBe('failed');
    expect(proof.preview.reason).toContain('missing.svg');
  });

  it('runs component-source validation inside guard proof', () => {
    const root = makeComponentSourceFixture();

    const result = runCliRaw(root, [
      'guard',
      'src/components/Input',
      '--offline',
      '--fail-on',
      'warning',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(result.stdout);
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.composition.status).toBe('not_run');
    expect(proof.validation.status).toBe('failed');
    expect(proof.validation.violations.map((violation: any) => violation.ruleId)).toContain('a11y/input-label');
    expect(proof.validation.violations[0].location.file).toBe('src/components/Input');
    expect(proof.components.used).toContain('Input');
  });

  it('treats component contract JSON targets as component-source guard targets', () => {
    const root = makeComponentSourceFixture();

    const result = runCliRaw(root, [
      'guard',
      'src/components/Input/face.json',
      '--offline',
      '--fail-on',
      'warning',
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    const proof = JSON.parse(result.stdout);
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('blocked');
    expect(proof.composition.status).toBe('not_run');
    expect(proof.validation.status).toBe('failed');
    expect(proof.validation.violations.map((violation: any) => violation.ruleId)).toContain('a11y/input-label');
    expect(proof.components.used).toContain('Input');
  });

  it('passes component-source guard targets when validation has no blocking issues', () => {
    const root = makeComponentSourceFixture();

    const proof = JSON.parse(runCli(root, [
      'guard',
      'src/components/Text',
      '--offline',
      '--fail-on',
      'warning',
    ]));

    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('passed');
    expect(proof.composition.status).toBe('not_run');
    expect(proof.validation.status).toBe('passed');
    expect(proof.components.used).toContain('Text');
  });

  it('emits GitHub annotations for guard violations while preserving proof artifacts', () => {
    const fixture = makeBoundaryFixture();
    const proofPath = join(fixture.root, 'userface-proof.json');

    const result = runCliRaw(fixture.root, [
      'guard',
      'screen.ui.json',
      '--registry-manifest',
      fixture.manifestPath,
      '--enforce-registry-boundary',
      '--offline',
      '--fail-on',
      'warning',
      '--format',
      'github-annotations',
      '--proof',
      proofPath,
    ]);

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stdout).toContain('::warning file=');
    expect(result.stdout).toContain('file=screen.ui.json');
    expect(result.stdout).toContain('composition/registry-boundary-non-public-component');
    const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
    expect(proof.composition.violations[0].location.file).toBe('screen.ui.json');
    expect(proof.pr).toEqual(expect.objectContaining({
      provider: 'github',
      annotations: 1,
    }));
  });

  it('emits offline trust proof without model or network work', () => {
    const fixture = makeBoundaryFixture();
    const proof = JSON.parse(runCli(fixture.root, [
      'trust',
      '--offline',
    ]));

    expect(proof.schema).toBe('userface-proof@1');
    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('passed');
    expect(proof.target.kind).toBe('trust');
    expect(proof.egress).toEqual(expect.objectContaining({
      mode: 'offline',
      modelCalls: 0,
      filesSent: 0,
      bytesSent: 0,
      network: false,
    }));
  });

  it('prints the public userface-proof@1 JSON Schema', () => {
    const schema = JSON.parse(runCli(process.cwd(), ['proof-schema']));
    const packageSchema = JSON.parse(readFileSync(
      resolve(repoRoot(), 'packages/engine/src/userface-proof.schema.json'),
      'utf8',
    ));

    expect(schema).toEqual(USERFACE_PROOF_JSON_SCHEMA);
    expect(packageSchema).toEqual(USERFACE_PROOF_JSON_SCHEMA);
    expect(schema.$id).toBe('https://userface.dev/schemas/userface-proof@1.json');
    expect(schema.properties.schema.const).toBe('userface-proof@1');
    expect(schema.required).toContain('egress');
    expect(schema.properties.egress.properties.providerId).toEqual({ type: 'string', minLength: 1 });
    expect(schema.properties.egress.properties.model).toEqual({ type: 'string', minLength: 1 });
    expect(schema.properties.egress.required).toContain('measurement');
    expect(schema.properties.egress.allOf[0].then.required).toContain('reason');
    expect(schema.$defs.check.allOf[0].then.required).toContain('reason');
    expect(schema.properties.preview.allOf[0].then.required).toContain('reason');
  });

  it('rejects ambiguous proof status, target kind, egress mode and missing unavailable reasons', () => {
    const fixture = makeBoundaryFixture();
    const proof = JSON.parse(runCli(fixture.root, [
      'trust',
      '--offline',
    ]));
    proof.status = 'ok';
    proof.target.kind = 'chat';
    proof.egress.mode = 'remote';
    proof.egress.measurement = 'unavailable';
    delete proof.egress.reason;
    proof.egress.providerId = '';
    proof.egress.dataClasses = ['system_prompt', ''];
    proof.validation.status = 'unavailable';
    delete proof.validation.reason;

    const result = validateUserfaceProof(proof);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'status must be a known proof status',
      'target.kind must be a known target kind',
      'egress.mode must be offline, local or cloud',
      'egress.reason must explain unavailable measurement',
      'egress.providerId must be a non-empty string',
      'egress.dataClasses must contain non-empty strings',
      'validation.reason must explain unavailable',
    ]));
  });

  it('keeps CLI registry scans shallow unless recursive adoption is explicit in the API layer', () => {
    const root = makeRegistryFixture();

    const index = JSON.parse(runCli(root, ['registry', 'scan', 'components']));

    expect(index.components.map((component: any) => component.name)).toEqual(['Shallow']);
  });

  it('keeps MCP registry-boundary validation default-off and opt-in only', async () => {
    const fixture = makeBoundaryFixture();
    const mcp = startMcp(fixture.root);

    try {
      const defaultResponse = await mcp.request('tools/call', {
        name: 'composition_validate',
        arguments: {
          doc: fixture.doc,
          registryManifestPath: fixture.manifestPath,
        },
      });
      expect(boundaryComponents(mcpText(defaultResponse))).toEqual([]);

      const enforcedResponse = await mcp.request('tools/call', {
        name: 'composition_validate',
        arguments: {
          doc: fixture.doc,
          registryManifestPath: fixture.manifestPath,
          enforceRegistryBoundary: true,
        },
      });
      expect(boundaryComponents(mcpText(enforcedResponse))).toEqual(['PrivatePanel']);
    } finally {
      await mcp.close();
    }
  });

  it('keeps MCP component_list shallow by default', async () => {
    const root = makeRegistryFixture();
    const mcp = startMcp(root);

    try {
      const response = await mcp.request('tools/call', {
        name: 'component_list',
        arguments: { dir: 'components' },
      });
      const list = mcpText(response);

      expect(list.components.map((component: any) => component.name)).toEqual(['Shallow']);
    } finally {
      await mcp.close();
    }
  });
});
