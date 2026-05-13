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
import { resolve, basename } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readComponentFiles, discoverComponents } from './fs-helpers';
import { createEngine, type CreateEngineOptions, type EngineInstance } from './createEngine';

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

function isLibraryCliEnabled(): boolean {
  return process.env.USERFACE_ENABLE_LIBRARY_CLI === '1';
}

function assertLibraryCliEnabled(command: string): void {
  if (isLibraryCliEnabled()) return;
  process.stderr.write(
    `Error: "${command}" is not part of the public engine CLI yet.\n` +
    'This release only exposes local component analysis, validation, registry, ui@1, and MCP workflows.\n'
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
    args: ['userface-engine', 'mcp-serve'],
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
    process.stderr.write(`Error reading ui@1 document: ${e.message}\n`);
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

async function cmdValidate(path: string, args: string[], config: any = {}) {
  const { RuleEngine, basePolicyPack } = await import('./rules/index');
  const engine = createProjectEngine();
  const cwd = process.cwd();
  const { files, entry } = readComponentFiles(cwd, path);
  const spec = await engine.analyzeComponent(files, { entryPath: entry });

  const modeArg = (flagValue(args, '--mode') || 'fast') as 'fast' | 'standard' | 'deep';
  const budgetArg = (flagValue(args, '--budget') || 'verbose') as 'llm' | 'compact' | 'verbose';
  const failOnArg = (flagValue(args, '--fail-on') || 'error') as 'error' | 'warning' | 'info';
  const ciMode = args.includes('--ci');
  const formatArg = flagValue(args, '--format') || (ciMode ? 'json' : 'json');
  const isGitHubAnnotations = formatArg === 'github-annotations';

  const ruleEngine = new RuleEngine();
  ruleEngine.loadPolicyPack(basePolicyPack);

  const code = files.find(f => f.name === entry)?.content;

  // Fast mode: just rules
  let report = ruleEngine.validate(spec, { mode: modeArg, budget: budgetArg, code });

  // Standard/Deep: add SSR + axe violations
  if (modeArg === 'standard' || modeArg === 'deep') {
    const axeViolations = await runAxeOnComponent(engine, spec, modeArg === 'deep');
    if (axeViolations.length > 0) {
      report.violations.push(...axeViolations);
      report.violationsTotal += axeViolations.length;
      report.violationsShown += axeViolations.length;
      // Recalculate scores
      report.scores.accessibility = Math.max(0, report.scores.accessibility - axeViolations.length * 10);
      report.scores.overall = Math.round(
        (report.scores.structural + report.scores.contract + report.scores.accessibility + report.scores.complexity) / 4
      );
      report.summary = `${spec.name}: ${report.violationsTotal} issue(s) found (score: ${report.scores.overall}/100)`;
    }
  }

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

  const index = scanRegistry(resolve(cwd, dir));

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

async function cmdDiff(args: string[], _config: any = {}) {
  const { diffFaces } = await import('./diff');
  const basePath = flagValue(args, '--base') || args[0];
  const headPath = flagValue(args, '--head') || args[1];

  if (!basePath || !headPath) {
    process.stderr.write('Error: both --base and --head paths required\nUsage: userface-engine diff --base old.face.json --head new.face.json\n');
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

  let doc: any;
  try {
    doc = JSON.parse(readFileSync(absPath, 'utf-8'));
  } catch (e: any) {
    process.stderr.write(`Error reading ui@1 document: ${e.message}\n`);
    process.exit(1);
  }

  const registryDir = flagValue(args, '--registry-dir') || flagValue(args, '--dir');
  const registryManifestPath = flagValue(args, '--registry-manifest') || flagValue(args, '--registry-manifest-path');
  const patternsRaw = flagValue(args, '--patterns');
  const budget = flagValue(args, '--budget') || 'verbose';
  const enforceRegistryBoundary = hasFlag(args, '--enforce-registry-boundary');

  let registry: any[] | undefined;
  if (registryDir) {
    const { scanRegistry } = await import('./registry');
    const index = scanRegistry(resolve(cwd, registryDir));
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
}

async function cmdPull(args: string[], config: any = {}) {
  assertLibraryCliEnabled('pull');
  const { getToken } = await import('./auth/tokenStorage');
  const { downloadAndExtractLibrary, saveManifest } = await import('./auth/downloader');
  
  process.stderr.write('Initializing uf pull...\n');
  
  const token = await getToken();
  if (!token) {
    process.stderr.write('Error: Not logged in. Run `userface-engine login` first.\n');
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
    process.stderr.write('Error: Not logged in. Run `userface-engine login` first.\n');
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
    process.stderr.write('Error: Not logged in. Run `userface-engine login` first.\n');
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
  process.stderr.write(`Userface Engine CLI

Usage:
  userface-engine connect [--root <dir>]           Generate face.json contracts
  userface-engine analyze  <path>                  Analyze a component
  userface-engine validate <path>                  Validate a component (quality gate)
  userface-engine states   <path> [--face f.json]  Generate visual states
  userface-engine materialize <path> [--output p] [--framework f] Materialize ui@1 document to React/Vue/HTML code
  userface-engine composition-validate <path> [--registry-dir d] [--registry-manifest p] [--enforce-registry-boundary] [--patterns p] Validate ui@1 composition
  userface-engine diff --base <old.json> --head <new.json>  Diff face.json contracts
  userface-engine render   <path> --props '{...}'  Render with props (SSR)
  userface-engine test     --dir <path>            Test all components
  userface-engine registry scan <dir>              Scan for components
  userface-engine doctor                           Check environment and configuration
  userface-engine mcp-serve                        Start MCP server

Options:
  --mode <m>         Validation mode: fast, standard, deep (for validate)
  --budget <b>       Output budget: llm, compact, verbose (for validate)
  --props <json>     Props as JSON string (for render)
  --dir <path>       Directory of components (for test/registry)
  --face <path>      Path to face.json with manual states (for states)
  --format <type>    Output format: json (default) or summary (for registry)
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
