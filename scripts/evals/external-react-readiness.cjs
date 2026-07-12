#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, isAbsolute, join, relative, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '../..');
const DEFAULT_MANIFEST = join(__dirname, 'external-react-readiness.targets.json');
const ENGINE_CLI = join(REPO_ROOT, 'packages/engine/dist/esm/cli.js');
const ENGINE_PACKAGE = join(REPO_ROOT, 'packages/engine/package.json');

function usage() {
  return [
    'External React readiness release gate',
    '',
    'Usage:',
    '  pnpm eval:external-react [options]',
    '',
    'Options:',
    '  --target <id>             Run only one target; may be repeated',
    '  --checkout <id>=<path>    Reuse an exact pinned local checkout',
    '  --manifest <path>         Override the target manifest',
    '  --output <path>           Atomically write the JSON receipt',
    '  --keep-checkouts          Keep checkouts cloned by this run',
    '  --help                    Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    targets: [],
    checkouts: new Map(),
    manifest: DEFAULT_MANIFEST,
    output: '',
    keepCheckouts: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--target') {
      const id = argv[++index];
      if (!id) throw new Error('--target requires an id');
      options.targets.push(id);
      continue;
    }
    if (arg === '--checkout') {
      const assignment = argv[++index] || '';
      const separator = assignment.indexOf('=');
      if (separator < 1 || separator === assignment.length - 1) {
        throw new Error('--checkout requires <id>=<path>');
      }
      options.checkouts.set(assignment.slice(0, separator), resolve(assignment.slice(separator + 1)));
      continue;
    }
    if (arg === '--manifest') {
      const value = argv[++index];
      if (!value) throw new Error('--manifest requires a path');
      options.manifest = resolve(value);
      continue;
    }
    if (arg === '--output') {
      const value = argv[++index];
      if (!value) throw new Error('--output requires a path');
      options.output = resolve(value);
      continue;
    }
    if (arg === '--keep-checkouts') {
      options.keepCheckouts = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 'userface-external-readiness-targets@1') {
    throw new Error('Unsupported external readiness target manifest');
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    throw new Error('External readiness target manifest is empty');
  }
  const ids = new Set();
  for (const target of manifest.targets) {
    if (!/^[a-z0-9][a-z0-9-]+$/.test(String(target.id || ''))) {
      throw new Error(`Invalid target id: ${String(target.id || '')}`);
    }
    if (ids.has(target.id)) throw new Error(`Duplicate target id: ${target.id}`);
    ids.add(target.id);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(String(target.repository || ''))) {
      throw new Error(`Target ${target.id} must use a public GitHub HTTPS repository`);
    }
    if (!/^[0-9a-f]{40}$/.test(String(target.sha || ''))) {
      throw new Error(`Target ${target.id} must pin a full commit SHA`);
    }
    if (
      !target.componentsDir
      || isAbsolute(target.componentsDir)
      || target.componentsDir.split(/[\\/]/).includes('..')
    ) {
      throw new Error(`Target ${target.id} has an unsafe componentsDir`);
    }
    const expected = target.expected || {};
    for (const key of ['minScore', 'minComponents', 'maxComponents', 'minProps']) {
      if (!Number.isFinite(expected[key]) || expected[key] < 0) {
        throw new Error(`Target ${target.id} has invalid ${key}`);
      }
    }
    if (expected.minComponents > expected.maxComponents) {
      throw new Error(`Target ${target.id} has an invalid component range`);
    }
  }
  return manifest;
}

function loadManifest(path = DEFAULT_MANIFEST) {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')));
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 180_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 2_000);
    throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function prepareCheckout(target, suppliedPath, tempRoot) {
  if (suppliedPath) {
    if (!existsSync(suppliedPath)) throw new Error(`Supplied checkout does not exist for ${target.id}`);
    return { root: suppliedPath, mode: 'local' };
  }
  const root = join(tempRoot, target.id);
  mkdirSync(root, { recursive: true });
  runChecked('git', ['init', '--quiet'], { cwd: root });
  runChecked('git', ['remote', 'add', 'origin', target.repository], { cwd: root });
  runChecked('git', ['fetch', '--quiet', '--depth=1', '--filter=blob:none', 'origin', target.sha], {
    cwd: root,
    timeout: 300_000,
  });
  runChecked('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], {
    cwd: root,
    timeout: 300_000,
  });
  return { root, mode: 'network-clone' };
}

function assertion(id, passed, expected, actual) {
  return { id, passed: Boolean(passed), expected, actual };
}

function evaluateReadiness(target, report, mode, durationMs) {
  const components = report?.components || {};
  const egress = report?.proof?.egress || {};
  const expected = target.expected;
  const assertions = [
    assertion('schema', report?.schemaVersion === 'userface-readiness@1', 'userface-readiness@1', report?.schemaVersion),
    assertion('status', ['partial', 'ready'].includes(report?.status), 'partial|ready', report?.status),
    assertion('score', report?.score >= expected.minScore, `>=${expected.minScore}`, report?.score),
    assertion('framework', report?.repo?.framework === 'react', 'react', report?.repo?.framework),
    assertion('commit', report?.proof?.repo?.commit === target.sha, target.sha, report?.proof?.repo?.commit),
    assertion('components-min', components.discovered >= expected.minComponents, `>=${expected.minComponents}`, components.discovered),
    assertion('components-max', components.discovered <= expected.maxComponents, `<=${expected.maxComponents}`, components.discovered),
    assertion('props', components.props >= expected.minProps, `>=${expected.minProps}`, components.props),
    assertion('styles', report?.tokenStyleRisks?.status === 'passed', 'passed', report?.tokenStyleRisks?.status),
    assertion('offline-guard', report?.guard?.offlineCore === true && report?.guard?.canRun === true, true, Boolean(report?.guard?.offlineCore && report?.guard?.canRun)),
    assertion(
      'zero-egress',
      egress.mode === 'offline'
        && egress.measurement === 'zero_upload'
        && egress.modelCalls === 0
        && egress.filesSent === 0
        && egress.bytesSent === 0
        && egress.absolutePathsSent === false
        && egress.remoteTelemetry === false
        && egress.network === false,
      'strict-zero',
      egress.measurement || 'missing',
    ),
  ];
  const failures = assertions
    .filter((item) => !item.passed)
    .map(({ id, expected: wanted, actual }) => ({ id, expected: wanted, actual }));
  return {
    id: target.id,
    repository: target.repository,
    sha: target.sha,
    componentsDir: target.componentsDir,
    mode,
    status: failures.length === 0 ? 'passed' : 'failed',
    durationMs,
    metrics: {
      readinessStatus: report?.status || 'unknown',
      score: Number(report?.score || 0),
      components: Number(components.discovered || 0),
      props: Number(components.props || 0),
      contracts: Number(components.contracted || 0),
      styleStatus: report?.tokenStyleRisks?.status || 'unknown',
    },
    proof: {
      id: report?.proof?.id || '',
      commit: report?.proof?.repo?.commit || '',
      modelCalls: Number(egress.modelCalls || 0),
      filesSent: Number(egress.filesSent || 0),
      bytesSent: Number(egress.bytesSent || 0),
      network: Boolean(egress.network),
    },
    assertions: {
      passed: assertions.length - failures.length,
      total: assertions.length,
    },
    failures,
  };
}

function failedTargetReceipt(target, mode, durationMs, error) {
  return {
    id: target.id,
    repository: target.repository,
    sha: target.sha,
    componentsDir: target.componentsDir,
    mode,
    status: 'failed',
    durationMs,
    metrics: null,
    proof: null,
    assertions: { passed: 0, total: 1 },
    failures: [{ id: 'execution', expected: 'successful pinned offline readiness run', actual: error }],
  };
}

function redactError(error, roots) {
  let value = error instanceof Error ? error.message : String(error);
  for (const root of roots.filter(Boolean).sort((left, right) => right.length - left.length)) {
    value = value.split(root).join('<checkout>');
  }
  value = value.replace(/\/(?:private\/)?(?:var|tmp)\/[^\s:'"]+/g, '<temporary-path>');
  return value.slice(0, 2_000);
}

function createReceipt(results, engineVersion, startedAt, finishedAt) {
  const failed = results.filter((result) => result.status === 'failed').length;
  return {
    schemaVersion: 'userface-external-readiness-eval@1',
    status: failed === 0 ? 'passed' : 'failed',
    generatedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    engineVersion,
    boundary: {
      checkoutNetwork: 'git-only',
      readiness: 'offline',
      modelCalls: 0,
      sourceFilesUploaded: 0,
    },
    totals: {
      targets: results.length,
      passed: results.length - failed,
      failed,
      components: results.reduce((sum, result) => sum + Number(result.metrics?.components || 0), 0),
      props: results.reduce((sum, result) => sum + Number(result.metrics?.props || 0), 0),
    },
    targets: results,
  };
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temporaryPath, path);
}

function run(options) {
  if (!existsSync(ENGINE_CLI)) throw new Error('Engine CLI is not built. Run pnpm build first.');
  const manifest = loadManifest(options.manifest);
  const requested = new Set(options.targets);
  const targets = requested.size === 0
    ? manifest.targets
    : manifest.targets.filter((target) => requested.has(target.id));
  const missing = [...requested].filter((id) => !manifest.targets.some((target) => target.id === id));
  if (missing.length > 0) throw new Error(`Unknown target(s): ${missing.join(', ')}`);

  const startedAt = Date.now();
  const tempRoot = mkdtempSync(join(tmpdir(), 'userface-external-readiness-'));
  const results = [];
  try {
    for (const target of targets) {
      const targetStartedAt = Date.now();
      let checkoutRoot = '';
      let mode = options.checkouts.has(target.id) ? 'local' : 'network-clone';
      process.stderr.write(`[external-readiness] ${target.id}: preparing pinned checkout\n`);
      try {
        const checkout = prepareCheckout(target, options.checkouts.get(target.id), tempRoot);
        checkoutRoot = checkout.root;
        mode = checkout.mode;
        const actualSha = runChecked('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot }).trim();
        if (actualSha !== target.sha) {
          throw new Error(`Checkout SHA mismatch: expected ${target.sha}, received ${actualSha}`);
        }
        const stdout = runChecked(process.execPath, [
          ENGINE_CLI,
          'readiness',
          '--root', checkoutRoot,
          '--components-dir', target.componentsDir,
          '--format', 'json',
          '--no-write',
        ], { timeout: 120_000 });
        const result = evaluateReadiness(target, JSON.parse(stdout), mode, Date.now() - targetStartedAt);
        results.push(result);
        process.stderr.write(`[external-readiness] ${target.id}: ${result.status} (${result.metrics.components} components, ${result.metrics.props} props)\n`);
      } catch (error) {
        const safeError = redactError(error, [checkoutRoot, tempRoot]);
        results.push(failedTargetReceipt(target, mode, Date.now() - targetStartedAt, safeError));
        process.stderr.write(`[external-readiness] ${target.id}: failed (${safeError})\n`);
      }
    }
  } finally {
    if (!options.keepCheckouts) rmSync(tempRoot, { recursive: true, force: true });
  }

  const engineVersion = JSON.parse(readFileSync(ENGINE_PACKAGE, 'utf8')).version;
  const receipt = createReceipt(results, engineVersion, startedAt, Date.now());
  if (options.output) writeReceipt(options.output, receipt);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.status === 'passed' ? 0 : 1;
}

module.exports = {
  createReceipt,
  evaluateReadiness,
  loadManifest,
  parseArgs,
  redactError,
  validateManifest,
};

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      process.exitCode = 0;
    } else {
      process.exitCode = run(options);
    }
  } catch (error) {
    process.stderr.write(`[external-readiness] ${redactError(error, [])}\n`);
    process.exitCode = 1;
  }
}
