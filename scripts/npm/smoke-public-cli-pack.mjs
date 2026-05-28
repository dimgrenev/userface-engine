#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const enginePackageDir = path.join(repoRoot, 'packages', 'engine');
const userfacePackageDir = path.join(repoRoot, 'packages', 'userface');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-public-cli-pack-'));
const tarballDir = path.join(tempRoot, 'tarballs');
const installRoot = path.join(tempRoot, 'install');
const nodeModulesDir = path.join(installRoot, 'node_modules');
const binDir = path.join(nodeModulesDir, '.bin');
const npmCacheDir = path.join(tempRoot, 'npm-cache');

function log(message) {
  process.stdout.write(`[public-cli-pack] ${message}\n`);
}

function fail(message, details = '') {
  process.stderr.write(`[public-cli-pack] ${message}\n`);
  if (details) process.stderr.write(`${details.trim()}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const env = { ...process.env };
  if (command === 'npm') {
    env.npm_config_cache = npmCacheDir;
    env.npm_config_audit = 'false';
    env.npm_config_fund = 'false';
    delete env.npm_config_dir;
    delete env.npm_config_approve_builds;
    delete env.npm_config_verify_deps_before_run;
    delete env.npm_config__jsr_registry;
    delete env.npm_config_store_dir;
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env,
  });

  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`,
      `${result.stdout || ''}\n${result.stderr || ''}`
    );
  }

  return result;
}

function packPackage(packageDir) {
  const result = run('npm', ['pack', '--json', '--pack-destination', tarballDir], { cwd: packageDir });
  const packs = JSON.parse(result.stdout || '[]');
  const filename = packs[0]?.filename;
  if (!filename) fail(`npm pack did not return a filename for ${packageDir}`, result.stdout);
  return path.join(tarballDir, filename);
}

function unpackPackage(tarball, destination) {
  const unpackRoot = fs.mkdtempSync(path.join(tempRoot, 'unpack-'));
  run('tar', ['-xzf', tarball, '-C', unpackRoot]);
  const packageRoot = path.join(unpackRoot, 'package');
  if (!fs.existsSync(packageRoot)) fail(`packed tarball did not contain package/ root: ${tarball}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(packageRoot, destination, { recursive: true });
}

function readPackageJson(packageDir) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
}

function dependencyPath(packageDir, name) {
  const parts = name.split('/');
  const packageLocal = path.join(packageDir, 'node_modules', ...parts);
  if (fs.existsSync(packageLocal)) return packageLocal;
  return path.join(repoRoot, 'node_modules', ...parts);
}

function destinationDependencyPath(name) {
  const parts = name.split('/');
  return path.join(nodeModulesDir, ...parts);
}

function linkDependency(packageDir, name, { optional = false } = {}) {
  const source = dependencyPath(packageDir, name);
  const destination = destinationDependencyPath(name);
  if (fs.existsSync(destination)) return;
  if (!fs.existsSync(source)) {
    if (optional) return;
    fail(`dependency ${name} is not installed in ${packageDir}/node_modules or repo node_modules`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function linkDirectDependencies(packageDir) {
  const packageJson = readPackageJson(packageDir);
  for (const name of Object.keys(packageJson.dependencies ?? {})) {
    if (name === '@userface/engine') continue;
    linkDependency(packageDir, name);
  }
  for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
    linkDependency(packageDir, name, { optional: true });
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function linkBin(name, target) {
  const destination = path.join(binDir, name);
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  fs.symlinkSync(target, destination);
}

function runBin(name, args) {
  return run(process.execPath, [path.join(binDir, name), ...args], { cwd: installRoot });
}

function assertContains(label, value, expected) {
  if (!value.includes(expected)) fail(`${label} did not include ${expected}`, value);
}

function assertJson(label, value) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} did not produce valid JSON`, value);
  }
}

function assertExecutable(filePath) {
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o111) === 0) fail(`${filePath} is not executable`);
}

function cleanup() {
  if (process.env.USERFACE_KEEP_PUBLIC_CLI_PACK_SMOKE === '1') {
    log(`kept temp fixture at ${tempRoot}`);
    return;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

try {
  fs.mkdirSync(tarballDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  writeJson(path.join(installRoot, 'package.json'), {
    name: 'userface-public-cli-pack-smoke',
    private: true,
    type: 'module',
  });

  log('packing @userface/engine and userface');
  const engineTarball = packPackage(enginePackageDir);
  const userfaceTarball = packPackage(userfacePackageDir);

  log('installing packed package contents into isolated temp node_modules');
  unpackPackage(engineTarball, path.join(nodeModulesDir, '@userface', 'engine'));
  unpackPackage(userfaceTarball, path.join(nodeModulesDir, 'userface'));
  linkDirectDependencies(enginePackageDir);
  linkDirectDependencies(userfacePackageDir);
  linkBin('userface', '../userface/bin/userface.js');
  linkBin('userface-engine', '../@userface/engine/bin/userface-engine.mjs');

  assertExecutable(path.join(nodeModulesDir, 'userface', 'bin', 'userface.js'));
  assertExecutable(path.join(nodeModulesDir, '@userface', 'engine', 'bin', 'userface-engine.mjs'));

  log('verifying buyer-facing userface command');
  const help = runBin('userface', ['--help']);
  assertContains('userface --help', help.stdout, 'Userface CLI');
  assertContains('userface --help', help.stdout, 'userface guard');
  assertContains('userface --help', help.stdout, 'userface mcp-serve');

  const schema = assertJson('userface proof-schema', runBin('userface', ['proof-schema']).stdout);
  if (schema.$id !== 'https://userface.dev/schemas/userface-proof@1.json') {
    fail(`unexpected proof schema id: ${schema.$id}`);
  }

  const trust = assertJson('userface trust --offline', runBin('userface', ['trust', '--offline']).stdout);
  if (trust.schema !== 'userface-proof@1' || trust.egress?.modelCalls !== 0 || trust.egress?.filesSent !== 0) {
    fail('offline trust proof did not preserve zero-upload egress contract', JSON.stringify(trust, null, 2));
  }

  writeJson(path.join(installRoot, 'screen.ui.json'), {
    version: 'ui@1',
    root: {
      type: 'Card',
      children: [{ type: 'Button' }],
    },
  });
  const guard = assertJson(
    'userface guard --offline',
    runBin('userface', [
      'guard',
      'screen.ui.json',
      '--offline',
      '--fail-on',
      'warning',
      '--proof',
      'userface-proof.json',
    ]).stdout
  );
  if (guard.status !== 'passed' || guard.target?.kind !== 'pr_gate') {
    fail('guard proof did not pass the fixed smoke composition', JSON.stringify(guard, null, 2));
  }
  if (!fs.existsSync(path.join(installRoot, 'userface-proof.json'))) {
    fail('guard did not write --proof output file');
  }

  log('verifying transitional userface-engine alias from @userface/engine package');
  const engineSchema = assertJson('userface-engine proof-schema', runBin('userface-engine', ['proof-schema']).stdout);
  if (engineSchema.$id !== schema.$id) fail('userface-engine alias returned a different schema');

  log('public CLI package smoke passed');
} finally {
  cleanup();
}
