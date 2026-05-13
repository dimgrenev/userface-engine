import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

function makeProjectFixture() {
  const root = mkdtempSync(join(tmpdir(), 'userface-engine-mcp-design-tokens-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'design-token-fixture' }));
  return root;
}

function installFaceUiReactFixture(root: string) {
  const packageRoot = join(root, 'node_modules', '@userface', 'face-ui-react');
  const tokensDir = join(packageRoot, 'dist', 'esm', 'assets', 'styles');
  mkdirSync(tokensDir, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@userface/face-ui-react',
    type: 'module',
    exports: {
      './assets/*': './dist/esm/assets/*',
      './package.json': './package.json',
    },
  }, null, 2));
  writeFileSync(join(tokensDir, 'tokens.css'), [
    ':root {',
    '  --uf-bg: #ffffff;',
    '  --uf-space-2: 8px;',
    '  --uf-radius-sm: 2px;',
    '}',
    '',
  ].join('\n'));
}

function installFaceUiReactPackageWithoutTokens(root: string) {
  const packageRoot = join(root, 'node_modules', '@userface', 'face-ui-react');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@userface/face-ui-react',
    type: 'module',
    exports: {
      './assets/*': './dist/esm/assets/*',
      './package.json': './package.json',
    },
  }, null, 2));
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

describe('MCP design_tokens path resolution', () => {
  it('resolves published package assets through @userface/face-ui-react exports', async () => {
    const root = makeProjectFixture();
    installFaceUiReactFixture(root);
    const mcp = startMcp(root);

    try {
      const response = await mcp.request('tools/call', {
        name: 'design_tokens',
        arguments: { category: 'colors' },
      });
      const result = mcpText(response);

      expect(result.tokens['--uf-bg']).toBe('#ffffff');
    } finally {
      await mcp.close();
    }
  });

  it('returns an actionable error when tokens.css cannot be resolved', async () => {
    const root = makeProjectFixture();
    installFaceUiReactPackageWithoutTokens(root);
    const mcp = startMcp(root);

    try {
      const response = await mcp.request('tools/call', {
        name: 'design_tokens',
        arguments: {},
      });
      const result = mcpText(response);

      expect(result.error).toContain('@userface/face-ui-react assets/styles/tokens.css');
      expect(result.error).toContain('package resolution');
      expect(result.error).toContain('monorepo packages/face-ui-react');
      expect(result.error).toContain('node_modules');
    } finally {
      await mcp.close();
    }
  });
});
