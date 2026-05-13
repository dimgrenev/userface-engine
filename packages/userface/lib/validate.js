import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const FLAGS_WITH_VALUES = new Set([
  '--mode',
  '--budget',
  '--fail-on',
  '--format',
]);

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function collectPositionals(args) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (FLAGS_WITH_VALUES.has(token)) {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) out.push(token);
  }
  return out;
}

function stripValidateWrapperFlags(args, targetToken) {
  const out = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--annotations') continue;
    if (token === '--format') {
      index += 1;
      continue;
    }
    if (targetToken && token === targetToken) continue;
    out.push(token);
  }
  return out;
}

function detectConfiguredComponentsRoot(cwd) {
  const configPath = path.join(cwd, 'userface.config.json');
  if (!fs.existsSync(configPath)) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return String(parsed.componentsDir || parsed.root || '').trim();
  } catch {
    return '';
  }
}

function resolveValidateTarget(cwd, rawTarget) {
  const candidate = String(rawTarget || '').trim();
  if (candidate) {
    return path.resolve(cwd, candidate);
  }

  const configuredRoot = detectConfiguredComponentsRoot(cwd);
  if (configuredRoot) {
    const configuredPath = path.resolve(cwd, configuredRoot);
    if (fs.existsSync(configuredPath)) return configuredPath;
  }

  const defaults = [
    'src/components',
    'components',
    'packages/face-ui-react',
  ];

  for (const entry of defaults) {
    const nextPath = path.resolve(cwd, entry);
    if (fs.existsSync(nextPath)) return nextPath;
  }

  throw new Error('Could not infer a components path. Pass one explicitly: userface validate <path>');
}

function resolveLocalEnginePath(relativePath) {
  const localPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), relativePath);
  return fs.existsSync(localPath) ? localPath : '';
}

function resolveEngineCliEntry() {
  try {
    const packageJsonPath = require.resolve('@userface/engine/package.json');
    const cliPath = path.join(path.dirname(packageJsonPath), 'dist/esm/cli.js');
    if (fs.existsSync(cliPath)) return cliPath;
  } catch {}

  const localCliPath = resolveLocalEnginePath('../../engine/dist/esm/cli.js');
  if (localCliPath) return localCliPath;

  throw new Error('Could not resolve @userface/engine CLI. Install @userface/engine or run from the monorepo.');
}

async function loadEngineModule() {
  try {
    return require('@userface/engine');
  } catch {}

  const localIndexPath = resolveLocalEnginePath('../../engine/dist/cjs/index.js');
  if (!localIndexPath) {
    throw new Error('Could not resolve @userface/engine module. Install @userface/engine or run from the monorepo.');
  }

  return require(localIndexPath);
}

async function resolveComponentTargets(targetPath) {
  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    return [{
      absolutePath: targetPath,
      fallbackFile: targetPath,
    }];
  }

  const { scanRegistry } = await loadEngineModule();
  const index = scanRegistry(targetPath);
  if (Array.isArray(index.components) && index.components.length > 0) {
    return index.components.map((component) => ({
      absolutePath: component.path,
      fallbackFile: path.join(component.path, component.entry || ''),
    }));
  }

  return [{
    absolutePath: targetPath,
    fallbackFile: targetPath,
  }];
}

function normalizeRelativePath(cwd, absolutePath) {
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath && !relativePath.startsWith('..') ? relativePath.replace(/\\/g, '/') : absolutePath.replace(/\\/g, '/');
}

function runEngineValidate(engineCliPath, cwd, componentTarget, forwardedArgs) {
  const relativeTarget = normalizeRelativePath(cwd, componentTarget.absolutePath);
  const fallbackFile = normalizeRelativePath(cwd, componentTarget.fallbackFile || componentTarget.absolutePath);
  const result = spawnSync(
    process.execPath,
    [engineCliPath, 'validate', relativeTarget, '--format', 'json', ...forwardedArgs],
    {
      cwd,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );

  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.error) {
    return {
      ok: false,
      path: relativeTarget,
      fallbackFile,
      error: result.error.message,
      stderr,
      exitCode: result.status ?? 1,
    };
  }

  try {
    const report = stdout ? JSON.parse(stdout) : null;
    if (!report || typeof report !== 'object') {
      throw new Error('Validation output was empty');
    }
    return {
      ok: true,
      path: relativeTarget,
      fallbackFile,
      report,
      stderr,
      exitCode: result.status ?? 0,
    };
  } catch (error) {
    return {
      ok: false,
      path: relativeTarget,
      fallbackFile,
      error: error instanceof Error ? error.message : 'Could not parse engine validation output',
      stderr: stderr || stdout,
      exitCode: result.status ?? 1,
    };
  }
}

function shouldFailViolations(violations, failOn) {
  if (!Array.isArray(violations) || violations.length === 0) return false;
  if (failOn === 'info') return true;
  if (failOn === 'warning') {
    return violations.some((violation) => violation.severity === 'warning' || violation.severity === 'error');
  }
  return violations.some((violation) => violation.severity === 'error');
}

function collectAffectedFiles(resultPath, fallbackFile, violations) {
  const files = new Set();
  for (const violation of Array.isArray(violations) ? violations : []) {
    const candidate = String(violation?.location?.file || '').trim();
    files.add(candidate || fallbackFile || resultPath);
  }
  return [...files];
}

function escapeAnnotationValue(input) {
  return String(input || '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function buildAggregateReport(cwd, targetPath, componentResults, failOn) {
  const startedAt = new Date().toISOString();
  const affectedFiles = new Set();
  const results = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let violationsTotal = 0;
  let durationMs = 0;
  let mode = 'fast';

  for (const result of componentResults) {
    if (!result.ok) {
      errors += 1;
      failed += 1;
      results.push({
        component: path.basename(result.path, path.extname(result.path)),
        path: result.path,
        status: 'error',
        error: result.error,
        stderr: result.stderr || '',
      });
      affectedFiles.add(result.fallbackFile || result.path);
      continue;
    }

    const report = result.report;
    const currentViolations = Array.isArray(report.violations) ? report.violations : [];
    const currentShouldFail = shouldFailViolations(currentViolations, failOn);
    if (currentShouldFail) failed += 1;
    else passed += 1;

    durationMs += Number(report.durationMs || 0);
    mode = String(report.mode || mode);
    violationsTotal += Number(report.violationsTotal || currentViolations.length || 0);

    const componentAffectedFiles = collectAffectedFiles(result.path, result.fallbackFile, currentViolations);
    for (const file of componentAffectedFiles) affectedFiles.add(file);

    results.push({
      component: String(report.component || path.basename(result.path)),
      path: result.path,
      status: currentShouldFail ? 'fail' : 'pass',
      scores: report.scores || null,
      summary: String(report.summary || ''),
      violationsTotal: Number(report.violationsTotal || currentViolations.length || 0),
      violations: currentViolations,
      affectedFiles: componentAffectedFiles,
    });
  }

  return {
    root: normalizeRelativePath(cwd, targetPath),
    scannedAt: startedAt,
    durationMs,
    mode,
    failOn,
    totalComponents: results.length,
    passed,
    failed,
    errors,
    violationsTotal,
    affectedFiles: [...affectedFiles],
    results,
  };
}

function formatSummary(report) {
  const lines = [
    `Userface validation`,
    `Root: ${report.root}`,
    `Mode: ${report.mode}`,
    `Components: ${report.totalComponents}`,
    `Passed: ${report.passed}`,
    `Failed: ${report.failed}`,
    `Errors: ${report.errors}`,
    `Violations: ${report.violationsTotal}`,
    '',
  ];

  for (const result of report.results) {
    if (result.status === 'error') {
      lines.push(`✗ ${result.component} — ${result.error}`);
      continue;
    }
    const score = result.scores?.overall ?? 'n/a';
    const badge = result.status === 'pass' ? '✓' : '✗';
    lines.push(`${badge} ${result.component} — score ${score}/100, violations ${result.violationsTotal}`);
    if (result.summary) {
      lines.push(`  ${result.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function formatGitHubAnnotations(report) {
  const lines = [];
  for (const result of report.results) {
    if (result.status === 'error') {
      lines.push(
        `::error file=${escapeAnnotationValue(result.path)},line=1::${escapeAnnotationValue(`Validation failed for ${result.component}: ${result.error}`)}`,
      );
      continue;
    }

    for (const violation of result.violations || []) {
      const level = violation.severity === 'error'
        ? 'error'
        : violation.severity === 'warning'
          ? 'warning'
          : 'notice';
      const file = String(violation?.location?.file || result.path);
      const line = Number(violation?.location?.line || 1);
      const message = `[${result.component}] ${violation.ruleId}: ${violation.description}`;
      lines.push(
        `::${level} file=${escapeAnnotationValue(file)},line=${line}::${escapeAnnotationValue(message)}`,
      );
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export async function validateTarget(rawTarget, options = {}) {
  const cwd = options.cwd || process.cwd();
  const failOn = options.failOn || 'error';
  const forwardedArgs = Array.isArray(options.forwardedArgs) ? options.forwardedArgs : [];
  const targetPath = resolveValidateTarget(cwd, rawTarget || '');
  const componentTargets = await resolveComponentTargets(targetPath);
  const engineCliPath = options.engineCliPath || resolveEngineCliEntry();
  const componentResults = componentTargets.map((componentPath) => (
    runEngineValidate(engineCliPath, cwd, componentPath, forwardedArgs)
  ));
  return buildAggregateReport(cwd, targetPath, componentResults, failOn);
}

export function mergeValidationReports(reports, options = {}) {
  const filtered = Array.isArray(reports)
    ? reports.filter((report) => report && typeof report === 'object')
    : [];
  const affectedFiles = new Set();
  const results = [];
  let passed = 0;
  let failed = 0;
  let errors = 0;
  let violationsTotal = 0;
  let durationMs = 0;
  let mode = 'fast';

  for (const report of filtered) {
    durationMs += Number(report.durationMs || 0);
    passed += Number(report.passed || 0);
    failed += Number(report.failed || 0);
    errors += Number(report.errors || 0);
    violationsTotal += Number(report.violationsTotal || 0);
    if (report.mode) mode = String(report.mode);
    for (const file of Array.isArray(report.affectedFiles) ? report.affectedFiles : []) {
      affectedFiles.add(file);
    }
    for (const result of Array.isArray(report.results) ? report.results : []) {
      results.push(result);
    }
  }

  return {
    root: String(options.root || (filtered.length === 1 ? filtered[0].root : 'multiple')),
    scannedAt: new Date().toISOString(),
    durationMs,
    mode,
    failOn: String(options.failOn || filtered[0]?.failOn || 'error'),
    totalComponents: results.length,
    passed,
    failed,
    errors,
    violationsTotal,
    affectedFiles: [...affectedFiles],
    results,
  };
}

export function renderValidationOutput(report, options = {}) {
  const outputFormat = options.outputFormat || 'json';
  if (outputFormat === 'github-annotations') {
    return formatGitHubAnnotations(report);
  }
  if (outputFormat === 'summary') {
    return formatSummary(report);
  }
  const indent = options.ci ? 0 : 2;
  return JSON.stringify(report, null, indent) + '\n';
}

export async function executeValidation(rawArgs, options = {}) {
  const args = [...rawArgs];
  const cwd = options.cwd || process.cwd();
  const targetToken = collectPositionals(args)[0] || '';
  const outputFormat = hasFlag(args, '--annotations')
    ? 'github-annotations'
    : (flagValue(args, '--format') || (hasFlag(args, '--ci') ? 'json' : 'json'));
  const failOn = flagValue(args, '--fail-on') || 'error';
  const forwardedArgs = stripValidateWrapperFlags(args, targetToken);
  const report = await validateTarget(targetToken, {
    cwd,
    failOn,
    forwardedArgs,
  });
  const exitCode = report.failed > 0 || report.errors > 0 ? 1 : 0;
  const output = renderValidationOutput(report, {
    outputFormat,
    ci: hasFlag(args, '--ci'),
  });

  return {
    report,
    exitCode,
    output,
    outputFormat,
  };
}

export async function runValidateCommand(rawArgs) {
  const result = await executeValidation(rawArgs);
  const { output, exitCode } = result;
  process.stdout.write(output, () => {
    process.exit(exitCode);
  });
}
