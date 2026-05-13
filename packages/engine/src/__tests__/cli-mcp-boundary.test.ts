import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
    version: 'ui@1',
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

function runCli(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, [tsxCliPath(), engineCliPath(), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });

  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

function boundaryComponents(report: any): string[] {
  return (report.violations || [])
    .filter((violation: any) => violation?.ruleId === REGISTRY_BOUNDARY_RULE_ID)
    .map((violation: any) => violation?.location?.component);
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
