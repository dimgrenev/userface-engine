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
const os = require('os');
const crypto = require('crypto');
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
const helpResult = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8', timeout: 5000 });
check('--help returns 0', helpResult.status === 0);
check('--help uses primary userface command', /Userface CLI/.test(helpResult.stderr || '') && /userface guard/.test(helpResult.stderr || ''));

console.log('\n4. Face UI subpath:');
check('dist/esm/face-ui/index.js exists', fileExists('dist/esm/face-ui/index.js'));
check('dist/types/face-ui/index.d.ts exists', fileExists('dist/types/face-ui/index.d.ts'));
check('dist/types/face-ui/types.d.ts exists', fileExists('dist/types/face-ui/types.d.ts'));

console.log('\n5. Bundler subpath:');
check('dist/esm/bundler/vfsBundler.js exists', fileExists('dist/esm/bundler/vfsBundler.js'));
check('dist/types/bundler/vfsBundler.d.ts exists', fileExists('dist/types/bundler/vfsBundler.d.ts'));

console.log('\n5a. Merge gate subpath:');
check('dist/esm/merge-gate.js exists', fileExists('dist/esm/merge-gate.js'));
check('dist/cjs/merge-gate.js exists', fileExists('dist/cjs/merge-gate.js'));
check('dist/types/merge-gate.d.ts exists', fileExists('dist/types/merge-gate.d.ts'));
check('dist/schemas/merge-gate-evidence@1.json exists', fileExists('dist/schemas/merge-gate-evidence@1.json'));
let mergeGate = null;
try {
  mergeGate = require(path.join(DIST, 'cjs', 'merge-gate.js'));
  check('merge gate verifier exported', typeof mergeGate.verifyUserfaceMergeGateEvidence === 'function');
  check('merge gate evidence builder exported', typeof mergeGate.createUserfaceMergeGateEvidence === 'function');
} catch (e) {
  check(`CJS merge gate require failed: ${e.message}`, false);
}

if (mergeGate) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'userface-engine-merge-gate-'));
  try {
    const sourcePath = path.join(fixtureRoot, 'src', 'App.tsx');
    const content = 'export const App = () => <main>Billing</main>;\n';
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, content, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const policyHash = crypto.createHash('sha256').update('smoke-policy').digest('hex');
    const subject = {
      changeSetId: 'changeset_smoke',
      files: [{ path: 'src/App.tsx', action: 'edit', beforeHash: null, afterHash: hash, additions: 1, deletions: 0 }],
      validation: { validationId: 'validation_smoke', renderJobId: null, status: 'passed', score: 100, valid: true, passed: true, pendingFix: false, staleReason: null, violations: [] },
      validationRuns: [],
      conflicts: [],
      surfaces: [],
    };
    const subjectRevision = mergeGate.computeUserfaceMergeGateSubjectRevision(subject);
    const evidence = mergeGate.createUserfaceMergeGateEvidence({
      schemaVersion: 'mergeGateEvidence@1',
      producer: { name: 'Userface', contractVersion: 1 },
      createdAt: 1,
      subject,
      review: {
        reviewId: 'review_smoke',
        changeSetId: 'changeset_smoke',
        subjectRevision,
        policy: { mode: 'advisory', requiredApprovals: 0, minimumReviewerRole: 'contributor', allowRequesterApproval: true, requireSignedMergeGate: false, policyHash, source: 'default' },
        author: { principalId: 'userface-agent:smoke', kind: 'agent' },
        state: 'pending',
        gateStatus: 'advisory',
        mergeEligible: true,
        approvalCount: 0,
        requiredApprovals: 0,
        blockers: [],
        decisions: [],
      },
    });
    const evidencePath = path.join(fixtureRoot, 'merge-gate.json');
    fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
    const pass = spawnSync(process.execPath, [cliPath, 'merge-gate', 'verify', evidencePath, '--root', fixtureRoot, '--format', 'json'], { encoding: 'utf8', timeout: 5000 });
    check('merge-gate verify exits 0 for matching checkout', pass.status === 0);
    check('merge-gate verify emits machine-readable pass', JSON.parse(pass.stdout || '{}').mergeEligible === true);
    const keys = crypto.generateKeyPairSync('ed25519');
    evidence.review.policy.requireSignedMergeGate = true;
    evidence.integrity.digest = mergeGate.computeUserfaceMergeGateEvidenceDigest(evidence);
    const signedEvidence = mergeGate.signUserfaceMergeGateEvidence(evidence, keys.privateKey);
    fs.writeFileSync(evidencePath, JSON.stringify(signedEvidence, null, 2), 'utf8');
    const publicKeyPath = path.join(fixtureRoot, 'merge-gate.pub.pem');
    fs.writeFileSync(publicKeyPath, keys.publicKey.export({ format: 'pem', type: 'spki' }));
    const signedPass = spawnSync(process.execPath, [cliPath, 'merge-gate', 'verify', evidencePath, '--root', fixtureRoot, '--public-key', publicKeyPath, '--require-signature', '--format', 'json'], { encoding: 'utf8', timeout: 5000 });
    check('merge-gate verify accepts pinned Ed25519 attestation', signedPass.status === 0);
    check('merge-gate verify reports verified authenticity', JSON.parse(signedPass.stdout || '{}').authenticity === 'verified');
    fs.writeFileSync(sourcePath, 'changed after review\n', 'utf8');
    const block = spawnSync(process.execPath, [cliPath, 'merge-gate', 'verify', evidencePath, '--root', fixtureRoot, '--format', 'github'], { encoding: 'utf8', timeout: 5000 });
    check('merge-gate verify exits 1 for changed checkout', block.status === 1);
    check('merge-gate verify emits GitHub file annotation', /::error file=src\/App\.tsx/.test(block.stdout || ''));
  } catch (e) {
    check(`merge-gate CLI smoke failed: ${e.message}`, false);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

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
check('bin.userface defined', !!pkg.bin?.userface);
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
