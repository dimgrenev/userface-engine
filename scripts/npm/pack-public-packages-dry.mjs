#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-pack-dry-'));
const npmCacheDir = path.join(tempRoot, 'npm-cache');

const packages = [
  ['@userface/engine', path.join(repoRoot, 'packages', 'engine')],
  ['userface', path.join(repoRoot, 'packages', 'userface')],
];

function npmEnv() {
  const env = { ...process.env };
  env.npm_config_cache = npmCacheDir;
  env.npm_config_audit = 'false';
  env.npm_config_fund = 'false';
  delete env.npm_config_dir;
  delete env.npm_config_approve_builds;
  delete env.npm_config_verify_deps_before_run;
  delete env.npm_config__jsr_registry;
  delete env.npm_config_store_dir;
  return env;
}

try {
  for (const [name, cwd] of packages) {
    process.stdout.write(`[pkg:pack] dry-run ${name}\n`);
    const result = spawnSync('npm', ['pack', '--dry-run'], {
      cwd,
      env: npmEnv(),
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
  process.stdout.write('[pkg:pack] dry-run passed for public packages\n');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
