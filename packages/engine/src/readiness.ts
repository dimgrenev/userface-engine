import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { scanRegistry, type RegistryEntry } from './registry';
import { createUserfaceProof, type UserfaceProof } from './proof';
import { validateComposition } from './face-ui/compositionValidator';
import { isFaceUiDoc } from './face-ui/schema';
import type { Violation } from './rules/types';

export const USERFACE_READINESS_SCHEMA = 'userface-readiness@1' as const;

export type UserfaceReadinessStatus = 'ready' | 'partial' | 'blocked';
export type UserfaceReadinessCheckStatus = 'passed' | 'warning' | 'failed' | 'not_run';

export interface UserfaceReadinessCheck {
  id: string;
  label: string;
  status: UserfaceReadinessCheckStatus;
  score: number;
  summary: string;
  action?: string;
}

export interface UserfaceReadinessReport {
  schemaVersion: typeof USERFACE_READINESS_SCHEMA;
  status: UserfaceReadinessStatus;
  score: number;
  createdAt: string;
  repo: {
    root: string;
    framework: 'react' | 'vue' | 'svelte' | 'angular' | 'unknown';
    frameworkMeta?: string;
    typescript: boolean;
    packageManager?: 'pnpm' | 'yarn' | 'npm' | 'unknown';
  };
  components: {
    root?: string;
    discovered: number;
    contracted: number;
    contractCoverage: number;
    pilotTarget: {
      used: number;
      contracted: number;
      contractCoverage: number;
      names: string[];
      missingContracts: string[];
      unresolved: string[];
    };
    react: number;
    nonReact: number;
    props: number;
    states: number;
    diagnostics: number;
    sample: Array<{
      name: string;
      path: string;
      framework: RegistryEntry['framework'];
      hasFaceJson: boolean;
      props: number;
      states: number;
    }>;
    safe: Array<{
      name: string;
      path: string;
      reason: string;
    }>;
    unsafe: Array<{
      name: string;
      path: string;
      reason: string;
      diagnostics: string[];
    }>;
  };
  uiDocuments: {
    discovered: number;
    sample: string[];
  };
  firstScreen: {
    status: UserfaceReadinessCheckStatus;
    candidate?: string;
    summary: string;
  };
  pilot: {
    verdict: 'ready' | 'limited' | 'blocked';
    canRunFirstScreenPilot: boolean;
    summary: string;
    blockers: string[];
    requiredFixes: string[];
  };
  composition: {
    checked: number;
    violations: number;
    status: UserfaceReadinessCheckStatus;
    summary: string;
  };
  tokenStyleRisks: {
    status: UserfaceReadinessCheckStatus;
    risks: Array<{
      id: string;
      label: string;
      severity: 'info' | 'warning' | 'error';
      summary: string;
      action?: string;
    }>;
  };
  renderPreviewReadiness: {
    status: UserfaceReadinessCheckStatus;
    summary: string;
    requiredEvidence: string[];
  };
  guard: {
    offlineCore: boolean;
    canRun: boolean;
    reason: string;
  };
  proof: UserfaceProof;
  checks: UserfaceReadinessCheck[];
  recommendation: {
    summary: string;
    nextSteps: string[];
  };
}

export interface CreateReadinessReportOptions {
  root?: string;
  componentsDir?: string | null;
  uiDocumentPaths?: string[];
  recursive?: boolean;
  maxDepth?: number;
  maxUiDocuments?: number;
}

function readPackageJson(root: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function dependenciesFromPackageJson(pkg: Record<string, unknown> | null): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const block = pkg?.[key];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, version] of Object.entries(block)) {
      result[name] = String(version);
    }
  }
  return result;
}

function findNearestPackageRoot(root: string, start: string | undefined): string | null {
  const boundary = resolve(root);
  let current = resolve(start || root);
  while (current === boundary || current.startsWith(`${boundary}/`) || current.startsWith(`${boundary}\\`)) {
    if (existsSync(join(current, 'package.json'))) return current;
    if (current === boundary) break;
    current = dirname(current);
  }
  return existsSync(join(boundary, 'package.json')) ? boundary : null;
}

function detectFramework(
  root: string,
  componentRoot: string | undefined,
  components: RegistryEntry[],
): UserfaceReadinessReport['repo'] {
  const packageRoot = findNearestPackageRoot(root, componentRoot) || root;
  const pkg = readPackageJson(packageRoot);
  const deps = dependenciesFromPackageJson(pkg);
  const typescript = existsSync(join(root, 'tsconfig.json'))
    || existsSync(join(packageRoot, 'tsconfig.json'))
    || Object.keys(deps).some((name) => name === 'typescript')
    || components.some((component) => component.entry.endsWith('.tsx'));
  const packageScope = packageRoot === root ? '' : ` in ${relative(root, packageRoot)}`;
  const packageManager = detectPackageManager(root) === 'unknown'
    ? detectPackageManager(packageRoot)
    : detectPackageManager(root);
  if (deps.next) {
    return { root, framework: 'react', frameworkMeta: `next@${deps.next}${packageScope}`, typescript, packageManager };
  }
  if (deps.react) {
    return { root, framework: 'react', frameworkMeta: `react@${deps.react}${packageScope}`, typescript, packageManager };
  }
  if (deps.vue) {
    return { root, framework: 'vue', frameworkMeta: `vue@${deps.vue}${packageScope}`, typescript, packageManager };
  }
  if (deps.svelte) {
    return { root, framework: 'svelte', frameworkMeta: `svelte@${deps.svelte}${packageScope}`, typescript, packageManager };
  }
  if (deps['@angular/core']) {
    return { root, framework: 'angular', frameworkMeta: `angular@${deps['@angular/core']}${packageScope}`, typescript, packageManager };
  }
  const knownComponents = components.filter((component) => component.framework !== 'unknown');
  const frameworkCounts = new Map<RegistryEntry['framework'], number>();
  for (const component of knownComponents) {
    frameworkCounts.set(component.framework, (frameworkCounts.get(component.framework) || 0) + 1);
  }
  const [dominantFramework, dominantCount] = [...frameworkCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0] || ['unknown', 0];
  if (
    dominantFramework !== 'unknown'
    && dominantCount > 0
    && dominantCount / Math.max(1, knownComponents.length) >= 0.8
  ) {
    return {
      root,
      framework: dominantFramework,
      frameworkMeta: `${dominantFramework} inferred from ${dominantCount}/${knownComponents.length} registry entries`,
      typescript,
      packageManager,
    };
  }
  return { root, framework: 'unknown', typescript, packageManager };
}

function detectPackageManager(root: string): NonNullable<UserfaceReadinessReport['repo']['packageManager']> {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  return 'unknown';
}

function gitValue(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 2500 });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

function createReadinessRepoProofSnapshot(root: string, paths: string[]) {
  const hash = createHash('sha256');
  hash.update('userface-readiness-source-v1\0');
  const sourcePaths = paths.length > 0
    ? paths
    : ['package.json', 'tsconfig.json', 'userface.config.json', 'component-registry.json'];
  for (const sourcePath of [...new Set(sourcePaths.map(String).filter(Boolean))].sort()) {
    hash.update(sourcePath);
    hash.update('\0');
    try {
      hash.update(readFileSync(resolve(root, sourcePath)));
    } catch {
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  const branch = gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = gitValue(root, ['rev-parse', 'HEAD']);
  return {
    rootHash: `sha256:${hash.digest('hex')}`,
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
  };
}

const COMPONENT_DIR_CANDIDATES = [
  'src/components',
  'components',
  'src/ui',
  'lib/components',
  'app/components',
  'src/lib/components',
  'packages/ui/src',
  'packages/components/src',
];

function tryScanComponents(root: string, candidate: string, recursive: boolean, maxDepth: number) {
  const abs = resolve(root, candidate);
  if (!existsSync(abs)) return null;
  try {
    return scanRegistry(abs, { recursive, maxDepth, cache: false });
  } catch {
    return null;
  }
}

function detectComponentsRoot(root: string, explicit: string | null | undefined, recursive: boolean, maxDepth: number) {
  if (explicit) {
    const index = tryScanComponents(root, explicit, recursive, maxDepth);
    return index ? { root: resolve(root, explicit), index } : null;
  }
  let best: ReturnType<typeof tryScanComponents> = null;
  let bestRoot = '';
  for (const candidate of COMPONENT_DIR_CANDIDATES) {
    const index = tryScanComponents(root, candidate, recursive, maxDepth);
    if (!index) continue;
    if (!best || index.components.length > best.components.length) {
      best = index;
      bestRoot = resolve(root, candidate);
    }
  }
  return best ? { root: bestRoot, index: best } : null;
}

function shouldSkipDir(name: string): boolean {
  return name === 'node_modules'
    || name === '.git'
    || name === '.next'
    || name === 'dist'
    || name === 'build'
    || name === 'coverage'
    || name === '.turbo'
    || name === '.userface';
}

function shouldSkipDefaultUiDocument(root: string, absPath: string): boolean {
  const rel = relative(root, absPath).split(/[\\/]+/);
  return rel.includes('node_modules')
    || rel.includes('test-fixtures')
    || rel.includes('fixtures')
    || rel.includes('examples')
    || rel.includes('packs')
    || rel.includes('__fixtures__')
    || rel.some((segment) => segment === '__tests__' || segment.endsWith('.test'));
}

function findUiDocuments(root: string, maxResults: number): string[] {
  const results: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (results.length >= maxResults || depth > 7) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const abs = join(dir, entry);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!shouldSkipDir(entry)) visit(abs, depth + 1);
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      if (shouldSkipDefaultUiDocument(root, abs)) continue;
      try {
        const parsed = JSON.parse(readFileSync(abs, 'utf-8'));
        if (isFaceUiDoc(parsed)) {
          results.push(relative(root, abs));
        }
      } catch {
        // Not a JSON face document.
      }
    }
  };
  visit(root, 0);
  return results;
}

function collectUiComponentTypes(node: unknown, output: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.type === 'string' && record.type.trim()) {
    output.add(record.type.trim());
  }
  if (!Array.isArray(record.children)) return;
  for (const child of record.children) collectUiComponentTypes(child, output);
}

function readUiDocumentComponentTypes(root: string, uiDocuments: string[]): string[] {
  const output = new Set<string>();
  for (const uiDocument of uiDocuments.slice(0, 10)) {
    try {
      const doc = JSON.parse(readFileSync(resolve(root, uiDocument), 'utf-8'));
      collectUiComponentTypes(doc?.root, output);
    } catch {
      // Composition readiness reports unreadable documents separately.
    }
  }
  return [...output].sort();
}

function findRegistryManifest(root: string, componentsRoot?: string): string | undefined {
  const candidates = [
    join(root, 'component-registry.json'),
    ...(componentsRoot ? [join(componentsRoot, 'component-registry.json')] : []),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function runCompositionReadiness(
  root: string,
  uiDocuments: string[],
  registry: RegistryEntry[],
  registryManifestPath?: string,
) {
  const reports: Array<ReturnType<typeof validateComposition>> = [];
  const summaries: string[] = [];

  for (const uiDocument of uiDocuments.slice(0, 10)) {
    const absPath = resolve(root, uiDocument);
    try {
      const doc = JSON.parse(readFileSync(absPath, 'utf-8'));
      const report = validateComposition(doc, {
        registry,
        registryManifestPath,
        enforceRegistryBoundary: Boolean(registryManifestPath),
        budget: 'compact',
      });
      reports.push(report);
      summaries.push(`${uiDocument}: ${report.summary}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summaries.push(`${uiDocument}: unreadable (${message})`);
      reports.push({
        component: uiDocument,
        mode: 'fast',
        durationMs: 0,
        scores: { overall: 0, structural: 0, contract: 0, accessibility: 0, complexity: 0 },
        violations: [{
          ruleId: 'readiness/composition-read-file',
          description: `Could not read ${uiDocument}: ${message}`,
          severity: 'error',
          confidence: 1,
          category: 'contract',
          location: { file: uiDocument },
          fixHint: 'Fix the face document so guard can validate it.',
        }],
        violationsTotal: 1,
        violationsShown: 1,
        summary: `Could not read ${uiDocument}`,
      });
    }
  }

  const violations = reports.flatMap(report => report.violations || []) as Violation[];
  const status: UserfaceReadinessCheckStatus = reports.length === 0
    ? 'not_run'
    : violations.some(violation => violation.severity === 'error')
      ? 'failed'
      : violations.length > 0
        ? 'warning'
        : 'passed';

  return {
    checked: reports.length,
    violations,
    status,
    summary: reports.length === 0
      ? 'No face documents were available for composition validation.'
      : violations.length > 0
        ? `${violations.length} composition violation(s) found across ${reports.length} face document(s).`
        : `${reports.length} face document(s) passed composition readiness.`,
    summaries,
  };
}

function check(id: string, label: string, status: UserfaceReadinessCheckStatus, score: number, summary: string, action?: string): UserfaceReadinessCheck {
  return {
    id,
    label,
    status,
    score: Math.max(0, Math.min(100, Math.round(score))),
    summary,
    ...(action ? { action } : {}),
  };
}

const READINESS_CHECK_WEIGHTS: Record<string, number> = {
  framework: 0.08,
  typescript: 0.04,
  components: 0.12,
  contracts: 0.18,
  library_contracts: 0.02,
  registry_diagnostics: 0.05,
  token_style: 0.09,
  ui_documents: 0.08,
  composition: 0.12,
  first_screen: 0.10,
  preview: 0.07,
  guard: 0.05,
};

function readinessScore(checks: UserfaceReadinessCheck[]): number {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const item of checks) {
    const weight = READINESS_CHECK_WEIGHTS[item.id] || 0;
    weightedScore += item.score * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;
}

function statusFromChecks(checks: UserfaceReadinessCheck[]): UserfaceReadinessStatus {
  const failedCritical = checks.some((item) => item.status === 'failed' && (
    item.id === 'framework'
    || item.id === 'components'
    || item.id === 'composition'
    || item.id === 'first_screen'
    || item.id === 'guard'
  ));
  if (failedCritical) return 'blocked';
  if (checks.some((item) => item.status === 'failed' || item.status === 'warning')) return 'partial';
  return 'ready';
}

function summarizeRecommendation(status: UserfaceReadinessStatus): string {
  if (status === 'ready') return 'Repo is ready for an AI UI acceptance pilot.';
  if (status === 'partial') return 'Repo can run a limited pilot after the listed gaps are fixed.';
  return 'Repo is blocked for the paid pilot until the critical setup gaps are fixed.';
}

function nextStepsFromChecks(checks: UserfaceReadinessCheck[]): string[] {
  const steps = checks
    .filter((item) => item.action)
    .map((item) => item.action as string);
  if (steps.length === 0) {
    steps.push('Run userface guard on a representative face document change and attach the generated proof to the PR.');
  }
  return Array.from(new Set(steps)).slice(0, 6);
}

function buildPilotVerdict(params: {
  repo: UserfaceReadinessReport['repo'];
  components: RegistryEntry[];
  contracted: number;
  contractCoverage: number;
  pilotTarget: UserfaceReadinessReport['components']['pilotTarget'];
  uiDocuments: string[];
  compositionReadiness: ReturnType<typeof runCompositionReadiness>;
  firstScreenStatus: UserfaceReadinessCheckStatus;
  checks: UserfaceReadinessCheck[];
}): UserfaceReadinessReport['pilot'] {
  const blockers: string[] = [];
  const requiredFixes = new Set<string>();
  const hasPropSignal = params.components.some((component) => component.props.length > 0);

  if (params.repo.framework !== 'react') {
    blockers.push(params.repo.framework === 'unknown'
      ? 'No supported React framework signal was detected.'
      : `Detected ${params.repo.framework}; paid v0 is scoped to React/TypeScript repos.`);
    requiredFixes.add('Run readiness from the React product frontend root or scope the pilot to a React package.');
  }
  if (!params.repo.typescript) {
    requiredFixes.add('Add TypeScript metadata or provide explicit component contracts before relying on AI UI acceptance.');
  }
  if (params.components.length === 0) {
    blockers.push('No component library was discovered.');
    requiredFixes.add('Pass --components-dir or add a conventional components directory before the pilot.');
  }
  if (params.uiDocuments.length === 0) {
    blockers.push('No representative face first-screen document was discovered.');
    requiredFixes.add('Create or materialize one representative face first-screen document.');
  }
  if (params.compositionReadiness.status === 'failed') {
    blockers.push('The representative face document fails composition validation.');
    requiredFixes.add('Fix composition violations before running the acceptance pilot.');
  }
  if (params.firstScreenStatus === 'failed') {
    blockers.push('The first-screen candidate is not safe to use as the pilot target.');
  }
  if (params.components.length > 0 && params.contracted === 0 && !hasPropSignal) {
    blockers.push('Components were found, but no face.json or TypeScript prop signal was available.');
    requiredFixes.add('Add face.json contracts or TypeScript props for the pilot components.');
  }
  if (params.pilotTarget.used > 0 && params.pilotTarget.contractCoverage < 1) {
    requiredFixes.add('Add face.json contracts for the components used by representative face documents.');
  }

  for (const check of params.checks) {
    if (check.action && (check.status === 'failed' || check.status === 'warning')) {
      requiredFixes.add(check.action);
    }
  }

  const canRunFirstScreenPilot = blockers.length === 0
    && params.firstScreenStatus === 'passed'
    && params.uiDocuments.length > 0
    && params.components.length > 0;
  const contractWarning = params.pilotTarget.used > 0
    ? params.pilotTarget.contractCoverage < 1
    : params.components.length > 0 && params.contractCoverage < 0.7;
  const verdict: UserfaceReadinessReport['pilot']['verdict'] = blockers.length > 0
    ? 'blocked'
    : contractWarning || params.checks.some((check) => check.status === 'warning' || check.status === 'failed')
      ? 'limited'
      : 'ready';
  const summary = verdict === 'ready'
    ? 'Ready for a first-screen AI UI acceptance pilot.'
    : verdict === 'limited'
      ? 'Can run a limited first-screen pilot, but the listed gaps reduce proof strength.'
      : 'Cannot run the first-screen pilot until the listed blockers are fixed.';

  return {
    verdict,
    canRunFirstScreenPilot,
    summary,
    blockers: blockers.slice(0, 8),
    requiredFixes: Array.from(requiredFixes).slice(0, 8),
  };
}

function componentSummaryPath(root: string, component: RegistryEntry): string {
  return relative(root, component.path) || basename(component.path);
}

function classifyComponentReadiness(root: string, components: RegistryEntry[]) {
  const safe: UserfaceReadinessReport['components']['safe'] = [];
  const unsafe: UserfaceReadinessReport['components']['unsafe'] = [];

  for (const component of components) {
    const path = componentSummaryPath(root, component);
    const blockers: string[] = [];
    if (component.framework !== 'react') blockers.push(`framework is ${component.framework}`);
    if (!component.hasFaceJson) blockers.push('missing face.json contract');
    if (component.diagnostics.length > 0) blockers.push(`${component.diagnostics.length} registry diagnostic(s)`);
    if (blockers.length === 0) {
      safe.push({
        name: component.name,
        path,
        reason: 'React component with face.json contract and no registry diagnostics.',
      });
      continue;
    }
    unsafe.push({
      name: component.name,
      path,
      reason: blockers.join('; '),
      diagnostics: component.diagnostics,
    });
  }

  return {
    safe: safe.slice(0, 20),
    unsafe: unsafe.slice(0, 20),
  };
}

function findPackageStyleSignals(root: string, maxResults = 12): string[] {
  const results: string[] = [];
  const ignored = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo',
    '__tests__', '__stories__', '__mocks__', 'test', 'tests', 'fixtures', 'examples',
  ]);
  const visit = (dir: string, depth: number) => {
    if (depth > 6 || results.length >= maxResults) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const abs = join(dir, entry);
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (!ignored.has(entry)) visit(abs, depth + 1);
        continue;
      }
      const rel = relative(root, abs).replace(/\\/g, '/');
      const isStyleFile = /\.(css|scss|sass)$/.test(entry);
      const isTokenOrThemeModule = /(?:^|[./_-])(tokens?|theme)(?:[./_-]|$)/i.test(rel)
        && /\.(ts|tsx|js|jsx|json|css|scss|sass)$/.test(entry)
        && !/\.(test|spec|story|stories)\./.test(entry);
      const isStyleEntrypoint = /(?:^|\/)styles?\/index\.(ts|tsx|js|jsx|css|scss|sass)$/.test(rel);
      if (isStyleFile || isTokenOrThemeModule || isStyleEntrypoint) results.push(rel);
    }
  };
  visit(root, 0);
  return results;
}

function detectTokenStyleRisks(root: string, componentRoot?: string): UserfaceReadinessReport['tokenStyleRisks'] {
  const packageRoot = findNearestPackageRoot(root, componentRoot) || root;
  const roots = [...new Set([root, packageRoot])];
  const pkg = readPackageJson(packageRoot);
  const deps = dependenciesFromPackageJson(pkg);
  const tokenCandidates = [
    'tokens.json',
    'design-tokens.json',
    'src/tokens.ts',
    'src/theme.ts',
    'src/styles/tokens.css',
    'src/styles/index.css',
    'src/app/globals.css',
    'app/globals.css',
    'styles/globals.css',
  ];
  const tokenFiles = roots.flatMap((candidateRoot) => tokenCandidates
    .filter((path) => existsSync(join(candidateRoot, path)))
    .map((path) => join(candidateRoot, path)));
  const packageStyleSignals = findPackageStyleSignals(packageRoot);
  const dependencyStyleSignals = Object.keys(deps).filter((name) => (
    /(?:tokens?|theme|styles?|styled-system|tailwind)/i.test(name)
  ));
  const hasTailwind = [
    'tailwind.config.js',
    'tailwind.config.cjs',
    'tailwind.config.mjs',
    'tailwind.config.ts',
  ].some((path) => roots.some((candidateRoot) => existsSync(join(candidateRoot, path)))) || Boolean(deps.tailwindcss);
  const risks: UserfaceReadinessReport['tokenStyleRisks']['risks'] = [];

  if (
    tokenFiles.length === 0
    && packageStyleSignals.length === 0
    && dependencyStyleSignals.length === 0
    && !hasTailwind
  ) {
    risks.push({
      id: 'style/no-token-signal',
      label: 'Token/style signal',
      severity: 'warning',
      summary: 'No obvious token, theme, global style or Tailwind signal was found.',
      action: 'Point readiness at the design-system package or add token/style metadata before claiming visual acceptance.',
    });
  }
  const styleSignalCount = tokenFiles.length + packageStyleSignals.length + dependencyStyleSignals.length;
  if (styleSignalCount > 12) {
    risks.push({
      id: 'style/multiple-style-entrypoints',
      label: 'Style entrypoints',
      severity: 'info',
      summary: `${styleSignalCount} style/token signal(s) found; pilot should name the authoritative source.`,
      action: 'Choose the canonical token/style source for guard and preview validation.',
    });
  }

  return {
    status: risks.some((risk) => risk.severity === 'error')
      ? 'failed'
      : risks.some((risk) => risk.severity === 'warning')
        ? 'warning'
        : 'passed',
    risks,
  };
}

function renderPreviewReadiness(
  components: RegistryEntry[],
  uiDocuments: string[],
  compositionStatus: UserfaceReadinessCheckStatus,
): UserfaceReadinessReport['renderPreviewReadiness'] {
  const requiredEvidence = [
    'guard proof',
    'desktop render validation',
    'preview/screenshot artifact',
  ];
  if (components.length === 0 || uiDocuments.length === 0) {
    return {
      status: 'warning',
      summary: 'Preview evidence needs both a component registry and a representative face document.',
      requiredEvidence,
    };
  }
  if (compositionStatus === 'failed') {
    return {
      status: 'failed',
      summary: 'Preview should stay blocked until composition violations are fixed.',
      requiredEvidence,
    };
  }
  return {
    status: 'passed',
    summary: 'Preview evidence can be attached after guard passes and desktop/CI render validation runs.',
    requiredEvidence,
  };
}

export function createReadinessReport(options: CreateReadinessReportOptions = {}): UserfaceReadinessReport {
  const root = resolve(options.root || process.cwd());
  const createdAt = new Date().toISOString();
  const recursive = options.recursive !== false;
  const maxDepth = Math.max(1, options.maxDepth || 8);
  const componentScan = detectComponentsRoot(root, options.componentsDir, recursive, maxDepth);
  const components = componentScan?.index.components || [];
  const repo = detectFramework(root, componentScan?.root, components);
  const contracted = components.filter((component) => component.hasFaceJson).length;
  const contractCoverage = components.length > 0 ? contracted / components.length : 0;
  const reactComponents = components.filter((component) => component.framework === 'react').length;
  const nonReactComponents = components.filter((component) => component.framework !== 'react').length;
  const diagnostics = components.reduce((sum, component) => sum + component.diagnostics.length, 0);
  const uiDocuments = Array.isArray(options.uiDocumentPaths) && options.uiDocumentPaths.length > 0
    ? [...new Set(options.uiDocumentPaths.map(String).filter(Boolean))]
    : findUiDocuments(root, Math.max(1, options.maxUiDocuments || 20));
  const pilotComponentTypes = readUiDocumentComponentTypes(root, uiDocuments);
  const componentsByName = new Map(components.map((component) => [component.name, component]));
  const pilotComponents = pilotComponentTypes
    .map((name) => componentsByName.get(name))
    .filter((component): component is RegistryEntry => Boolean(component));
  const unresolvedPilotComponents = pilotComponentTypes.filter((name) => !componentsByName.has(name));
  const pilotTargetContracted = pilotComponents.filter((component) => component.hasFaceJson).length;
  const pilotTargetContractCoverage = pilotComponents.length > 0 ? pilotTargetContracted / pilotComponents.length : 0;
  const missingPilotTargetContracts = pilotComponents
    .filter((component) => !component.hasFaceJson)
    .map((component) => component.name)
    .sort();
  const pilotTarget = {
    used: pilotComponents.length,
    contracted: pilotTargetContracted,
    contractCoverage: pilotTargetContractCoverage,
    names: pilotComponents.map((component) => component.name).sort(),
    missingContracts: missingPilotTargetContracts,
    unresolved: unresolvedPilotComponents,
  };
  const registryManifestPath = findRegistryManifest(root, componentScan?.root);
  const compositionReadiness = runCompositionReadiness(root, uiDocuments, components, registryManifestPath);
  const componentReadiness = classifyComponentReadiness(root, components);
  const tokenStyleRisks = detectTokenStyleRisks(root, componentScan?.root);
  const previewReadiness = renderPreviewReadiness(components, uiDocuments, compositionReadiness.status);
  const firstScreenCandidate = uiDocuments[0];
  const firstScreenStatus: UserfaceReadinessCheckStatus = firstScreenCandidate
    ? compositionReadiness.status === 'failed' ? 'failed' : 'passed'
    : 'warning';
  const checks: UserfaceReadinessCheck[] = [
    repo.framework === 'react'
      ? check('framework', 'Framework', 'passed', 100, `${repo.frameworkMeta || 'React'} detected.`)
      : repo.framework === 'unknown'
        ? check('framework', 'Framework', 'failed', 0, 'No supported frontend framework was detected.', 'Run from the product frontend root or add React/Next dependencies before the pilot.')
        : check('framework', 'Framework', 'warning', 45, `${repo.framework} detected; paid v0 is optimized for React/TypeScript repos.`, 'Treat this as a custom pilot or start with a React package in the monorepo.'),
    repo.typescript
      ? check('typescript', 'TypeScript', 'passed', 100, 'TypeScript signal detected.')
      : check('typescript', 'TypeScript', 'warning', 45, 'TypeScript was not detected.', 'Add TypeScript config or provide explicit component prop contracts.'),
    components.length > 0
      ? check('components', 'Components', 'passed', components.length >= 5 ? 100 : 75, `${components.length} component(s) discovered${componentScan?.root ? ` in ${relative(root, componentScan.root) || basename(componentScan.root)}` : ''}.`)
      : check('components', 'Components', 'failed', 0, 'No component directory with supported component files was discovered.', 'Pass --components-dir or add a conventional components directory before running guard.'),
    components.length === 0
      ? check('contracts', 'Component contracts', 'not_run', 0, 'No components were available for contract coverage.')
      : pilotTarget.used > 0 && pilotTarget.unresolved.length > 0
        ? check('contracts', 'Pilot target contracts', 'failed', 25, `${pilotTarget.unresolved.length} component(s) used by face documents were not found in the registry.`, 'Fix face component names or registry discovery before treating AI UI as accepted.')
        : pilotTarget.used > 0 && pilotTarget.contractCoverage >= 1
          ? check('contracts', 'Pilot target contracts', 'passed', 100, `${pilotTarget.contracted}/${pilotTarget.used} pilot target component(s) have face.json contracts.`)
          : pilotTarget.used > 0
            ? check('contracts', 'Pilot target contracts', 'failed', 25, `${pilotTarget.contracted}/${pilotTarget.used} pilot target component(s) have face.json contracts.`, 'Add face.json contracts for the components used by representative face documents.')
            : contractCoverage >= 0.7
        ? check('contracts', 'Component contracts', 'passed', 100, `${contracted}/${components.length} components have face.json contracts.`)
        : contractCoverage >= 0.3
          ? check('contracts', 'Component contracts', 'warning', 60, `${contracted}/${components.length} components have face.json contracts.`, 'Generate or curate face.json contracts for the highest-traffic components first.')
          : check('contracts', 'Component contracts', 'failed', 25, `${contracted}/${components.length} components have face.json contracts.`, 'Generate or curate face.json contracts before treating AI UI as accepted.'),
    components.length > 0 && pilotTarget.used > 0 && pilotTarget.contractCoverage >= 1 && contractCoverage < 0.3
      ? check('library_contracts', 'Library contract expansion', 'passed', 85, `${contracted}/${components.length} total components have face.json contracts; pilot target is covered. Expand high-traffic contracts after the paid pilot.`)
      : components.length === 0
        ? check('library_contracts', 'Library contract expansion', 'not_run', 0, 'Library contract expansion did not run.')
        : contracted === 0
          ? check('library_contracts', 'Library contract expansion', 'not_run', 0, 'No contracted component baseline exists yet.')
          : contractCoverage >= 0.3
            ? check('library_contracts', 'Library contract expansion', 'passed', 90, 'Library contract coverage is acceptable for this readiness pass.')
            : check('library_contracts', 'Library contract expansion', 'warning', 45, `${contracted}/${components.length} total components have face.json contracts.`, 'Expand contracts to the highest-traffic components after the pilot target is covered.'),
    diagnostics === 0
      ? check('registry_diagnostics', 'Registry diagnostics', components.length > 0 ? 'passed' : 'not_run', components.length > 0 ? 100 : 0, components.length > 0 ? 'Component registry scan produced no diagnostics.' : 'Registry diagnostics did not run.')
      : check('registry_diagnostics', 'Registry diagnostics', 'warning', 65, `${diagnostics} registry diagnostic(s) found.`, 'Fix malformed face.json files or component entry detection warnings.'),
    tokenStyleRisks.status === 'passed'
      ? check('token_style', 'Token/style risks', 'passed', 90, 'Token/style signal is present or not blocking for this readiness pass.')
      : check('token_style', 'Token/style risks', tokenStyleRisks.status, tokenStyleRisks.status === 'failed' ? 30 : 60, tokenStyleRisks.risks[0]?.summary || 'Token/style readiness needs review.', tokenStyleRisks.risks[0]?.action),
    uiDocuments.length > 0
      ? check('ui_documents', 'Face documents', 'passed', 100, `${uiDocuments.length} face document(s) discovered.`)
      : check('ui_documents', 'Face documents', 'warning', 0, 'No face documents were discovered.', 'Use Userface to create or materialize at least one representative face document for the pilot.'),
    compositionReadiness.status === 'passed'
      ? check('composition', 'Composition gate', 'passed', 100, compositionReadiness.summary)
      : compositionReadiness.status === 'not_run'
        ? check('composition', 'Composition gate', 'warning', 0, compositionReadiness.summary, 'Create a representative face document and run userface guard --offline.')
        : check('composition', 'Composition gate', compositionReadiness.status, compositionReadiness.status === 'failed' ? 25 : 65, compositionReadiness.summary, 'Fix composition violations before selling this repo as pilot-ready.'),
    firstScreenStatus === 'passed'
      ? check('first_screen', 'First-screen feasibility', 'passed', 100, `First-screen candidate: ${firstScreenCandidate}.`)
      : firstScreenStatus === 'failed'
        ? check('first_screen', 'First-screen feasibility', 'failed', 25, `First-screen candidate ${firstScreenCandidate} fails composition readiness.`, 'Fix the first-screen face document before the pilot.')
        : check('first_screen', 'First-screen feasibility', 'warning', 0, 'No first-screen face candidate was discovered.', 'Create or materialize one face first-screen document for the pilot demo.'),
    check('preview', 'Preview readiness', previewReadiness.status, previewReadiness.status === 'passed' ? 90 : previewReadiness.status === 'failed' ? 25 : components.length > 0 && uiDocuments.length > 0 ? 55 : 0, previewReadiness.summary, previewReadiness.status === 'passed' ? undefined : 'Run the desktop validation path after components and face documents exist.'),
    components.length > 0 && repo.framework === 'react'
      ? check('guard', 'Offline guard', 'passed', 100, 'Offline guard can run locally with zero model/network egress.')
      : check('guard', 'Offline guard', 'failed', 0, 'Offline guard needs a compatible React component registry before it can prove AI UI changes.', 'Fix framework/component discovery first, then run userface guard --offline.'),
  ];
  const pilot = buildPilotVerdict({
    repo,
    components,
    contracted,
    contractCoverage,
    pilotTarget,
    uiDocuments,
    compositionReadiness,
    firstScreenStatus,
    checks,
  });
  const checkStatus = statusFromChecks(checks);
  const status: UserfaceReadinessStatus = pilot.verdict === 'blocked' ? 'blocked' : checkStatus;
  const score = readinessScore(checks);
  const recommendation = {
    summary: summarizeRecommendation(status),
    nextSteps: nextStepsFromChecks(checks),
  };
  const proof = createUserfaceProof({
    createdAt,
    status: status === 'ready' ? 'passed' : status === 'partial' ? 'warning' : 'blocked',
    repo: createReadinessRepoProofSnapshot(root, [
      ...components.map(component => relative(root, component.path)),
      ...uiDocuments,
    ]),
    target: {
      kind: 'readiness',
      paths: uiDocuments.slice(0, 10),
    },
    components: {
      total: components.length,
      contracted,
      used: components.map(component => component.name).sort(),
    },
    validation: {
      status: status === 'blocked' ? 'blocked' : 'passed',
      score,
      reason: recommendation.summary,
      violations: [],
    },
    composition: {
      status: compositionReadiness.status === 'passed'
        ? 'passed'
        : compositionReadiness.status === 'failed'
          ? 'failed'
          : compositionReadiness.status === 'warning'
            ? 'blocked'
            : 'not_run',
      reason: compositionReadiness.summary,
      violations: compositionReadiness.violations,
    },
    preview: {
      status: 'not_run',
      reason: 'Readiness does not render preview artifacts; guard/desktop validation attaches preview evidence.',
      artifacts: [],
    },
    egress: {
      mode: 'offline',
      modelCalls: 0,
      filesConsidered: components.length + uiDocuments.length,
      filesSent: 0,
      bytesSent: 0,
      absolutePathsSent: false,
      remoteTelemetry: false,
      network: false,
    },
    summaries: [
      recommendation.summary,
      `${components.length} component(s), ${contracted} contracted, ${uiDocuments.length} face document(s).`,
    ],
  });

  return {
    schemaVersion: USERFACE_READINESS_SCHEMA,
    status,
    score,
    createdAt,
    repo,
    components: {
      ...(componentScan?.root ? { root: componentScan.root } : {}),
      discovered: components.length,
      contracted,
      contractCoverage,
      pilotTarget,
      react: reactComponents,
      nonReact: nonReactComponents,
      props: components.reduce((sum, component) => sum + component.props.length, 0),
      states: components.reduce((sum, component) => sum + component.statesCount, 0),
      diagnostics,
      sample: components.slice(0, 10).map((component) => ({
        name: component.name,
        path: relative(root, component.path),
        framework: component.framework,
        hasFaceJson: component.hasFaceJson,
        props: component.props.length,
        states: component.statesCount,
      })),
      safe: componentReadiness.safe,
      unsafe: componentReadiness.unsafe,
    },
    uiDocuments: {
      discovered: uiDocuments.length,
      sample: uiDocuments.slice(0, 10),
    },
    firstScreen: {
      status: firstScreenStatus,
      ...(firstScreenCandidate ? { candidate: firstScreenCandidate } : {}),
      summary: firstScreenCandidate
        ? `Use ${firstScreenCandidate} as the first-screen readiness target.`
        : 'No first-screen face candidate was discovered.',
    },
    pilot,
    composition: {
      checked: compositionReadiness.checked,
      violations: compositionReadiness.violations.length,
      status: compositionReadiness.status,
      summary: compositionReadiness.summary,
    },
    tokenStyleRisks,
    renderPreviewReadiness: previewReadiness,
    guard: {
      offlineCore: true,
      canRun: components.length > 0 && repo.framework === 'react',
      reason: components.length > 0 && repo.framework === 'react'
        ? 'Local guard can validate face composition against the discovered registry without model/network egress.'
        : 'Guard needs a compatible React component registry before it can prove generated UI.',
    },
    proof,
    checks,
    recommendation,
  };
}

export function renderReadinessReportMarkdown(report: UserfaceReadinessReport): string {
  const safeComponents = report.components.safe.length > 0
    ? report.components.safe.map((component) => `- ${component.name} (${component.path}) - ${component.reason}`)
    : ['- none'];
  const unsafeComponents = report.components.unsafe.length > 0
    ? report.components.unsafe.map((component) => {
      const diagnostics = component.diagnostics.length > 0 ? ` Diagnostics: ${component.diagnostics.join('; ')}` : '';
      return `- ${component.name} (${component.path}) - ${component.reason}.${diagnostics}`;
    })
    : ['- none'];
  const tokenStyleRisks = report.tokenStyleRisks.risks.length > 0
    ? report.tokenStyleRisks.risks.map((risk) => `- ${risk.severity}: ${risk.label} - ${risk.summary}${risk.action ? ` Action: ${risk.action}` : ''}`)
    : ['- none'];
  const lines = [
    `# Userface Readiness (${report.schemaVersion})`,
    '',
    `Status: ${report.status}`,
    `Score: ${report.score}`,
    `Repo: ${report.repo.root}`,
    `Framework: ${report.repo.framework}${report.repo.frameworkMeta ? ` (${report.repo.frameworkMeta})` : ''}`,
    `TypeScript: ${report.repo.typescript ? 'yes' : 'no'}`,
    `Proof: ${report.proof.id} (${report.proof.status})`,
    '',
    '## Components',
    '',
    `Discovered: ${report.components.discovered}`,
    `Contracts: ${report.components.contracted}/${report.components.discovered}`,
    `Contract coverage: ${Math.round(report.components.contractCoverage * 100)}%`,
    `Pilot target contracts: ${report.components.pilotTarget.contracted}/${report.components.pilotTarget.used}`,
    `Pilot target components: ${report.components.pilotTarget.names.length > 0 ? report.components.pilotTarget.names.join(', ') : 'none'}`,
    `Props: ${report.components.props}`,
    `States: ${report.components.states}`,
    `First screen: ${report.firstScreen.candidate || 'none'} (${report.firstScreen.status})`,
    `Pilot verdict: ${report.pilot.verdict} (${report.pilot.canRunFirstScreenPilot ? 'can run first-screen pilot' : 'blocked for first-screen pilot'})`,
    `Composition: ${report.composition.checked} checked, ${report.composition.violations} violation(s)`,
    '',
    '## Pilot Feasibility',
    '',
    report.pilot.summary,
    '',
    'Blockers:',
    ...(report.pilot.blockers.length > 0 ? report.pilot.blockers.map((item) => `- ${item}`) : ['- none']),
    '',
    'Required fixes:',
    ...(report.pilot.requiredFixes.length > 0 ? report.pilot.requiredFixes.map((item) => `- ${item}`) : ['- none']),
    '',
    '## Safe Components',
    '',
    ...safeComponents,
    '',
    '## Unsafe Components',
    '',
    ...unsafeComponents,
    '',
    '## Token/Style Risks',
    '',
    `Status: ${report.tokenStyleRisks.status}`,
    ...tokenStyleRisks,
    '',
    '## Render/Preview Readiness',
    '',
    `Status: ${report.renderPreviewReadiness.status}`,
    report.renderPreviewReadiness.summary,
    '',
    'Required evidence:',
    ...report.renderPreviewReadiness.requiredEvidence.map((item) => `- ${item}`),
    '',
    '## Checks',
    '',
    ...report.checks.map((item) => `- ${item.status}: ${item.label} - ${item.summary}${item.action ? ` Action: ${item.action}` : ''}`),
    '',
    '## Recommendation',
    '',
    report.recommendation.summary,
    '',
    ...report.recommendation.nextSteps.map((step) => `- ${step}`),
    '',
  ];
  return lines.join('\n');
}
