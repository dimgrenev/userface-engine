/* eslint-disable no-console */
/**
 * Build step: sync engine assets across all required locations.
 *
 * Source of truth:
 *   - prop-extractor.js        → packages/engine/src/prop-extractor.js
 *   - codeSanitizer.js         → packages/engine/src/browser/codeSanitizer.js
 *   - userface-engine.js       → packages/engine/src/browser/userface-engine.js
 *   - engine-adapters.js       → packages/engine/src/browser/engine-adapters.js
 *
 * Do NOT edit copies by hand. Run `node packages/engine/scripts/build-public.cjs` to sync.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENGINE_ROOT = 'packages/engine';

const mappings = [
  // prop-extractor: canonical → browser copy + public copy
  { from: `${ENGINE_ROOT}/src/prop-extractor.js`, to: `${ENGINE_ROOT}/src/browser/prop-extractor.js` },
  { from: `${ENGINE_ROOT}/src/prop-extractor.js`, to: 'public/runtime/engine/prop-extractor.js' },
  // codeSanitizer: browser → public
  { from: `${ENGINE_ROOT}/src/browser/codeSanitizer.js`, to: 'public/runtime/engine/codeSanitizer.js' },
  // userface-engine: browser → public
  { from: `${ENGINE_ROOT}/src/browser/userface-engine.js`, to: 'public/runtime/engine/userface-engine.js' },
  // engine-adapters: browser → public
  { from: `${ENGINE_ROOT}/src/browser/engine-adapters.js`, to: 'public/runtime/engine/engine-adapters.js' },
];

function copyFile(fromRel, toRel) {
  const from = path.join(ROOT, fromRel);
  const to = path.join(ROOT, toRel);
  if (!fs.existsSync(from)) {
    throw new Error(`Missing source file: ${fromRel}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return { fromRel, toRel };
}

/**
 * Verify all copies are in sync. Returns array of desync descriptions.
 * Used by check mode (--check flag) and CI validation.
 */
function verify() {
  const desyncs = [];
  for (const m of mappings) {
    const from = path.join(ROOT, m.from);
    const to = path.join(ROOT, m.to);
    if (!fs.existsSync(from)) {
      desyncs.push(`MISSING source: ${m.from}`);
      continue;
    }
    if (!fs.existsSync(to)) {
      desyncs.push(`MISSING copy: ${m.to} (source: ${m.from})`);
      continue;
    }
    const srcBuf = fs.readFileSync(from);
    const dstBuf = fs.readFileSync(to);
    if (!srcBuf.equals(dstBuf)) {
      desyncs.push(`DESYNC: ${m.from} != ${m.to}`);
    }
  }
  return desyncs;
}

function main() {
  const isCheck = process.argv.includes('--check');

  if (isCheck) {
    const desyncs = verify();
    if (desyncs.length > 0) {
      console.error('[engine-sync] FAILED — files out of sync:');
      desyncs.forEach((d) => console.error(`  ${d}`));
      console.error('\nRun: node packages/engine/scripts/build-public.cjs');
      process.exit(1);
    }
    console.log('[engine-sync] OK — all files in sync');
    return;
  }

  const results = mappings.map((m) => copyFile(m.from, m.to));
  console.log(
    '[engine-sync] synced:',
    results.map((r) => `${r.fromRel} -> ${r.toRel}`).join(', ')
  );
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[engine-sync] failed:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

module.exports = { mappings, verify };
