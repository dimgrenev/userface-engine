import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type RegistryVisibility = 'public' | 'private';

export interface RegistryManifestComponent {
  registryVisibility: RegistryVisibility;
  entry: string;
  contract: string;
  [key: string]: unknown;
}

export interface RegistryManifest {
  version?: number;
  package: string;
  defaultRegistryVisibility: RegistryVisibility;
  components: Record<string, RegistryManifestComponent>;
  [key: string]: unknown;
}

export interface LoadedRegistryManifestComponent extends RegistryManifestComponent {
  name: string;
  entryPath: string;
  contractPath: string;
}

export interface LoadedRegistryManifest {
  manifest: RegistryManifest;
  manifestPath: string;
  packageRoot: string;
  repoRoot?: string;
  components: LoadedRegistryManifestComponent[];
}

export interface LoadRegistryManifestOptions {
  packageRoot?: string;
  repoRoot?: string;
}

export interface RegistryManifestIssue {
  path: string;
  message: string;
}

export class RegistryManifestError extends Error {
  issues: RegistryManifestIssue[];

  constructor(message: string, issues: RegistryManifestIssue[]) {
    super(`${message}: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
    this.name = 'RegistryManifestError';
    this.issues = issues;
  }
}

const VISIBILITY_VALUES = new Set<RegistryVisibility>(['public', 'private']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRegistryVisibility(value: unknown): value is RegistryVisibility {
  return typeof value === 'string' && VISIBILITY_VALUES.has(value as RegistryVisibility);
}

function isInsideOrEqual(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function findRepoRoot(start: string): string | undefined {
  let current = resolve(start);

  while (true) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function readJsonFile(path: string, issuePath: string): { value?: unknown; issue?: RegistryManifestIssue } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return {
      issue: {
        path: issuePath,
        message: `must be readable JSON (${error instanceof Error ? error.message : String(error)})`,
      },
    };
  }
}

function validatePackageName(
  manifestPackage: unknown,
  packageRoot: string,
  issues: RegistryManifestIssue[],
): manifestPackage is string {
  if (!isNonEmptyString(manifestPackage)) {
    issues.push({ path: 'package', message: 'must be a non-empty string' });
    return false;
  }

  const packageJsonPath = join(packageRoot, 'package.json');
  const packageJson = readJsonFile(packageJsonPath, 'package.json');
  if (packageJson.issue) {
    issues.push({ path: 'package', message: `must match a readable package.json in package root` });
    return true;
  }

  if (!isRecord(packageJson.value) || packageJson.value.name !== manifestPackage) {
    issues.push({ path: 'package', message: 'must match package.json name' });
  }

  return true;
}

function validateVisibility(value: unknown, issuePath: string, issues: RegistryManifestIssue[]): value is RegistryVisibility {
  if (!isRegistryVisibility(value)) {
    issues.push({ path: issuePath, message: 'must be "public" or "private"' });
    return false;
  }

  return true;
}

function resolveComponentPath(
  value: unknown,
  issuePath: string,
  packageRoot: string,
  repoRoot: string | undefined,
  issues: RegistryManifestIssue[],
): string | null {
  if (!isNonEmptyString(value)) {
    issues.push({ path: issuePath, message: 'must be a non-empty package-relative string' });
    return null;
  }

  if (!value.startsWith('./')) {
    issues.push({ path: issuePath, message: 'must start with "./"' });
  }

  const resolvedPath = resolve(packageRoot, value);
  const canonicalResolvedPath = fileExists(resolvedPath)
    ? canonicalPath(resolvedPath)
    : resolvedPath;

  if (!isInsideOrEqual(canonicalResolvedPath, packageRoot)) {
    issues.push({ path: issuePath, message: 'must stay within the package root' });
  }

  if (repoRoot && !isInsideOrEqual(canonicalResolvedPath, repoRoot)) {
    issues.push({ path: issuePath, message: 'must stay within the repo root' });
  }

  if (!fileExists(resolvedPath)) {
    issues.push({ path: issuePath, message: 'must point to an existing file' });
  }

  return resolvedPath;
}

export function loadRegistryManifest(
  manifestPath: string,
  options: LoadRegistryManifestOptions = {},
): LoadedRegistryManifest {
  const absoluteManifestPath = resolve(manifestPath);
  const packageRoot = canonicalPath(resolve(options.packageRoot ?? dirname(absoluteManifestPath)));
  const repoRoot = options.repoRoot ? canonicalPath(resolve(options.repoRoot)) : findRepoRoot(packageRoot);
  const manifestExists = fileExists(absoluteManifestPath);
  const canonicalManifestPath = manifestExists
    ? canonicalPath(absoluteManifestPath)
    : absoluteManifestPath;
  const issues: RegistryManifestIssue[] = [];

  if (!manifestExists) {
    issues.push({ path: 'manifestPath', message: 'must point to an existing file' });
  }

  if (manifestExists && !isInsideOrEqual(canonicalManifestPath, packageRoot)) {
    issues.push({ path: 'manifestPath', message: 'must stay within the package root' });
  }

  if (manifestExists && repoRoot && !isInsideOrEqual(canonicalManifestPath, repoRoot)) {
    issues.push({ path: 'manifestPath', message: 'must stay within the repo root' });
  }

  if (manifestExists && issues.some(issue => issue.path === 'manifestPath')) {
    throw new RegistryManifestError('Invalid registry manifest', issues);
  }

  const parsed = readJsonFile(absoluteManifestPath, 'manifestPath');
  if (parsed.issue) {
    throw new RegistryManifestError('Invalid registry manifest', [...issues, parsed.issue]);
  }

  if (!isRecord(parsed.value)) {
    issues.push({ path: 'manifest', message: 'must be a JSON object' });
    throw new RegistryManifestError('Invalid registry manifest', issues);
  }

  validatePackageName(parsed.value.package, packageRoot, issues);
  validateVisibility(parsed.value.defaultRegistryVisibility, 'defaultRegistryVisibility', issues);

  const componentsValue = parsed.value.components;
  if (!isRecord(componentsValue)) {
    issues.push({ path: 'components', message: 'must be an object keyed by component name' });
    throw new RegistryManifestError('Invalid registry manifest', issues);
  }

  const components: LoadedRegistryManifestComponent[] = [];

  for (const [name, component] of Object.entries(componentsValue).sort(([a], [b]) => a.localeCompare(b))) {
    const componentPath = `components.${name}`;

    if (!name.trim()) {
      issues.push({ path: componentPath, message: 'key must be a non-empty component name' });
    }

    if (!isRecord(component)) {
      issues.push({ path: componentPath, message: 'must be an object' });
      continue;
    }

    validateVisibility(component.registryVisibility, `${componentPath}.registryVisibility`, issues);
    const entryIssueCount = issues.length;
    const entryPath = resolveComponentPath(component.entry, `${componentPath}.entry`, packageRoot, repoRoot, issues);
    const entryPathValid = issues.length === entryIssueCount;
    const contractIssueCount = issues.length;
    const contractPath = resolveComponentPath(component.contract, `${componentPath}.contract`, packageRoot, repoRoot, issues);
    const contractPathValid = issues.length === contractIssueCount;

    if (contractPathValid && contractPath && fileExists(contractPath)) {
      const contract = readJsonFile(contractPath, `${componentPath}.contract`);
      if (contract.issue) {
        issues.push(contract.issue);
      } else if (!isRecord(contract.value) || contract.value.name !== name) {
        issues.push({
          path: `${componentPath}.contract.name`,
          message: 'must match the registry component name',
        });
      }
    }

    if (isRegistryVisibility(component.registryVisibility) && entryPathValid && contractPathValid && entryPath && contractPath) {
      components.push({
        ...component,
        name,
        registryVisibility: component.registryVisibility,
        entry: component.entry as string,
        contract: component.contract as string,
        entryPath,
        contractPath,
      });
    }
  }

  if (issues.length > 0) {
    throw new RegistryManifestError('Invalid registry manifest', issues);
  }

  return {
    manifest: parsed.value as unknown as RegistryManifest,
    manifestPath: absoluteManifestPath,
    packageRoot,
    ...(repoRoot ? { repoRoot } : {}),
    components,
  };
}
