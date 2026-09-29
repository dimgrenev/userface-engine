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

const esmRootResult = spawnSync(process.execPath, ['--input-type=module', '-e',
  "import('@userface/engine').then((m) => { for (const key of ['createEngine', 'RuleEngine', 'normalizePropDef']) if (typeof m[key] !== 'function') throw Error(key + ' missing'); }).catch((error) => { console.error(error); process.exit(1); })",
], { cwd: ENGINE, encoding: 'utf8', timeout: 10000 });
check('ESM root import resolves through package exports', esmRootResult.status === 0);
if (esmRootResult.status !== 0) console.error(esmRootResult.stderr);

for (const format of ['esm', 'cjs']) {
  const load = format === 'esm'
    ? "import { AdvancedPropParser } from '@userface/engine/prop-analysis'; import { generateStates } from '@userface/engine';"
    : "const { AdvancedPropParser } = require('@userface/engine/prop-analysis'); const { generateStates } = require('@userface/engine');";
  const result = spawnSync(process.execPath, [...(format === 'esm' ? ['--input-type=module'] : []), '-e', `${load}
    const parser = new AdvancedPropParser();
    const props = parser.parse('Sample.tsx', { 'Sample.tsx': { content:
      'export function First(p: {wrong:string}) {return null;} export function Selected(p: {count:number}) {return null;}'
    } }, 'react', 'Selected');
    if (props.length !== 1 || props[0].name !== 'count') throw Error('Wrong export props: ' + JSON.stringify(props));
    const batch = parser.parseMany([{fileName:'Empty.tsx',exportName:'Empty'}], {'Empty.tsx':{content:'export function Empty(){return null;}'}});
    if (batch.length !== 1 || batch[0].length !== 0) throw Error('Invalid batch analysis');
    const selections = parser.parseMany([
      {fileName:'Mixed.stories.tsx',exportName:'Sample',format:'source'},
      {fileName:'Mixed.stories.tsx',exportName:'Sample',format:'story'},
      {fileName:'Scenarios.tsx',exportName:'Selected',format:'story'}
    ], {
      'Mixed.stories.tsx': {content: 'export function Sample(p: {sourceOnly:string}) {return null;} Sample.args = {storyOnly:-1}; export default {component:Sample};'},
      'Scenarios.tsx': {content: 'export default {argTypes:{choice:{options:[1,"1",true]}}}; export const Selected = {args:{choice:false}};'}
    });
    if (JSON.stringify(selections.map(props => props.map(prop => prop.name))) !== '[["sourceOnly"],["sourceOnly","storyOnly"],["choice"]]'
      || selections[1][1].defaultValue !== -1 || JSON.stringify(selections[2][0].options) !== '[1,"1",true]') throw Error('Explicit analysis format or literal values changed');
    const states = generateStates([{name:'choice',type:'select',required:false,description:'',options:[1,'1',true]}, {name:'label',type:'string',required:false,description:'',defaultValue:null}]);
    if (JSON.stringify(states.map(state => state.props.choice)) !== '[1,"1",true]' || states.some(state => state.props.label !== null)) throw Error('Literal state values were changed');
    parser.dispose();
  `], { cwd: ENGINE, encoding: 'utf8', timeout: 10000 });
  check(`${format} prop-analysis public entry analyzes the selected export`, result.status === 0);
  if (result.status !== 0) console.error(result.stderr);
}
check('prop-analysis public types exist', fileExists('dist/types/prop-analysis/index.d.ts'));
check('lightweight prop-analysis public types exist', fileExists('dist/types/prop-analysis/lightweight/index.d.ts'));
for (const format of ['esm', 'cjs']) {
  const load = format === 'esm'
    ? "import { extractReactTsPropsFromSource, extractVuePropsFromSFC, extractSvelteProps } from '@userface/engine/prop-analysis/lightweight';"
    : "const { extractReactTsPropsFromSource, extractVuePropsFromSFC, extractSvelteProps } = require('@userface/engine/prop-analysis/lightweight');";
  const result = spawnSync(process.execPath, [...(format === 'esm' ? ['--input-type=module'] : []), '-e', `${load}
    const react = extractReactTsPropsFromSource({fileName:'Card.tsx', code:"export interface CardProps { tone?: 'warm' | 'cool' }"});
    const vue = extractVuePropsFromSFC("<script setup>defineProps<{enabled?: boolean}>()</script>");
    const svelte = extractSvelteProps("<script>export let count: number = 0;</script>");
    if (react[0]?.name !== 'tone' || vue[0]?.name !== 'enabled' || svelte[0]?.defaultValue !== 0) throw Error('Lightweight parser behavior changed');
  `], { cwd: ENGINE, encoding: 'utf8', timeout: 10000 });
  check(`${format} lightweight prop-analysis public entry executes`, result.status === 0);
  if (result.status !== 0) console.error(result.stderr);
}
for (const format of ['esm', 'cjs']) {
  const load = format === 'esm'
    ? "import { createEngine } from '@userface/engine'; import * as React from 'react'; import * as ReactDOMServer from 'react-dom/server'; import assert from 'node:assert/strict'; import { runInNewContext } from 'node:vm';"
    : "const { createEngine } = require('@userface/engine'); const React = require('react'); const ReactDOMServer = require('react-dom/server'); const assert = require('node:assert/strict'); const { runInNewContext } = require('node:vm');";
  const renderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'userface-engine-render-cwd-'));
  const result = spawnSync(process.execPath, [...(format === 'esm' ? ['--input-type=module'] : []), '-e', `${load}
    process.chdir(${JSON.stringify(renderRoot)});
    (async () => {
      const engine = createEngine({ React, ReactDOMServer });
      const files = [
        {name:'src/index.ts',content:"export { Item as Selected } from './Item.js';"},
        {name:'src/Item.tsx',content:"export function Item({count=7}:{count?:number}){return <b>selected:{count}</b>}"}
      ];
      const spec = await engine.analyzeComponent(files, {entryPath:'src/index.ts',exportName:'Selected'});
      files[1].content = 'export function Item(){throw new Error("wrong snapshot")}';
      const rendered = await engine.renderFromSpec(spec.name, {count:23}, 'ssr');
      assert.match(rendered.data.html, /<b>selected:23<\\/b>/);
      assert.doesNotMatch(rendered.data.html, /<script/);
      const automatic = createEngine();
      const automaticSpec = await automatic.analyzeComponent([{name:'Automatic.tsx',content:'export default function Automatic(){return <b>installed runtime</b>}'}], {entryPath:'Automatic.tsx'});
      assert.match((await automatic.renderFromSpec(automaticSpec.name, {}, 'ssr')).data.html, /installed runtime/);
      const bad = await engine.analyzeComponent([{name:'Bad.tsx',content:'export function Missing(){throw new Error("expected render failure")}'}], {entryPath:'Bad.tsx',exportName:'Missing'});
      await assert.rejects(engine.renderFromSpec(bad.name, {}, 'ssr'), {code:'UF400', message:/expected render failure/});
      const asynchronous = await engine.analyzeComponent([{name:'Async.tsx',content:'export default async function Async(){throw new Error("unhandled SSR rejection")}'}], {entryPath:'Async.tsx',exportName:'default'});
      await assert.rejects(engine.renderFromSpec(asynchronous.name, {}, 'ssr'), {code:'UF400', message:/asynchronous SSR renderer/});
      const legacy = await engine.analyzeComponent([{name:'Legacy.js',content:'const label=document.title; export default function Legacy(){return <b>{label}</b>}'}], {entryPath:'Legacy.js'});
      const live = await engine.renderFromSpec(legacy.name, {}, 'live');
      const Component = runInNewContext(live.data.componentCode, {React, document:{title:'browser only'}});
      assert.equal(ReactDOMServer.renderToStaticMarkup(React.createElement(Component)), '<b>browser only</b>');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: ENGINE, encoding: 'utf8', timeout: 15000 });
  fs.rmSync(renderRoot, { recursive: true, force: true });
  check(`${format} public engine renders the selected snapshot and prepares legacy live from an unrelated cwd`, result.status === 0);
  if (result.status !== 0) console.error(result.stdout, result.stderr);
}
const typesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'userface-engine-public-types-'));
try {
  fs.mkdirSync(path.join(typesRoot, 'node_modules', '@userface'), { recursive: true });
  fs.symlinkSync(ENGINE, path.join(typesRoot, 'node_modules', '@userface', 'engine'), 'dir');
  const source = `import { createEngine, generateStates, normalizePropDef, type StateMatrixProp, type EngineEntryPathOptions, type EngineRenderResult } from '@userface/engine';
    import { AdvancedPropParser, type ParsedProp } from '@userface/engine/prop-analysis';
    import { extractReactTsPropsFromSource, type ExtractedProp } from '@userface/engine/prop-analysis/lightweight';
    const fallbackProps: ExtractedProp[] = extractReactTsPropsFromSource({ fileName: 'Sample.tsx', code: 'export interface SampleProps { label?: string }' });
    if (fallbackProps[0]?.name !== 'label') throw Error('Lightweight parser type contract');
    const parser = new AdvancedPropParser();
    const props: ParsedProp[] = parser.parse('Sample.tsx', { 'Sample.tsx': { content: 'export default () => null' } }, 'react', 'default');
    const batch: ParsedProp[][] = parser.parseMany([{fileName:'Sample.tsx',exportName:'default',format:'source'}], {'Sample.tsx':{content:'export default () => null'}});
    generateStates([normalizePropDef({ name: 'label', type: 'string' })]);
    const literalChoices: StateMatrixProp = { name: 'choice', type: 'select', required: false, description: '', options: [1, '1', true] };
    generateStates([literalChoices]);
    const target: EngineEntryPathOptions = {entryPath:'Sample.tsx', exportName:'Selected'};
    async function render(): Promise<EngineRenderResult> {
      const engine = createEngine();
      const spec = await engine.analyzeComponent([{name:'Sample.tsx', content:'export function Selected(){return null;}'}], target);
      return engine.renderFromSpec(spec.name, {}, 'ssr');
    }
    parser.dispose();`;
  const fixtures = ['consumer.mts', 'consumer.cts'].map(name => {
    const file = path.join(typesRoot, name);
    fs.writeFileSync(file, source);
    return file;
  });
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'),
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--strict', '--skipLibCheck', 'false', '--noEmit', ...fixtures,
  ], { cwd: ENGINE, encoding: 'utf8', timeout: 30000 });
  check('public ESM/CJS types resolve in NodeNext without skipLibCheck', result.status === 0);
  if (result.status !== 0) console.error(result.stdout, result.stderr);
} finally {
  fs.rmSync(typesRoot, { recursive: true, force: true });
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

console.log('\n9. Preview public dependencies:');
for (const kind of ['cjs', 'esm']) {
  const script = `${kind === 'esm'
    ? "const source = await import('@userface/engine/source'); const face = await import('@userface/engine/face-contract');"
    : "const source = require('@userface/engine/source'); const face = require('@userface/engine/face-contract');"}
    const model = ${kind === 'esm' ? "await import('@userface/engine/face-ui/model')" : "require('@userface/engine/face-ui/model')"};
    const document = {schema:'face','schema-version':1,root:{type:'Button',key:'root',props:{text:'base'}}};
    const node = model.materializeFaceUiDoc(document,{registry:{resolve:()=>null}}).root;
    const edited = model.setNodeProp(document,node.nodeId,'text','edited');
    if(edited.root.props.text !== 'edited' || document.root.props.text !== 'base') throw Error('immutable Face model edit failed');
    if(Object.hasOwn(model.unsetNodeProp(edited,node.nodeId,'text').root.props,'text')) throw Error('Face model reset failed');
    const entries = await source.discoverSourceComponentExports('export const Button = () => <button/>;', 'Button.tsx');
    if (entries.length !== 1 || entries[0].exportName !== 'Button') throw Error('source discovery failed');
    const doc = face.decodeFaceJsonContract('{"name":"Button","currentState":{"props":{"label":""}}}');
    if (!doc || face.resolveFaceJsonPreviewProps({}, doc).label !== '') throw Error('Face contract failed');
  `;
  const args = kind === 'esm' ? ['--input-type=module', '-e', script] : ['-e', `(async () => { ${script} })().catch(error => { console.error(error); process.exit(1); });`];
  const result = spawnSync(process.execPath, args, { cwd: ENGINE, encoding: 'utf8', timeout: 10000 });
  check(`${kind} source and Face contract exports execute`, result.status === 0);
  if (result.status !== 0) console.error(result.stderr);
}
try {
  const { buildSync } = require('esbuild');
  const result = buildSync({
    absWorkingDir: ENGINE, stdin: { contents: "export { FaceUi } from '@userface/engine/face-ui/react'; export { decodeFaceJsonContract } from '@userface/engine/face-contract'; export {materializeFaceUiDoc,setNodeProp,unsetNodeProp} from '@userface/engine/face-ui/model'; export {extractReactTsPropsFromSource,extractVuePropsFromSFC,extractSvelteProps} from '@userface/engine/prop-analysis/lightweight';", resolveDir: ENGINE },
    bundle: true, write: false, format: 'esm', platform: 'browser', external: ['react'], metafile: true,
  });
  check('public React and Face contract entries bundle without Node polyfills', result.outputFiles.length === 1);
  check('browser entries do not include the source analyzer or TypeScript', !Object.keys(result.metafile.inputs).some(file => file.includes('typescript') || file.includes('ts-morph') || file.includes('/source/index')));
} catch (error) {
  check(`preview browser exports failed: ${error.message}`, false);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}\n`);
process.exit(failures > 0 ? 1 : 0);
