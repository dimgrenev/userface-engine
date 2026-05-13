#!/usr/bin/env node
/**
 * Smoke test for the built engine package.
 * Run after `npm run build` to verify the package works correctly.
 *
 * Checks:
 * 1. ESM entry resolves and exports expected symbols
 * 2. CJS entry resolves and exports expected symbols
 * 3. CLI binary exists and is executable
 * 4. Type definitions exist
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.resolve(__dirname, '..');
const DIST = path.join(ENGINE, 'dist');

let failures = 0;

function check(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

function fileExists(rel) {
  return fs.existsSync(path.join(ENGINE, rel));
}

console.log('\n@userface/engine smoke test\n');

console.log('1. Distribution files:');
check('dist/esm/index.js exists', fileExists('dist/esm/index.js'));
check('dist/cjs/index.js exists', fileExists('dist/cjs/index.js'));
check('dist/types/index.d.ts exists', fileExists('dist/types/index.d.ts'));
check('dist/esm/cli.js exists', fileExists('dist/esm/cli.js'));
check('dist/esm/package.json (type: module)', (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DIST, 'esm', 'package.json'), 'utf8'));
    return pkg.type === 'module';
  } catch { return false; }
})());
check('dist/cjs/package.json (type: commonjs)', (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(DIST, 'cjs', 'package.json'), 'utf8'));
    return pkg.type === 'commonjs';
  } catch { return false; }
})());
check('no example-usage in dist', !fileExists('dist/esm/example-usage.js') && !fileExists('dist/cjs/example-usage.js'));

console.log('\n2. CJS require test:');
try {
  const cjs = require(path.join(DIST, 'cjs', 'index.js'));
  check('createEngine exported', typeof cjs.createEngine === 'function');
  check('generateStates exported', typeof cjs.generateStates === 'function');
  check('normalizePropDef exported', typeof cjs.normalizePropDef === 'function');
} catch (e) {
  check(`CJS require failed: ${e.message}`, false);
}

console.log('\n3. CLI binary:');
const cliPath = path.join(DIST, 'esm', 'cli.js');
check('cli.js has shebang', (() => {
  try {
    const head = fs.readFileSync(cliPath, 'utf8').slice(0, 30);
    return head.startsWith('#!/usr/bin/env node');
  } catch { return false; }
})());
check('cli.js is executable', (() => {
  try {
    const stat = fs.statSync(cliPath);
    return (stat.mode & 0o111) !== 0;
  } catch { return false; }
})());

const versionResult = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8', timeout: 5000 });
check('--version returns 0', versionResult.status === 0);
check('--version outputs version string', /^\d+\.\d+\.\d+/.test((versionResult.stdout || '').trim()));

console.log('\n4. Face UI subpath:');
check('dist/esm/face-ui/index.js exists', fileExists('dist/esm/face-ui/index.js'));
check('dist/types/face-ui/index.d.ts exists', fileExists('dist/types/face-ui/index.d.ts'));
check('dist/types/face-ui/types.d.ts exists', fileExists('dist/types/face-ui/types.d.ts'));

console.log('\n5. Bundler subpath:');
check('dist/esm/bundler/vfsBundler.js exists', fileExists('dist/esm/bundler/vfsBundler.js'));
check('dist/types/bundler/vfsBundler.d.ts exists', fileExists('dist/types/bundler/vfsBundler.d.ts'));

console.log('\n6. Browser runtime:');
check('src/browser/userface-engine.js exists', fileExists('src/browser/userface-engine.js'));
check('src/browser/engine-adapters.js exists', fileExists('src/browser/engine-adapters.js'));
check('src/browser/prop-extractor.js exists', fileExists('src/browser/prop-extractor.js'));

console.log('\n7. Package metadata:');
const pkg = JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8'));
check('name is @userface/engine', pkg.name === '@userface/engine');
check('license is MIT', pkg.license === 'MIT');
check('has repository field', !!pkg.repository?.url);
check('has homepage field', !!pkg.homepage);
check('has keywords', Array.isArray(pkg.keywords) && pkg.keywords.length > 0);
check('engines.node >= 20', />=\s*20/.test(pkg.engines?.node || ''));
check('bin.userface-engine defined', !!pkg.bin?.['userface-engine']);
check('publishConfig.access is public', pkg.publishConfig?.access === 'public');
check('LICENSE file exists', fileExists('LICENSE'));
check('CHANGELOG.md exists', fileExists('CHANGELOG.md'));

console.log('\n8. Next integration subpath:');
check('integrations/next/engineController.js exists', fileExists('integrations/next/engineController.js'));
check('integrations/next/engineController.d.ts exists', fileExists('integrations/next/engineController.d.ts'));
const nextIntegrationResult = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    "import('@userface/engine/integrations/next/engineController').then((m)=>{ if (typeof m.ensureEngineReady !== 'function') process.exit(2); }).catch((e)=>{ console.error(e); process.exit(1); })",
  ],
  { cwd: ENGINE, encoding: 'utf8', timeout: 5000 }
);
check('Next integration import resolves through package exports', nextIntegrationResult.status === 0);

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}\n`);
process.exit(failures > 0 ? 1 : 0);
