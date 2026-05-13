/* eslint-disable no-console */
/**
 * Build npm package output for engine/:
 * - dist/esm (ESM)
 * - dist/cjs (CJS)
 * - dist/types (d.ts)
 *
 * We intentionally avoid `npx tsc` to keep builds deterministic and offline-friendly.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENGINE_ROOT = path.resolve(__dirname, '..'); // /packages/engine
const REPO_ROOT = path.resolve(ENGINE_ROOT, '..', '..'); // repo root

function runNode(scriptPath, args) {
  const res = spawnSync(process.execPath, [scriptPath, ...args], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status || 1);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Node.js ESM requires explicit .js extensions on relative imports.
 * TypeScript with moduleResolution: "Bundler" does not add them.
 * This post-processor adds .js to all bare relative imports in compiled ESM output.
 */
function fixEsmExtensions(dir) {
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      fixEsmExtensions(full);
      continue;
    }
    if (!entry.endsWith('.js')) continue;
    let content = fs.readFileSync(full, 'utf8');
    let changed = false;
    // Fix: from './foo' → from './foo.js', import('./foo') → import('./foo.js')
    content = content.replace(
      /(from\s+['"]|import\s*\(\s*['"])(\.[^'"]+)(['"])/g,
      (match, prefix, importPath, quote) => {
        if (/\.(js|json|css|mjs|cjs)$/.test(importPath)) return match;
        changed = true;
        return prefix + importPath + '.js' + quote;
      }
    );
    if (changed) fs.writeFileSync(full, content, 'utf8');
  }
}

function main() {
  const distDir = path.join(ENGINE_ROOT, 'dist');
  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });

  console.log('[engine:npm] building (esm/cjs/types)...');
  const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.error('[engine:npm] typescript not found in repo root node_modules. Install deps first.');
    process.exit(1);
  }
  runNode(tsc, ['-p', path.join(ENGINE_ROOT, 'tsconfig.build.esm.json')]);
  runNode(tsc, ['-p', path.join(ENGINE_ROOT, 'tsconfig.build.cjs.json')]);
  runNode(tsc, ['-p', path.join(ENGINE_ROOT, 'tsconfig.build.types.json')]);

  // Ensure correct module interpretation for dual package.
  writeJson(path.join(ENGINE_ROOT, 'dist', 'cjs', 'package.json'), { type: 'commonjs' });
  writeJson(path.join(ENGINE_ROOT, 'dist', 'esm', 'package.json'), { type: 'module' });

  // Fix ESM relative imports (add .js extensions for Node.js compatibility).
  fixEsmExtensions(path.join(ENGINE_ROOT, 'dist', 'esm'));
  console.log('[engine:npm] fixed ESM import extensions');

  // Make CLI binary executable.
  const cliBin = path.join(ENGINE_ROOT, 'dist', 'esm', 'cli.js');
  if (fs.existsSync(cliBin)) {
    fs.chmodSync(cliBin, '755');
    console.log('[engine:npm] cli binary chmod 755');
  }

  console.log('[engine:npm] done.');
}

if (require.main === module) main();

