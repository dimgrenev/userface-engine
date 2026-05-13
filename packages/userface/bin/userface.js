#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runValidateCommand } from '../lib/validate.js';
import { generateComponentScaffold } from '../lib/generate.js';

const INSTALL_TARGETS = {
  engine: ['@userface/engine'],
};

function printHelp() {
  console.log(`
Userface CLI

Usage:
  userface add engine
  userface validate [path] [--ci] [--mode fast|standard|deep] [--fail-on error|warning|info]
  userface generate <ComponentName> [--root path] [--overwrite]

Examples:
  userface add engine
  userface validate src/components --ci
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
