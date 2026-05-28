#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runValidateCommand } from '../lib/validate.js';
import { generateComponentScaffold } from '../lib/generate.js';

const INSTALL_TARGETS = {
  engine: ['@userface/engine'],
};

const ENGINE_FORWARD_COMMANDS = new Set([
  'connect',
  'analyze',
  'readiness',
  'guard',
  'trust',
  'proof-schema',
  'states',
  'materialize',
  'composition-validate',
  'diff',
  'render',
  'test',
  'registry',
  'doctor',
  'mcp-serve',
  'login',
  'logout',
  'pull',
  'update',
  'sync',
]);

function printHelp() {
  console.log(`
Userface CLI

Usage:
  userface add engine
  userface connect [--root <dir>]
  userface analyze <path>
  userface validate [path] [--ci] [--mode fast|standard|deep] [--fail-on error|warning|info]
  userface readiness [--root path] [--format json|markdown]
  userface guard [path...] [--changed] [--offline] [--fail-on error|warning|info]
  userface trust [path...] [--offline] [--format json|markdown]
  userface proof-schema
  userface materialize <path> [--framework react|vue|html]
  userface composition-validate <path> [--registry-dir dir]
  userface mcp-serve [--root dir]
  userface generate <ComponentName> [--root path] [--overwrite]

Examples:
  userface add engine
  userface connect --root src/components
  userface validate src/components --ci
  userface readiness --root .
  userface guard --changed --offline --fail-on warning --proof userface-proof.json
  userface trust --offline --summary userface-trust.md
  userface mcp-serve --root src/components
  userface generate EmptyState
`);
}

function detectPackageManager(cwd) {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) return 'npm';
  return 'npm';
}

function runInstall(cwd, packages) {
  const pm = detectPackageManager(cwd);
  const command =
    pm === 'pnpm'
      ? ['pnpm', ['add', ...packages]]
      : pm === 'yarn'
        ? ['yarn', ['add', ...packages]]
        : ['npm', ['install', ...packages]];

  const result = spawnSync(command[0], command[1], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    if (result.status === 1) {
      const packageList = packages.join(', ');
      console.error('');
      console.error(`Userface install failed for: ${packageList}`);
      console.error('Most likely cause: the requested packages are not published to npm yet.');
      console.error('Expected public package:');
      console.error('  - @userface/engine');
      console.error('');
      console.error('If you are testing from the monorepo, use workspace packages locally.');
      console.error('If you are testing from outside the monorepo, publish the package first.');
    }
    process.exit(result.status || 1);
  }
}

function parseInstallTarget(rawTarget) {
  if (!rawTarget) return null;
  return INSTALL_TARGETS[rawTarget] ? rawTarget : null;
}

function addPackage(target) {
  const packages = INSTALL_TARGETS[target];
  if (!packages) {
    console.error(`Unknown install target: ${target}`);
    printHelp();
    process.exit(1);
  }
  runInstall(process.cwd(), packages);
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : '';
}

async function resolveEngineEntrypoint() {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(cliDir, '../../engine/package.json'),
  ];

  try {
    candidates.push(fileURLToPath(import.meta.resolve('@userface/engine/package.json')));
  } catch {
    // Published installs should resolve @userface/engine. Local development can
    // still use the sibling package candidate above.
  }

  const enginePackagePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!enginePackagePath) {
    throw new Error('Could not resolve @userface/engine. Run `userface add engine` or install @userface/engine.');
  }

  const engineRoot = path.dirname(enginePackagePath);
  const devCli = path.join(engineRoot, 'src', 'cli.ts');
  const repoRoot = path.resolve(engineRoot, '../..');
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(devCli) && fs.existsSync(tsxCli)) {
    return [process.execPath, [tsxCli, devCli]];
  }

  const builtBin = path.join(engineRoot, 'bin', 'userface-engine.mjs');
  if (fs.existsSync(builtBin) && fs.existsSync(path.join(engineRoot, 'dist', 'esm', 'cli.js'))) {
    return [process.execPath, [builtBin]];
  }

  return [process.execPath, [builtBin]];
}

async function forwardToEngine(command, args) {
  const [bin, prefixArgs] = await resolveEngineEntrypoint();
  const result = spawnSync(bin, [...prefixArgs, command, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status || 0);
}

async function main() {
  const [, , command, arg, ...rest] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command === 'init') {
    const requested = parseInstallTarget(arg || '');
    console.error('`userface init` has been removed.');
    console.error('Create your app yourself, then install the engine with:');
    console.error('  userface add engine');
    if (requested) {
      console.error('');
      console.error(`Detected install target hint: ${requested}`);
    }
    process.exit(1);
  }

  if (command === 'add') {
    if (!arg) {
      console.error('Missing install target.');
      printHelp();
      process.exit(1);
    }
    addPackage(arg);
    process.exit(0);
  }

  if (command === 'validate') {
    await runValidateCommand([arg, ...rest].filter(Boolean));
    return;
  }

  if (ENGINE_FORWARD_COMMANDS.has(command)) {
    await forwardToEngine(command, [arg, ...rest].filter(Boolean));
    return;
  }

  if (command === 'generate') {
    if (!arg) {
      console.error('Missing component name.');
      printHelp();
      process.exit(1);
    }

    const scaffold = generateComponentScaffold({
      name: arg,
      cwd: process.cwd(),
      root: flagValue(rest, '--root'),
      overwrite: rest.includes('--overwrite'),
    });

    console.log(`Generated ${scaffold.name} in ${scaffold.componentDir}`);
    for (const file of scaffold.files) {
      console.log(`- ${file.path}`);
    }
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

void main();
