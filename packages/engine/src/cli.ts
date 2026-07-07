#!/usr/bin/env node
/**
 * Userface Engine CLI
 *
 * Commands:
 *   analyze  <path>               Analyze a component, output ComponentSpec as JSON
 *   states   <path>               Generate all visual states for a component
 *   render   <path> --props '{}'  Render a component with given props (SSR)
 *   test     --dir <path>         Test all components in a directory
 *   registry scan <dir>           Scan directory for components, output registry index
 *   mcp-serve                     Start local MCP server (stdin/stdout)
 */

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, basename, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { readComponentFiles, discoverComponents } from './fs-helpers';
import { createEngine, type CreateEngineOptions, type EngineInstance } from './createEngine';
import { getComponentFaceJsonFileNames } from './faceJsonPaths';
import { withOfflineExecutionPolicy } from './offline-policy';
import {
  checkFromValidationReport,
  createUserfaceProof,
  USERFACE_PROOF_JSON_SCHEMA,
  renderUserfaceProofMarkdown,
  reportFailsThreshold,
  proofStatusFromViolations,
  type UserfaceProofCheck,
  type UserfaceProofFailOn,
} from './proof';
import { createReadinessReport, renderReadinessReportMarkdown } from './readiness';
import { isFaceUiDoc } from './face-ui/schema';
import type { BudgetMode, ValidateMode, ValidationReport, Violation } from './rules/types';

// ---------------------------------------------------------------------------
// Redirect console.log/warn to stderr so stdout stays clean for JSON output
// ---------------------------------------------------------------------------

console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
console.warn = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

// ---------------------------------------------------------------------------
// Dependency resolution: auto-detect from project context
// ---------------------------------------------------------------------------

const _require = createRequire(process.cwd() + '/package.json');

function tryResolve(mod: string): any {
  try {
    return _require(mod);
  } catch {
    return null;
  }
}

function createProjectEngine(): EngineInstance {
  const React = tryResolve('react');
  const ReactDOMServer = tryResolve('react-dom/server');

  if (!React) {
    process.stderr.write('Error: "react" not found in project node_modules.\n');
    process.stderr.write('Make sure you run this command from a project that has React installed.\n');
    process.exit(1);
  }

  const opts: CreateEngineOptions = { React, ReactDOMServer };

  // Optional deps
  const Babel = tryResolve('@babel/standalone');
  if (Babel) opts.Babel = Babel;

  return createEngine(opts);
}

// ---------------------------------------------------------------------------
// Arg parsing (minimal, no deps)
// ---------------------------------------------------------------------------

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function normalizeFailOn(value: string | undefined): UserfaceProofFailOn {
  return value === 'info' || value === 'warning' || value === 'error' ? value : 'error';
}

function normalizeValidateMode(value: string | undefined): ValidateMode {
  return value === 'standard' || value === 'deep' ? value : 'fast';
}

function normalizeBudgetMode(value: string | undefined): BudgetMode {
  return value === 'llm' || value === 'compact' || value === 'verbose' ? value : 'verbose';
}

function nonFlagArgs(args: string[], valueFlags: Set<string>): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg) && index + 1 < args.length && !args[index + 1].startsWith('--')) index++;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function readJsonConfigFile(cwd: string, configPath: string | undefined): Record<string, any> {
  if (!configPath) return {};
  const resolved = resolve(cwd, configPath);
  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error: any) {
    throw new Error(`Could not read guard config ${configPath}: ${error?.message || error}`);
  }
}

function nestedObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayConfig(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function writeOutputFile(path: string, content: string): void {
  const absPath = resolve(process.cwd(), path);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
}

function writeOutputFileAbsolute(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function displayPath(path: string): string {
  const cwd = process.cwd();
  return path.startsWith(cwd)
    ? path.slice(cwd.length + (cwd.endsWith('/') ? 0 : 1))
    : path;
}

function escapeGitHubAnnotationValue(value: unknown): string {
  return String(value ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

function renderProofGitHubAnnotations(proof: { validation: any; composition: any }): string {
  const violations = [
    ...(proof.validation?.violations || []),
    ...(proof.composition?.violations || []),
  ];
  return violations.map((violation: any) => {
    const level = violation?.severity === 'error'
      ? 'error'
      : violation?.severity === 'warning'
        ? 'warning'
        : 'notice';
    const file = violation?.location?.file || 'userface-proof';
    const line = Number(violation?.location?.line || 1);
    const component = violation?.location?.component ? `[${violation.location.component}] ` : '';
    const message = `${component}${violation?.ruleId || 'userface'}: ${violation?.description || 'Userface guard violation'}`;
    return `::${level} file=${escapeGitHubAnnotationValue(file)},line=${line}::${escapeGitHubAnnotationValue(message)}`;
  }).join('\n') + (violations.length ? '\n' : '');
}

function gitValue(cwd: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2500 });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

function createRepoProofSnapshot(cwd: string, paths: string[]) {
  const hash = createHash('sha256');
  hash.update('userface-proof-source-v1\0');
  const sourcePaths = paths.length > 0
    ? paths
    : ['package.json', 'userface.config.json', 'component-registry.json'];

  for (const sourcePath of [...new Set(sourcePaths.map(String).filter(Boolean))].sort()) {
    hash.update(sourcePath);
    hash.update('\0');
    try {
      hash.update(readFileSync(resolve(cwd, sourcePath)));
    } catch {
      hash.update('<missing>');
    }
    hash.update('\0');
  }

  const branch = gitValue(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = gitValue(cwd, ['rev-parse', 'HEAD']);
  return {
    rootHash: `sha256:${hash.digest('hex')}`,
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
  };
}

function previewProofFromArtifactPaths(cwd: string, artifactPaths: string[]) {
  const paths = [...new Set(artifactPaths.map(String).map(item => item.trim()).filter(Boolean))];
  if (paths.length === 0) {
    return {
      status: 'not_run' as const,
      reason: 'CLI guard does not render preview artifacts in v0.',
      artifacts: [],
    };
  }

  const artifacts: string[] = [];
  const missing: string[] = [];
  for (const artifactPath of paths) {
    const absPath = resolve(cwd, artifactPath);
    try {
      const content = readFileSync(absPath);
      const digest = createHash('sha256').update(content).digest('hex');
      artifacts.push(`${displayPath(absPath)}#sha256:${digest}`);
    } catch {
      missing.push(artifactPath);
    }
  }

  if (missing.length > 0) {
    return {
      status: 'failed' as const,
      reason: `Preview artifact(s) were requested but missing: ${missing.join(', ')}.`,
      artifacts,
    };
  }

  return {
    status: 'passed' as const,
    reason: 'Preview evidence artifact(s) were attached and hashed.',
    artifacts,
  };
}

function isLibraryCliEnabled(): boolean {
  return process.env.USERFACE_ENABLE_LIBRARY_CLI === '1';
}

function assertLibraryCliEnabled(command: string): void {
  if (isLibraryCliEnabled()) return;
  process.stderr.write(
    `Error: "${command}" is not part of the public engine CLI yet.\n` +
    'This release only exposes local component analysis, validation, registry, face document, and MCP workflows.\n'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// connect — full onboarding: detect framework, components, generate configs
// ---------------------------------------------------------------------------

function detectFramework(cwd: string): { framework: string; meta: string; typescript: boolean } {
  const result = { framework: 'unknown', meta: '', typescript: false };

  try {
    result.typescript = existsSync(resolve(cwd, 'tsconfig.json'));
  } catch { /* ignore */ }

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8'));
  } catch {
    return result;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (allDeps['next']) { result.framework = 'react'; result.meta = `next@${allDeps['next']}`; }
  else if (allDeps['react']) { result.framework = 'react'; result.meta = `react@${allDeps['react']}`; }
  else if (allDeps['vue']) { result.framework = 'vue'; result.meta = `vue@${allDeps['vue']}`; }
  else if (allDeps['svelte']) { result.framework = 'svelte'; result.meta = `svelte@${allDeps['svelte']}`; }
  else if (allDeps['@angular/core']) { result.framework = 'angular'; result.meta = `angular@${allDeps['@angular/core']}`; }

  return result;
}

function detectComponentsDir(cwd: string): string | null {
  const candidates = [
    'src/components', 'components', 'src/ui', 'lib/components',
    'app/components', 'src/lib/components',
  ];

  let best: string | null = null;
  let bestCount = 0;

  for (const candidate of candidates) {
    const absPath = resolve(cwd, candidate);
    if (!existsSync(absPath)) continue;

    try {
      const dirs = discoverComponents(absPath);
      if (dirs.length > bestCount) {
        bestCount = dirs.length;
        best = candidate;
      }
    } catch { /* ignore */ }
  }

  return best;
}

function ensureCursorMcpJson(cwd: string): boolean {
  const cursorDir = resolve(cwd, '.cursor');
  const mcpPath = resolve(cursorDir, 'mcp.json');

  const userfaceEntry = {
    command: 'npx',
    args: ['userface', 'mcp-serve'],
  };

  let mcpConfig: any = { mcpServers: {} };

  if (existsSync(mcpPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      if (mcpConfig.mcpServers?.userface) return false;
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    } catch {
      mcpConfig = { mcpServers: {} };
    }
  }

  mcpConfig.mcpServers.userface = userfaceEntry;

  if (!existsSync(cursorDir)) {
    mkdirSync(cursorDir, { recursive: true });
  }
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
  return true;
}

function ensureUserfaceConfig(cwd: string, componentsDir: string, framework: string): boolean {
  const configPath = resolve(cwd, 'userface.config.json');

  if (existsSync(configPath)) {
    return false;
  }

  const config = {
    componentsDir,
    framework,
    policyPack: 'base',
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return true;
}

async function cmdConnect(args: string[], config: any = {}) {
  const cwd = process.cwd();
  const overwrite = flagValue(args, '--overwrite') === 'true';
  const dryRun = flagValue(args, '--dry-run') === 'true';
  const out = (msg: string) => process.stderr.write(msg);

  out('\nUserface Connect — setting up your project\n\n');

  // 1. Detect framework
  const detected = detectFramework(cwd);
  if (detected.framework === 'unknown') {
    out('  ! Framework: could not detect (no react/vue/svelte in package.json)\n');
  } else {
    out(`  ✓ Framework: ${detected.framework} (${detected.meta})${detected.typescript ? ' + TypeScript' : ''}\n`);
  }

  // 2. Detect components directory
  const explicitRoot = flagValue(args, '--root') || config.root;
  const componentsDir = explicitRoot || detectComponentsDir(cwd);
  if (!componentsDir) {
    out('  ✗ Components: could not find a components directory\n');
    out('    Hint: use --root <path> to specify manually\n\n');
    process.exit(1);
  }

  const dirs = discoverComponents(resolve(cwd, componentsDir));
  out(`  ✓ Components: ${dirs.length} found in ${componentsDir}/\n`);

  // 3. Generate face.json for components without it
  let existingFaces = 0;
  let generated = 0;
  const engine = createProjectEngine();

  for (const dir of dirs) {
    try {
      const facePath = resolve(dir, 'face.json');
      if (existsSync(facePath) && !overwrite) {
        existingFaces++;
        continue;
      }

      const { files, entry } = readComponentFiles(cwd, dir);
      if (!entry) continue;

      const spec = await engine.analyzeComponent(files, { entryPath: entry });
      if (!spec || !spec.props) continue;

      const face: any = {
        name: spec.name,
        description: `Auto-generated face.json for ${spec.name}`,
        props: {},
        states: [{ name: 'Default', props: {} }],
      };

      for (const p of spec.props) {
        const faceProp: any = {
          type: p.type,
          required: p.required || false,
          description: p.description || '',
        };
        if (p.defaultValue !== undefined) faceProp.default = p.defaultValue;
        if (p.enumValues || p.options) faceProp.options = p.enumValues || p.options;
        face.props[p.name] = faceProp;
      }

      if (dryRun) {
        out(`    [dry-run] would generate face.json for ${basename(dir)}\n`);
      } else {
        writeFileSync(facePath, JSON.stringify(face, null, 2) + '\n', 'utf-8');
      }
      generated++;
    } catch (e: any) {
      out(`    ! Error scanning ${basename(dir)}: ${e.message}\n`);
    }
  }
  out(`  ✓ Face JSON: ${existingFaces} existing, ${generated} generated\n`);

  // 4. Generate userface.config.json
  if (dryRun) {
    out('  [dry-run] would create userface.config.json\n');
  } else {
    const created = ensureUserfaceConfig(cwd, componentsDir, detected.framework);
    out(created ? '  ✓ Config: userface.config.json created\n' : '  ✓ Config: userface.config.json already exists\n');
  }

  // 5. Generate .cursor/mcp.json
  if (dryRun) {
    out('  [dry-run] would create/update .cursor/mcp.json\n');
  } else {
    const created = ensureCursorMcpJson(cwd);
    out(created ? '  ✓ MCP: configured in .cursor/mcp.json\n' : '  ✓ MCP: already configured in .cursor/mcp.json\n');
  }

  // 6. Summary & next steps
  out(`
Next steps:
  1. Restart Cursor to pick up MCP configuration
  2. Ask your AI agent: "List available components using Userface"
  3. Try: "Build a user settings page using my components"

`);
}

async function cmdAnalyze(path: string, config: any = {}) {
  const engine = createProjectEngine();
  const cwd = process.cwd();
  const { files, entry } = readComponentFiles(cwd, path);
  const spec = await engine.analyzeComponent(files, { entryPath: entry });
  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
}

async function cmdStates(path: string, args: string[], config: any = {}) {
  const engine = createProjectEngine();
  const cwd = process.cwd();
  const { files, entry } = readComponentFiles(cwd, path);
  const spec = await engine.analyzeComponent(files, { entryPath: entry });

  // Optional: read manual states from face.json
  let manualStates: Record<string, Record<string, any>> | undefined;
  const facePath = flagValue(args, '--face');
  if (facePath) {
    try {
      const face = JSON.parse(readFileSync(resolve(cwd, facePath), 'utf-8'));
      if (face.states && typeof face.states === 'object') {
        manualStates = face.states;
      }
    } catch { /* ignore */ }
  }

  const states = engine.generateStates(spec.props, { manualStates });
  process.stdout.write(JSON.stringify(states, null, 2) + '\n');
}

async function cmdRender(path: string, args: string[], config: any = {}) {
  const engine = createProjectEngine();
  const cwd = process.cwd();
  const { files, entry } = readComponentFiles(cwd, path);
  const spec = await engine.analyzeComponent(files, { entryPath: entry });

  const propsJson = flagValue(args, '--props') || '{}';
  let props: any;
  try {
    props = JSON.parse(propsJson);
  } catch {
    process.stderr.write(`Error: invalid JSON in --props: ${propsJson}\n`);
    process.exit(1);
  }

  const result = await engine.renderFromSpec(spec.name, props, 'ssr');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function cmdMaterialize(path: string, args: string[], config: any = {}) {
  const { generateCode } = await import('./face-ui/codegen');
  const cwd = process.cwd();
  const abs = resolve(cwd, path);
  
  let doc: any;
  try {
    doc = JSON.parse(readFileSync(abs, 'utf-8'));
  } catch (e: any) {
    process.stderr.write(`Error reading face document: ${e.message}\n`);
    process.exit(1);
  }

  try {
    const fwRaw = flagValue(args, '--framework') || 'react';
    let framework: 'react' | 'vue' | 'html' = 'react';
    if (fwRaw === 'vue') framework = 'vue';
    if (fwRaw === 'html') framework = 'html';
    
    const code = generateCode(doc, { componentName: 'MaterializedUI', framework });
    const outPath = flagValue(args, '--output');
    if (outPath) {
      writeFileSync(resolve(cwd, outPath), code, 'utf-8');
      process.stderr.write(`✓ Materialized to ${outPath}\n`);
    } else {
      process.stdout.write(code + '\n');
    }
  } catch (e: any) {
    process.stderr.write(`Error materializing: ${e.message}\n`);
    process.exit(1);
  }
}

async function cmdDoctor(args: string[], config: any = {}) {
  const cwd = process.cwd();
  let issues = 0;
  
  process.stdout.write('🩺 Userface Doctor\n\n');
  
  process.stdout.write('Checking Node.js version... ');
  const nodeVer = process.versions.node;
  if (parseInt(nodeVer.split('.')[0], 10) < 18) {
    process.stdout.write(`❌ ${nodeVer} (requires >= 18)\n`);
    issues++;
  } else {
    process.stdout.write(`✅ ${nodeVer}\n`);
  }
  
  process.stdout.write('Checking configuration... ');
  if (Object.keys(config).length > 0) {
    process.stdout.write('✅ Found\n');
  } else {
    process.stdout.write('⚠️ No userface.config.ts found (using defaults)\n');
  }
  
  process.stdout.write('Checking React dependency... ');
  const react = tryResolve('react');
  if (react) {
    process.stdout.write(`✅ Found\n`);
  } else {
    process.stdout.write(`❌ Not found in node_modules\n`);
    issues++;
  }
  
  process.stdout.write('Checking Component directories... ');
  const rootDir = resolve(cwd, config.root || './src/components');
  try {
    const dirs = discoverComponents(rootDir);
    process.stdout.write(`✅ Found ${dirs.length} components in ${config.root || './src/components'}\n`);
  } catch {
    process.stdout.write(`❌ Missing directory: ${rootDir}\n`);
    issues++;
  }
  
  process.stdout.write('\n');
  if (issues > 0) {
    process.stdout.write(`Status: ⚠️ Found ${issues} issues. Please fix them to ensure Userface Engine works correctly.\n`);
    process.exit(1);
  } else {
    process.stdout.write('Status: ✅ All checks passed. Userface Engine is ready to go!\n');
  }
}

async function cmdTest(args: string[], config: any = {}) {
  const engine = createProjectEngine();
  const cwd = process.cwd();
  const dir = flagValue(args, '--dir') || args[0] || '.';
  const runA11y = !args.includes('--no-a11y');

  const components = discoverComponents(resolve(cwd, dir));

  // Lazy-load a11y tooling (optional deps: jsdom + axe-core)
  let axeRun: ((html: string) => Promise<Array<{ id: string; impact: string; description: string }>>) | null = null;
  if (runA11y) {
    try {
      const { JSDOM } = _require('jsdom');
      const axe = _require('axe-core');
      axeRun = async (html: string) => {
        const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
          runScripts: 'dangerously',
          pretendToBeVisual: true,
        });
        const results = await axe.run(dom.window.document.body, {
          rules: { region: { enabled: false } },
        });
        dom.window.close();
        return (results.violations || []).map((v: any) => ({
          id: String(v.id || ''),
          impact: String(v.impact || 'minor'),
          description: String(v.description || ''),
        }));
      };
    } catch {
      process.stderr.write('Warning: jsdom or axe-core not found, skipping a11y checks.\n');
      process.stderr.write('Install with: npm install -D jsdom axe-core\n');
    }
  }

  const report = {
    total: 0,
    passed: 0,
    failed: 0,
    a11yViolations: 0,
    components: 0,
    results: [] as Array<{
      component: string;
      state: string;
      status: 'pass' | 'fail' | 'error';
      error?: string;
      a11y?: Array<{ id: string; impact: string; description: string }>;
    }>,
  };

  for (const compDir of components) {
    report.components++;
    try {
      const { files, entry } = readComponentFiles(cwd, compDir);
      if (!entry) continue;

      const spec = await engine.analyzeComponent(files, { entryPath: entry });
      const states = engine.generateStates(spec.props);

      for (const state of states) {
        report.total++;
        try {
          const renderResult = await engine.renderFromSpec(spec.name, state.props, 'ssr');
          const html = typeof renderResult === 'string'
            ? renderResult
            : String((renderResult as any)?.data?.componentCode || (renderResult as any)?.html || renderResult || '');

          // a11y audit on rendered HTML
          let a11yIssues: Array<{ id: string; impact: string; description: string }> = [];
          if (axeRun && html) {
            try {
              a11yIssues = await axeRun(html);
            } catch {}
          }

          if (a11yIssues.length > 0) {
            report.a11yViolations += a11yIssues.length;
          }

          report.passed++;
          report.results.push({
            component: spec.name,
            state: state.name,
            status: 'pass',
            ...(a11yIssues.length > 0 ? { a11y: a11yIssues } : {}),
          });
        } catch (e: any) {
          report.failed++;
          report.results.push({
            component: spec.name,
            state: state.name,
            status: 'fail',
            error: String(e?.message || e),
          });
        }
      }
    } catch (e: any) {
      report.total++;
      report.failed++;
      report.results.push({
        component: basename(compDir),
        state: 'analyze',
        status: 'error',
        error: String(e?.message || e),
      });
    }
  }

  const exitCode = report.failed > 0 ? 1 : 0;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => {
    process.exit(exitCode);
  });
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

function singleViolationReport(
  component: string,
  violation: Violation,
): ValidationReport {
  return {
    component,
    mode: 'fast',
    durationMs: 0,
    scores: { overall: 0, structural: 0, contract: 0, accessibility: 0, complexity: 0 },
    violations: [violation],
    violationsTotal: 1,
    violationsShown: 1,
    summary: violation.description,
  };
}

function withTargetFileLocations(report: ValidationReport, targetPath: string): ValidationReport {
  return {
    ...report,
    violations: report.violations.map((violation) => ({
      ...violation,
      location: {
        ...violation.location,
        file: violation.location.file || targetPath,
      },
    })),
  };
}

function loadComponentFaceJson(cwd: string, targetPath: string, componentName: string): unknown | undefined {
  const absPath = resolve(cwd, targetPath);
  let dir = dirname(absPath);
  try {
    if (statSync(absPath).isDirectory()) dir = absPath;
  } catch {
    // readComponentFiles will report the real source-path problem; face.json is best-effort.
  }
  const candidates = getComponentFaceJsonFileNames(componentName)
    .map((fileName) => resolve(dir, fileName));
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8'));
    } catch {
      // try next naming convention
    }
  }
  return undefined;
}

function mergedReportCheck(
  reports: ValidationReport[],
  emptyReason: string,
): UserfaceProofCheck {
  const violations = reports.flatMap(report => report.violations || []);
  return {
    status: reports.length === 0 ? 'not_run' : violations.length > 0 ? 'failed' : 'passed',
    score: reports.length
      ? Math.round(reports.reduce((sum, report) => sum + (report.scores?.overall || 0), 0) / reports.length)
      : undefined,
    reason: reports.length ? `${reports.length} target(s) checked` : emptyReason,
    violations,
  };
}

async function validateComponentSourceTarget(
  targetPath: string,
  options: {
    cwd: string;
    mode: ValidateMode;
    budget: BudgetMode;
  },
): Promise<ValidationReport> {
  const { RuleEngine, basePolicyPack } = await import('./rules/index');
  const engine = createProjectEngine();
  const { files, entry } = readComponentFiles(options.cwd, targetPath);
  const spec = await engine.analyzeComponent(files, { entryPath: entry });

  const ruleEngine = new RuleEngine();
  ruleEngine.loadPolicyPack(basePolicyPack);

  const code = files.find(f => f.name === entry)?.content;
  const faceJson = loadComponentFaceJson(options.cwd, targetPath, spec.name);
  let report = ruleEngine.validate(spec, {
    mode: options.mode,
    budget: options.budget,
    code,
    faceJson,
  });

  if (options.mode === 'standard' || options.mode === 'deep') {
    const axeViolations = await runAxeOnComponent(engine, spec, options.mode === 'deep');
    if (axeViolations.length > 0) {
      report.violations.push(...axeViolations);
      report.violationsTotal += axeViolations.length;
      report.violationsShown += axeViolations.length;
      report.scores.accessibility = Math.max(0, report.scores.accessibility - axeViolations.length * 10);
      report.scores.overall = Math.round(
        (report.scores.structural + report.scores.contract + report.scores.accessibility + report.scores.complexity) / 4
      );
      report.summary = `${spec.name}: ${report.violationsTotal} issue(s) found (score: ${report.scores.overall}/100)`;
    }
  }

  report = {
    ...report,
    violations: report.violations.map(violation => ({
      ...violation,
      location: {
        ...violation.location,
        file: violation.location?.file || targetPath,
      },
    })),
  };

  return report;
}

async function cmdValidate(path: string, args: string[], config: any = {}) {
  const cwd = process.cwd();

  const modeArg = normalizeValidateMode(flagValue(args, '--mode') || stringConfig(config?.validate?.mode));
  const budgetArg = normalizeBudgetMode(flagValue(args, '--budget') || stringConfig(config?.validate?.budget));
  const failOnArg = (flagValue(args, '--fail-on') || 'error') as 'error' | 'warning' | 'info';
  const ciMode = args.includes('--ci');
  const formatArg = flagValue(args, '--format') || (ciMode ? 'json' : 'json');
  const isGitHubAnnotations = formatArg === 'github-annotations';
  const report = await validateComponentSourceTarget(path, { cwd, mode: modeArg, budget: budgetArg });

  // Output
  if (isGitHubAnnotations) {
    // GitHub Actions annotations format
    for (const v of report.violations) {
      const level = v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warning' : 'notice';
      const file = v.location?.file || path;
      const line = v.location?.line || 1;
      process.stdout.write(`::${level} file=${file},line=${line}::${v.ruleId}: ${v.description}\n`);
    }
  } else {
    // JSON output (compact in CI mode)
    const indent = ciMode ? 0 : 2;
    process.stdout.write(JSON.stringify(report, null, indent) + '\n');
  }

  // Exit code
  process.stdout.write('', () => {
    let shouldFail = false;
    if (failOnArg === 'info' && report.violations.length > 0) shouldFail = true;
    if (failOnArg === 'warning' && report.violations.some(v => v.severity === 'warning' || v.severity === 'error')) shouldFail = true;
    if (failOnArg === 'error' && report.violations.some(v => v.severity === 'error')) shouldFail = true;

    process.exit(shouldFail ? 1 : 0);
  });
}

async function runAxeOnComponent(
  engine: ReturnType<typeof createProjectEngine>,
  spec: any,
  deep: boolean,
): Promise<import('./rules/types').Violation[]> {
  const violations: import('./rules/types').Violation[] = [];

  let axeRun: ((html: string) => Promise<Array<{ id: string; impact: string; description: string }>>) | null = null;
  try {
    const { JSDOM } = _require('jsdom');
    const axe = _require('axe-core');
    axeRun = async (html: string) => {
      const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
      });
      const results = await axe.run(dom.window.document.body, {
        rules: { region: { enabled: false } },
      });
      dom.window.close();
      return (results.violations || []).map((v: any) => ({
        id: String(v.id || ''),
        impact: String(v.impact || 'minor'),
        description: String(v.description || ''),
      }));
    };
  } catch {
    return violations;
  }

  const states = deep
    ? engine.generateStates(spec.props, { maxStates: 16 })
    : [{ name: 'default', props: {} }];

  for (const state of states) {
    try {
      const result = await engine.renderFromSpec(spec.name, state.props, 'ssr');
      const html = typeof result === 'string'
        ? result
        : String((result as any)?.data?.componentCode || (result as any)?.html || result || '');
      if (!html || !axeRun) continue;

      const axeIssues = await axeRun(html);
      for (const issue of axeIssues) {
        violations.push({
          ruleId: `axe/${issue.id}`,
          description: issue.description,
          severity: issue.impact === 'critical' || issue.impact === 'serious' ? 'error' : 'warning',
          confidence: 0.95,
          category: 'a11y',
          location: { component: spec.name },
          fixHint: `axe-core: ${issue.id} (${issue.impact})`,
        });
      }
    } catch { /* render error — ignore for validation */ }
  }

  // Deduplicate axe violations by ruleId
  const seen = new Set<string>();
  return violations.filter(v => {
    if (seen.has(v.ruleId)) return false;
    seen.add(v.ruleId);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Registry scan
// ---------------------------------------------------------------------------

async function cmdRegistryScan(subArgs: string[], config: any = {}) {
  const { scanRegistry } = await import('./registry');
  const cwd = process.cwd();
  const dir = flagValue(subArgs, '--dir') || subArgs.find(a => !a.startsWith('--')) || '.';
  const format = flagValue(subArgs, '--format') || 'json';
  const registryConfig = nestedObject(config?.registry);
  const recursive = hasFlag(subArgs, '--no-recursive')
    ? false
    : hasFlag(subArgs, '--recursive')
      || (typeof registryConfig.recursive === 'boolean' ? registryConfig.recursive : false);
  const configuredMaxDepth = typeof registryConfig.maxDepth === 'number'
    ? registryConfig.maxDepth
    : Number(registryConfig.maxDepth);
  const maxDepth = Number(flagValue(subArgs, '--max-depth') || (Number.isFinite(configuredMaxDepth) ? configuredMaxDepth : 8));

  const index = scanRegistry(resolve(cwd, dir), { recursive, maxDepth });

  if (format === 'summary') {
    const lines: string[] = [
      `Registry: ${index.root}`,
      `Components: ${index.components.length}`,
      `Scanned in: ${index.durationMs}ms`,
      '',
    ];
    for (const c of index.components) {
      const faceTag = c.hasFaceJson ? ' [face.json]' : '';
      const propsTag = c.props.length > 0 ? ` (${c.props.length} props)` : '';
      lines.push(`  ${c.name} — ${c.framework}${faceTag}${propsTag}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  } else {
    process.stdout.write(JSON.stringify(index, null, 2) + '\n');
  }
}

async function cmdReadiness(args: string[], config: any = {}) {
  const readinessConfig = nestedObject(config?.readiness);
  const root = resolve(
    process.cwd(),
    flagValue(args, '--root')
      || stringConfig(readinessConfig.root)
      || stringConfig(config.root)
      || '.',
  );
  const componentsDir = flagValue(args, '--components-dir')
    || flagValue(args, '--dir')
    || stringConfig(readinessConfig.componentsDir)
    || stringConfig(readinessConfig.dir)
    || null;
  const uiDocumentArg = flagValue(args, '--ui-doc') || flagValue(args, '--ui-document') || '';
  const uiDocumentPaths = uiDocumentArg
    ? uiDocumentArg.split(',').map(item => item.trim()).filter(Boolean)
    : stringArrayConfig(readinessConfig.uiDocuments)
      || stringArrayConfig(readinessConfig.uiDocumentPaths)
      || stringArrayConfig(readinessConfig.uiDoc)
      || undefined;
  const format = flagValue(args, '--format') || (process.stdout.isTTY ? 'summary' : 'json');
  const outputPath = flagValue(args, '--output');
  const summaryPath = flagValue(args, '--summary');
  const recursive = hasFlag(args, '--no-recursive')
    ? false
    : typeof readinessConfig.recursive === 'boolean'
      ? readinessConfig.recursive
      : true;
  const configuredMaxDepth = typeof readinessConfig.maxDepth === 'number'
    ? readinessConfig.maxDepth
    : Number(readinessConfig.maxDepth);
  const maxDepth = Number(flagValue(args, '--max-depth') || (Number.isFinite(configuredMaxDepth) ? configuredMaxDepth : 8));
  const writeDefaultArtifacts = !hasFlag(args, '--no-write') && (
    hasFlag(args, '--write')
    || hasFlag(args, '--save')
    || Boolean(outputPath)
    || Boolean(summaryPath)
    || Boolean(process.stdout.isTTY)
  );
  const report = createReadinessReport({
    root,
    componentsDir,
    uiDocumentPaths,
    recursive,
    maxDepth,
  });
  const markdown = renderReadinessReportMarkdown(report);
  const writtenPaths: Array<{ label: string; path: string }> = [];
  if (writeDefaultArtifacts) {
    if (outputPath) {
      writeOutputFile(outputPath, JSON.stringify(report, null, 2) + '\n');
      writtenPaths.push({ label: 'JSON', path: resolve(process.cwd(), outputPath) });
    } else {
      const defaultJsonPath = resolve(root, '.userface/readiness/userface-readiness-report.json');
      writeOutputFileAbsolute(defaultJsonPath, JSON.stringify(report, null, 2) + '\n');
      writtenPaths.push({ label: 'JSON', path: defaultJsonPath });
    }
    if (summaryPath) {
      writeOutputFile(summaryPath, markdown);
      writtenPaths.push({ label: 'Markdown', path: resolve(process.cwd(), summaryPath) });
    } else {
      const defaultMarkdownPath = resolve(root, '.userface/readiness/userface-readiness-report.md');
      writeOutputFileAbsolute(defaultMarkdownPath, markdown);
      writtenPaths.push({ label: 'Markdown', path: defaultMarkdownPath });
    }
  }
  if (format === 'summary' || format === 'markdown') {
    process.stdout.write(markdown);
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
  for (const artifact of writtenPaths) {
    process.stderr.write(`✓ Readiness ${artifact.label}: ${displayPath(artifact.path)}\n`);
  }
  if (report.status === 'blocked') process.exit(1);
}

async function cmdDiff(args: string[], _config: any = {}) {
  const { diffFaces } = await import('./diff');
  const basePath = flagValue(args, '--base') || args[0];
  const headPath = flagValue(args, '--head') || args[1];

  if (!basePath || !headPath) {
    process.stderr.write('Error: both --base and --head paths required\nUsage: userface diff --base old.face.json --head new.face.json\n');
    process.exit(1);
  }

  const cwd = process.cwd();
  let oldFace: any, newFace: any;

  try {
    oldFace = JSON.parse(readFileSync(resolve(cwd, basePath), 'utf-8'));
  } catch (e: any) {
    process.stderr.write(`Error reading base: ${e.message}\n`);
    process.exit(1);
  }
  try {
    newFace = JSON.parse(readFileSync(resolve(cwd, headPath), 'utf-8'));
  } catch (e: any) {
    process.stderr.write(`Error reading head: ${e.message}\n`);
    process.exit(1);
  }

  const result = diffFaces(oldFace, newFace);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.hasBreaking) process.exit(1);
}

async function cmdCompositionValidate(targetPath: string, args: string[], config: any = {}) {
  const { validateComposition } = await import('./face-ui/compositionValidator');
  const cwd = process.cwd();
  const absPath = resolve(cwd, targetPath);
  const compositionConfig = nestedObject(config?.composition);
  const readinessConfig = nestedObject(config?.readiness);

  let doc: any;
  try {
    doc = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (e: any) {
    process.stderr.write(`Error reading face document: ${e.message}\n`);
    process.exit(1);
  }

  const registryDir = flagValue(args, '--registry-dir')
    || flagValue(args, '--dir')
    || stringConfig(compositionConfig.registryDir)
    || stringConfig(compositionConfig.dir)
    || stringConfig(readinessConfig.componentsDir)
    || stringConfig(readinessConfig.dir);
  const registryManifestPath = flagValue(args, '--registry-manifest')
    || flagValue(args, '--registry-manifest-path')
    || stringConfig(compositionConfig.registryManifest)
    || stringConfig(compositionConfig.registryManifestPath);
  const patternsRaw = flagValue(args, '--patterns');
  const budget = flagValue(args, '--budget') || 'verbose';
  const enforceRegistryBoundary = hasFlag(args, '--enforce-registry-boundary');
  const failOn = normalizeFailOn(flagValue(args, '--fail-on'));
  const recursive = hasFlag(args, '--no-recursive')
    ? false
    : hasFlag(args, '--recursive')
      || (typeof compositionConfig.recursive === 'boolean'
        ? compositionConfig.recursive
        : typeof readinessConfig.recursive === 'boolean'
          ? readinessConfig.recursive
          : true);
  const configuredMaxDepth = typeof compositionConfig.maxDepth === 'number'
    ? compositionConfig.maxDepth
    : typeof readinessConfig.maxDepth === 'number'
      ? readinessConfig.maxDepth
      : Number(compositionConfig.maxDepth ?? readinessConfig.maxDepth);
  const maxDepth = Number(flagValue(args, '--max-depth') || (Number.isFinite(configuredMaxDepth) ? configuredMaxDepth : 8));

  let registry: any[] | undefined;
  if (registryDir) {
    const { scanRegistry } = await import('./registry');
    const index = scanRegistry(resolve(cwd, registryDir), { recursive, maxDepth, cache: false });
    registry = index.components;
  }

  const patterns = patternsRaw ? patternsRaw.split(',').map(s => s.trim()) : undefined;

  const report = validateComposition(doc, {
    registry,
    registryManifestPath: registryManifestPath ? resolve(cwd, registryManifestPath) : undefined,
    patterns,
    enforceRegistryBoundary,
    budget: budget as any,
  });

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('', () => {
    process.exit(reportFailsThreshold(report, failOn) ? 1 : 0);
  });
}

const COMPONENT_SOURCE_PATH_RE = /\.(tsx|jsx|vue|svelte)$/i;
const GUARDED_INPUT_PATH_RE = /(^|\/)(component-registry\.json|userface\.guard\.json|userface\.config\.(json|js|ts)|tailwind\.config\.(js|cjs|mjs|ts)|tokens\.json|design-tokens\.json|tokens\.css|theme\.ts|globals\.css)$/i;

async function changedGuardTargetPaths(cwd: string): Promise<{ paths: string[]; unresolvedInputs: string[] }> {
  const { spawnSync } = await import('node:child_process');
  const commands = [
    ['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD'],
    ['diff', '--name-only', '--cached', '--diff-filter=ACMRT'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  const paths = new Set<string>();
  const unresolvedInputs = new Set<string>();

  for (const gitArgs of commands) {
    const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) continue;
    for (const line of result.stdout.split(/\r?\n/)) {
      const path = line.trim();
      if (!path) continue;
      if (COMPONENT_SOURCE_PATH_RE.test(path)) {
        paths.add(path);
        continue;
      }
      const isGuardedInput = GUARDED_INPUT_PATH_RE.test(path);
      if (!path.endsWith('.json')) {
        if (isGuardedInput) unresolvedInputs.add(path);
        continue;
      }
      try {
        const doc = JSON.parse(readFileSync(resolve(cwd, path), 'utf-8'));
        if (isFaceUiDoc(doc)) {
          paths.add(path);
          continue;
        }
      } catch {
        // Ignore non-face JSON or deleted paths in changed-file discovery.
      }
      try {
        readComponentFiles(cwd, dirname(path));
        paths.add(dirname(path));
      } catch {
        // Ignore JSON files that are not face documents or component contracts.
        if (isGuardedInput) unresolvedInputs.add(path);
      }
    }
  }

  return {
    paths: [...paths].sort(),
    unresolvedInputs: [...unresolvedInputs].sort(),
  };
}

function collectUiComponentTypes(node: any, output: Set<string>) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string' && node.type) output.add(node.type);
  if (!Array.isArray(node.children)) return;
  for (const child of node.children) collectUiComponentTypes(child, output);
}

async function cmdGuard(args: string[], _config: any = {}) {
  const cwd = process.cwd();
  const guardConfig = {
    ...nestedObject(_config?.guard),
    ...readJsonConfigFile(cwd, flagValue(args, '--config')),
  };
  const offline = hasFlag(args, '--offline') || Boolean(guardConfig.offline);
  return withOfflineExecutionPolicy(offline, 'userface guard --offline', () => cmdGuardUnsafe(args, _config));
}

async function cmdGuardUnsafe(args: string[], _config: any = {}) {
  const { validateComposition } = await import('./face-ui/compositionValidator');
  const cwd = process.cwd();
  const valueFlags = new Set([
    '--config',
    '--fail-on',
    '--format',
    '--proof',
    '--summary',
    '--registry-dir',
    '--dir',
    '--registry-manifest',
    '--registry-manifest-path',
    '--preview-artifact',
    '--preview-artifacts',
    '--patterns',
    '--budget',
    '--mode',
    '--max-depth',
  ]);
  const guardConfig = {
    ...nestedObject(_config?.guard),
    ...readJsonConfigFile(cwd, flagValue(args, '--config')),
  };
  const readinessConfig = nestedObject(_config?.readiness);
  const failOn = normalizeFailOn(flagValue(args, '--fail-on') || stringConfig(guardConfig.failOn));
  const proofPath = flagValue(args, '--proof') || stringConfig(guardConfig.proof);
  const summaryPath = flagValue(args, '--summary') || stringConfig(guardConfig.summary);
  const writeDefaultArtifacts = hasFlag(args, '--write') || hasFlag(args, '--save') || Boolean(guardConfig.write || guardConfig.save);
  const format = flagValue(args, '--format') || stringConfig(guardConfig.format) || 'json';
  const isGitHubAnnotations = hasFlag(args, '--annotations') || format === 'github-annotations';
  const previewArtifactPaths = stringArrayConfig(flagValue(args, '--preview-artifact'))
    || stringArrayConfig(flagValue(args, '--preview-artifacts'))
    || stringArrayConfig(guardConfig.previewArtifact)
    || stringArrayConfig(guardConfig.previewArtifacts)
    || [];
  const registryDir = flagValue(args, '--registry-dir')
    || flagValue(args, '--dir')
    || stringConfig(guardConfig.registryDir)
    || stringConfig(guardConfig.dir)
    || stringConfig(readinessConfig.componentsDir)
    || stringConfig(readinessConfig.dir);
  const registryManifestPath = flagValue(args, '--registry-manifest')
    || flagValue(args, '--registry-manifest-path')
    || stringConfig(guardConfig.registryManifest)
    || stringConfig(guardConfig.registryManifestPath);
  const patterns = stringArrayConfig(flagValue(args, '--patterns')) || stringArrayConfig(guardConfig.patterns);
  const budget = flagValue(args, '--budget') || stringConfig(guardConfig.budget) || 'verbose';
  const enforceRegistryBoundary = hasFlag(args, '--enforce-registry-boundary') || Boolean(guardConfig.enforceRegistryBoundary);
  const recursive = hasFlag(args, '--no-recursive')
    ? false
    : hasFlag(args, '--recursive')
      || (typeof guardConfig.recursive === 'boolean'
        ? guardConfig.recursive
        : typeof readinessConfig.recursive === 'boolean'
          ? readinessConfig.recursive
          : true);
  const configuredMaxDepth = typeof guardConfig.maxDepth === 'number'
    ? guardConfig.maxDepth
    : typeof readinessConfig.maxDepth === 'number'
      ? readinessConfig.maxDepth
      : Number(guardConfig.maxDepth ?? readinessConfig.maxDepth);
  const maxDepth = Number(flagValue(args, '--max-depth') || (Number.isFinite(configuredMaxDepth) ? configuredMaxDepth : 8));
  const explicitPaths = nonFlagArgs(args, valueFlags);
  const configuredPaths = stringArrayConfig(guardConfig.paths) || stringArrayConfig(guardConfig.targets) || [];
  const selectedPaths = explicitPaths.length > 0 ? explicitPaths : configuredPaths;
  const changedMode = hasFlag(args, '--changed') || Boolean(guardConfig.changed);
  const changedTargets = changedMode
    ? await changedGuardTargetPaths(cwd)
    : { paths: [], unresolvedInputs: [] };
  const targetPaths = changedMode
    ? [...new Set([...selectedPaths, ...changedTargets.paths])].sort()
    : selectedPaths;

  let registry: any[] | undefined;
  if (registryDir) {
    const { scanRegistry } = await import('./registry');
    const index = scanRegistry(resolve(cwd, registryDir), { recursive, maxDepth, cache: false });
    registry = index.components;
  }

  const compositionReports: ValidationReport[] = [];
  const validationReports: ValidationReport[] = [];
  const summaries: string[] = [];
  const usedComponentTypes = new Set<string>();
  const sourceValidationOptions = {
    cwd,
    mode: normalizeValidateMode(flagValue(args, '--mode') || stringConfig(guardConfig.mode)),
    budget: normalizeBudgetMode(budget),
  };

  if (changedMode && selectedPaths.length === 0 && targetPaths.length === 0 && changedTargets.unresolvedInputs.length > 0) {
    const inputList = changedTargets.unresolvedInputs.join(', ');
    const message = `Changed guard-affecting input(s) need an explicit UI or component target: ${inputList}`;
    summaries.push(message);
    validationReports.push(singleViolationReport(changedTargets.unresolvedInputs[0], {
      ruleId: 'guard/changed-input-needs-target',
      description: message,
      severity: 'error',
      confidence: 1,
      category: 'contract',
      location: { file: changedTargets.unresolvedInputs[0] },
      fixHint: 'Run guard with an explicit face document or component path affected by this registry/config/token/style change.',
    }));
  }

  for (const targetPath of targetPaths) {
    const absPath = resolve(cwd, targetPath);
    if (targetPath.endsWith('.json')) {
      let doc: any;
      try {
        doc = JSON.parse(readFileSync(absPath, 'utf-8'));
      } catch (error: any) {
        const message = `Could not read ${targetPath}: ${error?.message || error}`;
        summaries.push(message);
        compositionReports.push(singleViolationReport(targetPath, {
          ruleId: 'guard/read-file',
          description: message,
          severity: 'error',
          confidence: 1,
          category: 'contract',
          location: { file: targetPath },
          fixHint: 'Check that the target path exists and is a readable face JSON document.',
        }));
        continue;
      }

      if (!isFaceUiDoc(doc)) {
        try {
          const report = await validateComponentSourceTarget(dirname(targetPath), sourceValidationOptions);
          validationReports.push(report);
          usedComponentTypes.add(report.component);
          summaries.push(`${targetPath}: ${report.summary}`);
          continue;
        } catch {
          // Report a clear unsupported-target violation below.
        }
        const message = `${targetPath} is not a face document`;
        summaries.push(message);
        compositionReports.push(singleViolationReport(targetPath, {
          ruleId: 'guard/unsupported-target',
          description: message,
          severity: 'error',
          confidence: 1,
          category: 'contract',
          location: { file: targetPath },
          fixHint: 'Pass a face JSON document, component source file, or component directory to guard.',
        }));
        continue;
      }

      collectUiComponentTypes(doc.root, usedComponentTypes);

      const report = validateComposition(doc, {
        registry,
        registryManifestPath: registryManifestPath ? resolve(cwd, registryManifestPath) : undefined,
        patterns,
        enforceRegistryBoundary,
        budget: budget as any,
      });
      compositionReports.push(withTargetFileLocations(report, targetPath));
      summaries.push(`${targetPath}: ${report.summary}`);
      continue;
    }

    try {
      const report = await validateComponentSourceTarget(targetPath, sourceValidationOptions);
      validationReports.push(report);
      usedComponentTypes.add(report.component);
      summaries.push(`${targetPath}: ${report.summary}`);
    } catch (error: any) {
      const message = `Could not validate component source ${targetPath}: ${error?.message || error}`;
      summaries.push(message);
      validationReports.push(singleViolationReport(targetPath, {
        ruleId: 'guard/read-component-source',
        description: message,
        severity: 'error',
        confidence: 1,
        category: 'contract',
        location: { file: targetPath },
        fixHint: 'Pass an existing component entry file or directory with a .tsx/.jsx/.vue/.svelte entry.',
      }));
    }
  }

  const violations = [...compositionReports, ...validationReports].flatMap(report => report.violations || []);
  const registryByName = new Map((registry || []).map(component => [component.name, component]));
  const usedComponents = [...usedComponentTypes].sort();
  const preview = previewProofFromArtifactPaths(cwd, previewArtifactPaths);
  const status = preview.status === 'failed'
    ? 'blocked'
    : violations.length > 0
      ? proofStatusFromViolations(violations, failOn)
      : targetPaths.length === 0
    ? 'passed'
    : proofStatusFromViolations(violations, failOn);
  const proof = createUserfaceProof({
    status,
    repo: createRepoProofSnapshot(cwd, targetPaths),
    target: {
      kind: 'pr_gate',
      paths: targetPaths,
    },
    components: {
      total: usedComponents.length,
      contracted: usedComponents.filter(component => Boolean(registryByName.get(component)?.hasFaceJson)).length,
      used: usedComponents,
    },
    composition: compositionReports.length === 1
      ? checkFromValidationReport(compositionReports[0])
      : mergedReportCheck(compositionReports, 'No face composition documents checked'),
    validation: validationReports.length === 1
      ? checkFromValidationReport(validationReports[0])
      : mergedReportCheck(validationReports, 'No component source targets checked'),
    preview,
    egress: {
      mode: hasFlag(args, '--offline') || Boolean(guardConfig.offline) ? 'offline' : 'local',
      modelCalls: 0,
      filesConsidered: targetPaths.length,
      filesSent: 0,
      bytesSent: 0,
      absolutePathsSent: false,
      remoteTelemetry: false,
      network: false,
    },
    pr: {
      provider: isGitHubAnnotations ? 'github' : 'none',
      annotations: violations.length,
      ...(summaryPath ? { summaryPath } : {}),
    },
    summaries,
  });

  const markdown = renderUserfaceProofMarkdown(proof);
  const writtenPaths: Array<{ label: string; path: string }> = [];
  if (proofPath) {
    writeOutputFile(proofPath, JSON.stringify(proof, null, 2) + '\n');
    writtenPaths.push({ label: 'Proof JSON', path: resolve(process.cwd(), proofPath) });
  } else if (writeDefaultArtifacts) {
    const defaultProofPath = resolve(cwd, '.userface/proofs/userface-proof.json');
    writeOutputFileAbsolute(defaultProofPath, JSON.stringify(proof, null, 2) + '\n');
    writtenPaths.push({ label: 'Proof JSON', path: defaultProofPath });
  }
  if (summaryPath) {
    writeOutputFile(summaryPath, markdown);
    writtenPaths.push({ label: 'Proof Markdown', path: resolve(process.cwd(), summaryPath) });
  } else if (writeDefaultArtifacts) {
    const defaultSummaryPath = resolve(cwd, '.userface/proofs/userface-proof.md');
    writeOutputFileAbsolute(defaultSummaryPath, markdown);
    writtenPaths.push({ label: 'Proof Markdown', path: defaultSummaryPath });
  }

  if (isGitHubAnnotations) {
    process.stdout.write(renderProofGitHubAnnotations(proof));
  } else if (format === 'summary' || format === 'markdown') {
    process.stdout.write(markdown);
  } else {
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  }
  for (const artifact of writtenPaths) {
    process.stderr.write(`✓ Guard ${artifact.label}: ${displayPath(artifact.path)}\n`);
  }

  process.stdout.write('', () => {
    process.exit(status === 'blocked' ? 1 : 0);
  });
}

async function cmdTrust(args: string[], _config: any = {}) {
  return withOfflineExecutionPolicy(true, 'userface trust', () => cmdTrustUnsafe(args, _config));
}

async function cmdTrustUnsafe(args: string[], _config: any = {}) {
  const cwd = process.cwd();
  const valueFlags = new Set(['--format', '--output', '--summary']);
  const format = flagValue(args, '--format') || 'json';
  const outputPath = flagValue(args, '--output');
  const summaryPath = flagValue(args, '--summary');
  const targetPaths = nonFlagArgs(args, valueFlags);
  const proof = createUserfaceProof({
    status: 'passed',
    repo: createRepoProofSnapshot(cwd, targetPaths),
    target: {
      kind: 'trust',
      paths: targetPaths,
    },
    validation: {
      status: 'not_run',
      reason: 'Trust doctor records the local data boundary. It does not validate UI composition.',
      violations: [],
    },
    composition: {
      status: 'not_run',
      reason: 'Run userface guard for composition proof.',
      violations: [],
    },
    preview: {
      status: 'not_run',
      reason: 'Trust doctor does not render preview artifacts.',
      artifacts: [],
    },
    egress: {
      mode: 'offline',
      modelCalls: 0,
      filesConsidered: targetPaths.length,
      filesSent: 0,
      bytesSent: 0,
      absolutePathsSent: false,
      remoteTelemetry: false,
      network: false,
    },
    summaries: [
      'Trust doctor ran locally/offline and performed no model or network work.',
      'Desktop AI runs attach provider/model/request-boundary egress summaries to chat evidence.',
    ],
  });
  const markdown = renderUserfaceProofMarkdown(proof);

  if (outputPath) writeOutputFile(outputPath, JSON.stringify(proof, null, 2) + '\n');
  if (summaryPath) writeOutputFile(summaryPath, markdown);

  if (format === 'summary' || format === 'markdown') {
    process.stdout.write(markdown);
  } else {
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  }
}

async function cmdPull(args: string[], config: any = {}) {
  assertLibraryCliEnabled('pull');
  const { getToken } = await import('./auth/tokenStorage');
  const { downloadAndExtractLibrary, saveManifest } = await import('./auth/downloader');
  
  process.stderr.write('Initializing uf pull...\n');
  
  const token = await getToken();
  if (!token) {
    process.stderr.write('Error: Not logged in. Run `userface login` first.\n');
    process.exit(1);
  }

  const libraries = config.libraries || {};
  const libraryKeys = Object.keys(libraries);

  if (libraryKeys.length === 0) {
    process.stderr.write('No libraries found in userface.config.json to pull.\n');
    return;
  }

  process.stderr.write(`Found ${libraryKeys.length} libraries in config.\n`);

  for (const key of libraryKeys) {
    const libInfo = libraries[key];
    if (!libInfo.id || !libInfo.version || !libInfo.targetDir) {
      process.stderr.write(`Skipping ${key}: missing id, version, or targetDir.\n`);
      continue;
    }

    try {
      // API endpoint convention from plan: GET /api/profile/libraries/:id/versions/:v/snapshot
      // For MVP we'll construct a theoretical endpoint URL. When the backend is ready, this will work.
      const API_BASE = process.env.USERFACE_API_URL || 'http://localhost:3000/api';
      const url = `${API_BASE}/profile/libraries/${libInfo.id}/versions/${libInfo.version}/tarball`;
      
      const targetPath = resolve(process.cwd(), libInfo.targetDir);
      await downloadAndExtractLibrary(url, targetPath, token);
      saveManifest(targetPath, libInfo.id, libInfo.version);
      
      process.stderr.write(`✅ Successfully pulled library ${key} into ${libInfo.targetDir}\n`);
    } catch (e: any) {
      process.stderr.write(`❌ Failed to pull library ${key}: ${e.message}\n`);
    }
  }
}

async function cmdUpdate(args: string[], config: any = {}) {
  assertLibraryCliEnabled('update');
  const { getToken } = await import('./auth/tokenStorage');
  
  process.stderr.write('Initializing uf update...\n');
  
  const token = await getToken();
  if (!token) {
    process.stderr.write('Error: Not logged in. Run `userface login` first.\n');
    process.exit(1);
  }

  const libraries = config.libraries || {};
  const libraryKeys = Object.keys(libraries);

  if (libraryKeys.length === 0) {
    process.stderr.write('No libraries found in userface.config.json to update.\n');
    return;
  }

  process.stderr.write(`Checking updates for ${libraryKeys.length} libraries...\n`);
  // MVP: For now we'll pretend the backend returned "No updates available"
  // When the actual backend endpoints are ready, this will compare versions
  // and do engine-compat rule checks based on the `engineRange`.

  for (const key of libraryKeys) {
    process.stderr.write(`Library ${key} is up to date (version ${libraries[key].version}).\n`);
  }
}

async function cmdLogin(args: string[], config: any = {}) {
  assertLibraryCliEnabled('login');
  const { storeToken } = await import('./auth/tokenStorage');
  const token = String(process.env.USERFACE_TOKEN || '').trim();
  if (!token) {
    process.stderr.write('Error: USERFACE_TOKEN is required for the experimental library CLI.\n');
    process.exit(1);
  }
  await storeToken(token);
  process.stderr.write(`Token saved to keychain.\n`);
}

async function cmdLogout(args: string[], config: any = {}) {
  assertLibraryCliEnabled('logout');
  const { deleteToken } = await import('./auth/tokenStorage');
  const deleted = await deleteToken();
  if (deleted) {
    process.stderr.write(`Successfully logged out. Token removed from keychain.\n`);
  } else {
    process.stderr.write(`No active session found.\n`);
  }
}

async function cmdSync(args: string[], config: any = {}) {
  assertLibraryCliEnabled('sync');
  const { getToken } = await import('./auth/tokenStorage');
  const { readFileSync: rfs, readdirSync, statSync } = await import('node:fs');
  const { resolve: pathResolve, relative, extname } = await import('node:path');

  const token = await getToken();
  if (!token) {
    process.stderr.write('Error: Not logged in. Run `userface login` first.\n');
    process.exit(1);
  }

  const libraries = config.libraries || {};
  const libraryKeys = Object.keys(libraries);
  if (libraryKeys.length === 0) {
    process.stderr.write('No libraries found in userface.config.json to sync.\n');
    return;
  }

  const API_BASE = process.env.USERFACE_API_URL || 'http://localhost:3000/api';
  const ALLOWED_EXT = new Set(['.tsx', '.ts', '.jsx', '.js', '.css', '.json', '.md', '.mdx', '.svg']);
  const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.turbo', '.DS_Store']);

  function collectFiles(dir: string, base: string): Array<{ path: string; contentBase64: string; mime?: string }> {
    const entries: Array<{ path: string; contentBase64: string; mime?: string }> = [];
    for (const name of readdirSync(dir)) {
      if (IGNORED.has(name)) continue;
      const full = pathResolve(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        entries.push(...collectFiles(full, base));
      } else if (stat.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) continue;
        const rel = relative(base, full).replace(/\\/g, '/');
        const buf = rfs(full);
        entries.push({ path: rel, contentBase64: buf.toString('base64') });
      }
    }
    return entries;
  }

  for (const key of libraryKeys) {
    const libInfo = libraries[key];
    const targetDir = libInfo.targetDir;
    if (!targetDir) {
      process.stderr.write(`Skipping ${key}: missing targetDir.\n`);
      continue;
    }
    const absDir = pathResolve(process.cwd(), targetDir);
    const root = libInfo.root || key;

    process.stderr.write(`Syncing library "${key}" (root: ${root}) from ${targetDir}...\n`);
    try {
      const files = collectFiles(absDir, absDir);
      if (files.length === 0) {
        process.stderr.write(`  No files found in ${targetDir}. Skipping.\n`);
        continue;
      }
      process.stderr.write(`  Collected ${files.length} files.\n`);

      const resp = await fetch(`${API_BASE}/profile/files/library/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ root, files }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = await resp.json().catch(() => ({})) as Record<string, any>;
      process.stderr.write(`  Synced. Revision: ${data.revisionSha || 'n/a'}\n`);
    } catch (e: any) {
      process.stderr.write(`  Failed to sync ${key}: ${e.message}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage() {
  process.stderr.write(`Userface CLI

Binary aliases:
  userface             Primary public command
  userface-engine      Backward-compatible engine alias

Usage:
  userface connect [--root <dir>]           Generate face.json contracts
  userface analyze  <path>                  Analyze a component
  userface validate <path>                  Validate a component (quality gate)
  userface readiness [--root dir]           Analyze repo readiness for AI UI acceptance
  userface guard [path...] [--changed]      Validate face document changes and emit Userface Proof
  userface trust [path...] [--offline]      Emit local data-boundary Userface Proof
  userface proof-schema                     Print userface-proof@1 JSON Schema
  userface states   <path> [--face f.json]  Generate visual states
  userface materialize <path> [--output p] [--framework f] Materialize face document to React/Vue/HTML code
  userface composition-validate <path> [--registry-dir d] [--registry-manifest p] [--enforce-registry-boundary] [--patterns p] Validate face composition
  userface diff --base <old.json> --head <new.json>  Diff face.json contracts
  userface render   <path> --props '{...}'  Render with props (SSR)
  userface test     --dir <path>            Test all components
  userface registry scan <dir>              Scan for components
  userface doctor                           Check environment and configuration
  userface mcp-serve                        Start MCP server

Options:
  --mode <m>         Validation mode: fast, standard, deep (for validate)
  --budget <b>       Output budget: llm, compact, verbose (for validate)
  --props <json>     Props as JSON string (for render)
  --dir <path>       Directory of components (for test/registry)
  --components-dir <path> Component registry root (for readiness)
  --ui-doc <path>    Representative face first-screen document (for readiness)
  --face <path>      Path to face.json with manual states (for states)
  --format <type>    Output format: json (default), markdown/summary, github-annotations where supported
  --proof <path>     Write Userface Proof JSON (for guard)
  --summary <path>   Write Userface Proof Markdown summary (for guard/trust)
  --preview-artifact <path[,path]> Attach hashed preview evidence artifact(s) to guard proof
  --output <path>    Write JSON report/proof (for readiness/trust)
  --write, --save    Persist readiness artifacts under .userface/readiness
                     or guard artifacts under .userface/proofs
  --no-write         Disable automatic readiness artifact persistence in TTY mode
  --fail-on <level>  Fail on severity: error, warning, info (for validate/guard/composition-validate)
  --offline          Record zero model/network egress proof (for guard/trust)
  --help             Show this help
  --version          Show version
`);
}

// ---------------------------------------------------------------------------
// Configuration Loading
// ---------------------------------------------------------------------------

async function loadConfig() {
  const cwd = process.cwd();
  const configNames = ['userface.config.ts', 'userface.config.js', 'userface.config.json'];
  
  for (const name of configNames) {
    const configPath = resolve(cwd, name);
    if (existsSync(configPath)) {
      if (name.endsWith('.json')) {
        try {
          return JSON.parse(readFileSync(configPath, 'utf-8'));
        } catch { return {}; }
      } else {
        try {
          // Simplistic dynamic import (works if ESM or transpiled by tsx)
          const mod = await import(configPath);
          return mod.default || mod;
        } catch (e: any) {
          process.stderr.write(`Warning: Failed to load ${name}: ${e.message}\n`);
          return {};
        }
      }
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const [,, command, ...args] = process.argv;

if (command === '--version' || command === '-v') {
  let ver = '0.1.0';
  try {
    // Try to resolve version from the engine package.json in node_modules
    const pkgJson = _require.resolve('@userface/engine/package.json');
    ver = JSON.parse(readFileSync(pkgJson, 'utf-8')).version || ver;
  } catch {
    // Try relative path (works in development when running from repo)
    try {
      const devPkgPath = resolve(process.cwd(), 'engine', 'package.json');
      ver = JSON.parse(readFileSync(devPkgPath, 'utf-8')).version || ver;
    } catch { /* use hardcoded fallback */ }
  }
  process.stdout.write(ver + '\n');
  process.exit(0);
}

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(command ? 0 : 1);
}

if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
  printUsage();
  process.exit(0);
}

const positional = args.filter(a => !a.startsWith('--'));
const targetPath = positional[0];

(async () => {
  try {
    const config = await loadConfig();

    switch (command) {
      case 'connect':
        await cmdConnect(args, config);
        break;
      case 'materialize':
        if (!targetPath) { process.stderr.write('Error: path required for materialize\n'); process.exit(1); }
        await cmdMaterialize(targetPath, args, config);
        break;
      case 'analyze':
        if (!targetPath) { process.stderr.write('Error: path required for analyze\n'); process.exit(1); }
        await cmdAnalyze(targetPath, config);
        break;
      case 'validate':
        if (!targetPath) { process.stderr.write('Error: path required for validate\n'); process.exit(1); }
        await cmdValidate(targetPath, args, config);
        break;
      case 'readiness':
        await cmdReadiness(args, config);
        break;
      case 'guard':
        await cmdGuard(args, config);
        break;
      case 'trust':
        await cmdTrust(args, config);
        break;
      case 'proof-schema':
        process.stdout.write(`${JSON.stringify(USERFACE_PROOF_JSON_SCHEMA, null, 2)}\n`);
        break;
      case 'composition-validate':
        if (!targetPath) { process.stderr.write('Error: path required for composition-validate\n'); process.exit(1); }
        await cmdCompositionValidate(targetPath, args, config);
        break;
      case 'diff':
        await cmdDiff(args, config);
        break;
      case 'states':
        if (!targetPath) { process.stderr.write('Error: path required for states\n'); process.exit(1); }
        await cmdStates(targetPath, args, config);
        break;
      case 'render':
        if (!targetPath) { process.stderr.write('Error: path required for render\n'); process.exit(1); }
        await cmdRender(targetPath, args, config);
        break;
      case 'test':
        await cmdTest(args, config);
        break;
      case 'doctor':
        await cmdDoctor(args, config);
        break;
      case 'login':
        await cmdLogin(args, config);
        break;
      case 'logout':
        await cmdLogout(args, config);
        break;
      case 'pull':
        await cmdPull(args, config);
        break;
      case 'update':
        await cmdUpdate(args, config);
        break;
      case 'sync':
        await cmdSync(args, config);
        break;
      case 'registry': {
        const subCmd = args[0];
        if (subCmd !== 'scan') {
          process.stderr.write(`Unknown registry subcommand: ${subCmd}\nUsage: registry scan <dir>\n`);
          process.exit(1);
        }
        await cmdRegistryScan(args.slice(1), config);
        break;
      }
      case 'mcp-serve': {
        const { startServer } = await import('./mcp-server');
        startServer(config);
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${command}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (e: any) {
    process.stderr.write(`Error: ${e?.message || e}\n`);
    process.exit(1);
  }
})();
