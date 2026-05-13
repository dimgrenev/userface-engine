/**
 * Composition Validator for ui@1 documents.
 *
 * Validates the *structure* of a ui@1 tree against:
 * - Structural rules (nesting depth, interactive-in-interactive, list keys)
 * - Contract rules (type exists in registry, required props, enum values)
 * - $ref/$action resolution
 * - Named pattern compliance (Form, Dashboard, etc.)
 *
 * Output follows the unified Violation/ValidationReport format from rules/.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaceUiDoc, FaceUiNode, FaceUiValue, FaceUiChild } from './types';
import type { Violation, ValidationReport, ValidationScores, BudgetMode } from '../rules/types';
import type { RegistryEntry } from '../registry';
import { loadRegistryManifest } from '../registryManifest';

/**
 * Get the directory of this file, compatible with both CJS (__dirname) and ESM (import.meta.url).
 * Uses Function constructor to avoid TS compile error in CJS module mode.
 */
/**
 * Resolve the directory containing pattern JSON files.
 * Tries multiple strategies since this code runs in both CJS and ESM contexts.
 */
function resolvePatternsDir(): string | null {
  const candidates: string[] = [];

  // 1. CJS: __dirname/patterns
  if (typeof __dirname !== 'undefined') {
    candidates.push(resolve(__dirname, 'patterns'));
  }

  // 2. ESM: import.meta.url based
  try {
    const url = new Function('return import.meta.url')() as string;
    candidates.push(resolve(dirname(fileURLToPath(url)), 'patterns'));
  } catch {}

  // 3. Relative to cwd — monorepo src
  candidates.push(resolve(process.cwd(), 'packages/engine/src/face-ui/patterns'));
  // 4. Relative to cwd — npm package
  candidates.push(resolve(process.cwd(), 'node_modules/@userface/engine/src/face-ui/patterns'));

  for (const dir of candidates) {
    try {
      const files = readdirSync(dir);
      if (files.some(f => f.endsWith('.pattern.json'))) return dir;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompositionValidateOptions {
  registry?: RegistryEntry[];
  registryManifestPath?: string;
  patterns?: string[];
  customPatternFiles?: string[];
  enforceComponentSelection?: boolean;
  enforceRegistryBoundary?: boolean;
  context?: Record<string, any>;
  actions?: string[];
  maxDepth?: number;
  budget?: BudgetMode;
}

interface PatternRule {
  id: string;
  name: string;
  requires?: { type: string; minCount?: number; props?: Record<string, any> }[];
  forbids?: { nested: string[] }[];
  componentSelection?: PatternFile['componentSelection'];
}

// ---------------------------------------------------------------------------
// Interactive elements (cannot nest inside each other for a11y)
// ---------------------------------------------------------------------------

const INTERACTIVE_TYPES = new Set([
  'button', 'a', 'input', 'select', 'textarea', 'link',
  'Button', 'Link', 'Input', 'Select', 'Checkbox', 'Radio', 'Switcher', 'Slider',
]);

// ---------------------------------------------------------------------------
// Built-in pattern rules — loaded from patterns/*.pattern.json
// ---------------------------------------------------------------------------

export interface PatternFile {
  $schema?: string;
  id: string;
  name: string;
  purpose: string;
  zones?: Record<string, { description: string; required?: boolean }>;
  layout?: Record<string, any>;
  requires?: { type: string; minCount?: number; props?: Record<string, any> }[];
  recommends?: any[];
  forbids?: { nested?: string[]; adjacent?: string[]; reason?: string }[];
  skeleton?: any;
  variants?: any[];
  examples?: any[];
  componentSelection?: {
    faceUiPrimitives?: string[];
    ufProductBlocks?: Array<{
      name: string;
      contract: string;
      context?: string;
      whenToUse?: string[];
      whenNotToUse?: string[];
    }>;
    chooseFaceUiWhen?: string[];
    chooseUfWhen?: string[];
  };
}

function loadBuiltinPatterns(): PatternRule[] {
  try {
    const patternsDir = resolvePatternsDir();
    if (!patternsDir) return [];
    const files = readdirSync(patternsDir).filter(f => f.endsWith('.pattern.json'));
    return files.map(f => {
      const raw: PatternFile = JSON.parse(readFileSync(resolve(patternsDir, f), 'utf-8'));
      return {
        id: `pattern/${raw.id}`,
        name: raw.name,
        requires: raw.requires,
        forbids: raw.forbids?.filter(f => f.nested).map(f => ({ nested: f.nested! })),
        componentSelection: raw.componentSelection,
      };
    });
  } catch {
    // Fallback: return empty array if patterns dir is not available
    return [];
  }
}

let _builtinPatterns: PatternRule[] | null = null;
let _faceUiComponentTypes: Set<string> | null = null;

const FALLBACK_FACE_UI_COMPONENT_TYPES = [
  'Accordion',
  'Avatar',
  'Badge',
  'Bar',
  'Breadcrumb',
  'Button',
  'Calendar',
  'Card',
  'Carousel',
  'Checkbox',
  'Code',
  'Command',
  'Date',
  'DatePicker',
  'Drawer',
  'Icon',
  'Input',
  'Markdown',
  'Media',
  'Menu',
  'Modal',
  'Navigation',
  'Overlay',
  'Pagination',
  'Panel',
  'Popover',
  'Progress',
  'Radio',
  'Rating',
  'Scroll',
  'SegmentedControl',
  'Select',
  'Separator',
  'Sheet',
  'Skeleton',
  'Slider',
  'Steps',
  'Switcher',
  'Table',
  'Tabs',
  'Text',
  'Tile',
  'Toast',
  'Toc',
  'Toggle',
  'Tooltip',
  'Tree',
  'Upload',
] as const;

function getBuiltinPatterns(): PatternRule[] {
  if (!_builtinPatterns) _builtinPatterns = loadBuiltinPatterns();
  return _builtinPatterns;
}

/** @deprecated Use getBuiltinPatterns() instead */
const BUILTIN_PATTERNS: PatternRule[] = [];

/**
 * Load custom pattern files from absolute paths.
 * Returns PatternRule[] compatible with builtin patterns.
 */
function loadCustomPatterns(filePaths: string[]): PatternRule[] {
  const rules: PatternRule[] = [];
  for (const fp of filePaths) {
    try {
      const raw: PatternFile = JSON.parse(readFileSync(fp, 'utf-8'));
      rules.push({
        id: `pattern/${raw.id}`,
        name: raw.name,
        requires: raw.requires,
        forbids: raw.forbids?.filter(f => f.nested).map(f => ({ nested: f.nested! })),
        componentSelection: raw.componentSelection,
      });
    } catch {
      // Skip unreadable custom pattern files
    }
  }
  return rules;
}

/**
 * Load a full pattern file by ID. Returns the complete pattern definition.
 */
export function loadPatternById(patternId: string): PatternFile | null {
  try {
    const patternsDir = resolvePatternsDir();
    if (!patternsDir) return null;
    const cleanId = patternId.replace(/^pattern\//, '');
    const filePath = resolve(patternsDir, `${cleanId}.pattern.json`);
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * List all available patterns with summary info.
 */
export function listPatterns(): {
  id: string;
  name: string;
  purpose: string;
  componentSelection?: {
    faceUiPrimitives: number;
    ufProductBlocks: number;
    chooseFaceUiWhen?: string[];
    chooseUfWhen?: string[];
  };
}[] {
  try {
    const patternsDir = resolvePatternsDir();
    if (!patternsDir) return [];
    const files = readdirSync(patternsDir).filter(f => f.endsWith('.pattern.json'));
    return files.map(f => {
      const raw: PatternFile = JSON.parse(readFileSync(resolve(patternsDir, f), 'utf-8'));
      return {
        id: raw.id,
        name: raw.name,
        purpose: raw.purpose,
        ...(raw.componentSelection ? {
          componentSelection: {
            faceUiPrimitives: raw.componentSelection.faceUiPrimitives?.length || 0,
            ufProductBlocks: raw.componentSelection.ufProductBlocks?.length || 0,
            ...(raw.componentSelection.chooseFaceUiWhen?.length ? { chooseFaceUiWhen: raw.componentSelection.chooseFaceUiWhen } : {}),
            ...(raw.componentSelection.chooseUfWhen?.length ? { chooseUfWhen: raw.componentSelection.chooseUfWhen } : {}),
          },
        } : {}),
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRef(v: any): v is { $ref: string } {
  return !!v && typeof v === 'object' && typeof v.$ref === 'string';
}

function isAction(v: any): v is { $action: string } {
  return !!v && typeof v === 'object' && typeof v.$action === 'string';
}

function resolvePath(obj: any, path: string): { found: boolean; value?: any } {
  const segments = path.split('.');
  let current = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== 'object') return { found: false };
    if (!(seg in current)) return { found: false };
    current = current[seg];
  }
  return { found: true, value: current };
}

function collectAllNodes(root: FaceUiNode): { node: FaceUiNode; path: number[]; depth: number; parentTypes: string[] }[] {
  const result: { node: FaceUiNode; path: number[]; depth: number; parentTypes: string[] }[] = [];

  function walk(node: FaceUiNode, path: number[], depth: number, parentTypes: string[]) {
    result.push({ node, path, depth, parentTypes });
    if (!Array.isArray(node.children)) return;
    let childIdx = 0;
    for (const ch of node.children) {
      if (ch == null || typeof ch !== 'object' || !('type' in ch)) continue;
      walk(ch as FaceUiNode, [...path, childIdx], depth + 1, [...parentTypes, node.type]);
      childIdx++;
    }
  }

  walk(root, [0], 1, []);
  return result;
}

function countTypes(nodes: { node: FaceUiNode }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { node } of nodes) {
    counts.set(node.type, (counts.get(node.type) || 0) + 1);
  }
  return counts;
}

function isUppercaseComponentType(type: string): boolean {
  return /^[A-Z]/.test(type);
}

function resolveFaceUiRegistryPath(): string | null {
  const candidates = [
    resolve(process.cwd(), 'packages/face-ui-react/component-registry.json'),
    resolve(process.cwd(), '../face-ui-react/component-registry.json'),
    resolve(process.cwd(), '../../packages/face-ui-react/component-registry.json'),
    resolve(process.cwd(), 'node_modules/@userface/face-ui-react/component-registry.json'),
  ];

  for (const path of candidates) {
    try {
      JSON.parse(readFileSync(path, 'utf-8'));
      return path;
    } catch {}
  }

  return null;
}

function getFaceUiComponentTypes(): Set<string> {
  if (_faceUiComponentTypes) return _faceUiComponentTypes;

  const componentTypes = new Set<string>();
  const registryPath = resolveFaceUiRegistryPath();

  if (registryPath) {
    try {
      const raw = JSON.parse(readFileSync(registryPath, 'utf-8'));
      const components = raw?.components;
      if (components && typeof components === 'object' && !Array.isArray(components)) {
        for (const type of Object.keys(components)) componentTypes.add(type);
      }
    } catch {}
  }

  for (const type of FALLBACK_FACE_UI_COMPONENT_TYPES) componentTypes.add(type);

  for (const pattern of getBuiltinPatterns()) {
    for (const type of pattern.componentSelection?.faceUiPrimitives || []) {
      componentTypes.add(type);
    }
  }

  _faceUiComponentTypes = componentTypes;
  return componentTypes;
}

// ---------------------------------------------------------------------------
// Structural checks
// ---------------------------------------------------------------------------

function checkStructural(
  doc: FaceUiDoc,
  maxDepth: number,
): Violation[] {
  const violations: Violation[] = [];
  const nodes = collectAllNodes(doc.root);

  for (const { node, path, depth, parentTypes } of nodes) {
    if (depth > maxDepth) {
      violations.push({
        ruleId: 'composition/max-depth',
        description: `Node "${node.type}" at depth ${depth} exceeds max depth ${maxDepth}`,
        severity: 'warning',
        confidence: 1,
        category: 'structural',
        location: { component: node.type },
        fixHint: `Reduce nesting depth. Consider extracting subtree into a separate component.`,
      });
    }

    if (INTERACTIVE_TYPES.has(node.type)) {
      const interactiveParent = parentTypes.find(t => INTERACTIVE_TYPES.has(t));
      if (interactiveParent) {
        violations.push({
          ruleId: 'composition/interactive-nesting',
          description: `Interactive element "${node.type}" nested inside interactive "${interactiveParent}" — a11y violation`,
          severity: 'error',
          confidence: 0.9,
          category: 'a11y',
          location: { component: node.type },
          fixHint: `Move "${node.type}" outside of "${interactiveParent}". Nested interactive elements break screen reader navigation.`,
        });
      }
    }

    if (Array.isArray(node.children) && node.children.length > 1) {
      const nodeChildren = node.children.filter(
        (ch): ch is FaceUiNode => ch != null && typeof ch === 'object' && 'type' in ch,
      );
      if (nodeChildren.length > 3) {
        const missingKeys = nodeChildren.filter(ch => ch.key == null);
        if (missingKeys.length > 0) {
          violations.push({
            ruleId: 'composition/list-missing-keys',
            description: `${missingKeys.length} children of "${node.type}" lack "key" prop — may cause rendering issues`,
            severity: 'info',
            confidence: 0.7,
            category: 'structural',
            location: { component: node.type },
            fixHint: `Add unique "key" to each child in lists for stable identity.`,
          });
        }
      }
    }
  }

  // --- Anti-pattern checks ---

  // Multiple primary CTAs in same container
  for (const { node } of nodes) {
    if (!Array.isArray(node.children)) continue;
    const childNodes = node.children.filter(
      (ch): ch is FaceUiNode => ch != null && typeof ch === 'object' && 'type' in ch,
    );
    const accentButtons = childNodes.filter(
      ch => ch.type === 'Button' && ch.props?.variant === 'accent',
    );
    if (accentButtons.length > 1) {
      violations.push({
        ruleId: 'anti-pattern/multiple-primary-ctas',
        description: `${accentButtons.length} accent/primary Buttons in "${node.type}" — only one primary CTA per action group`,
        severity: 'warning',
        confidence: 0.7,
        category: 'pattern',
        location: { component: node.type },
        fixHint: 'Keep one accent Button as the primary action. Use default/ghost/outline variants for secondary actions.',
      });
    }
  }

  // Separator overuse (>3 in one container)
  for (const { node } of nodes) {
    if (!Array.isArray(node.children)) continue;
    const childNodes = node.children.filter(
      (ch): ch is FaceUiNode => ch != null && typeof ch === 'object' && 'type' in ch,
    );
    const separatorCount = childNodes.filter(ch => ch.type === 'Separator').length;
    if (separatorCount > 3) {
      violations.push({
        ruleId: 'anti-pattern/separator-overuse',
        description: `${separatorCount} Separators in "${node.type}" — use spacing instead of excessive dividers`,
        severity: 'info',
        confidence: 0.6,
        category: 'pattern',
        location: { component: node.type },
        fixHint: 'Replace excess Separators with container gap/spacing. Use Separator only between distinct logical sections.',
      });
    }
  }

  // Card inside Card (unclear hierarchy)
  for (const { node, parentTypes } of nodes) {
    if (node.type === 'Card' && parentTypes.includes('Card')) {
      violations.push({
        ruleId: 'anti-pattern/card-in-card',
        description: 'Card nested inside Card — unclear visual hierarchy',
        severity: 'info',
        confidence: 0.5,
        category: 'pattern',
        location: { component: 'Card' },
        fixHint: 'Flatten to a single Card or use sections/headings instead of nested Cards.',
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Contract checks against registry
// ---------------------------------------------------------------------------

function checkContracts(
  doc: FaceUiDoc,
  registry: RegistryEntry[],
): Violation[] {
  const violations: Violation[] = [];
  const nodes = collectAllNodes(doc.root);
  const registryMap = new Map(registry.map(r => [r.name, r]));

  for (const { node } of nodes) {
    const entry = registryMap.get(node.type);

    if (!entry) {
      violations.push({
        ruleId: 'composition/unknown-type',
        description: `Component type "${node.type}" not found in registry`,
        severity: 'error',
        confidence: 0.85,
        category: 'contract',
        location: { component: node.type },
        fixHint: `Use a component that exists in your project. Available: ${[...registryMap.keys()].slice(0, 10).join(', ')}`,
      });
      continue;
    }

    if (!entry.props.length) continue;

    const nodeProps = node.props || {};

    for (const propDef of entry.props) {
      if (propDef.required && !(propDef.name in nodeProps)) {
        violations.push({
          ruleId: 'composition/missing-required-prop',
          description: `Required prop "${propDef.name}" missing on "${node.type}"`,
          severity: 'error',
          confidence: 0.9,
          category: 'contract',
          location: { component: node.type, prop: propDef.name },
          fixHint: `Add prop "${propDef.name}" (type: ${propDef.type}) to "${node.type}"`,
        });
      }

      if (propDef.options?.length && propDef.name in nodeProps) {
        const val = nodeProps[propDef.name];
        if (typeof val === 'string' && !propDef.options.includes(val)) {
          violations.push({
            ruleId: 'composition/invalid-enum-value',
            description: `Prop "${propDef.name}" on "${node.type}" has value "${val}" which is not in allowed options: ${propDef.options.join(', ')}`,
            severity: 'error',
            confidence: 0.95,
            category: 'contract',
            location: { component: node.type, prop: propDef.name },
            fixHint: `Use one of: ${propDef.options.join(', ')}`,
          });
        }
      }
    }

    const knownPropNames = new Set(entry.props.map(p => p.name));
    for (const propName of Object.keys(nodeProps)) {
      if (propName === 'key' || propName === 'className' || propName === 'style' || propName === 'id') continue;
      if (!knownPropNames.has(propName)) {
        violations.push({
          ruleId: 'composition/unknown-prop',
          description: `Unknown prop "${propName}" on "${node.type}"`,
          severity: 'info',
          confidence: 0.6,
          category: 'contract',
          location: { component: node.type, prop: propName },
          fixHint: `Check if "${propName}" is a valid prop for "${node.type}". Known props: ${[...knownPropNames].join(', ')}`,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Registry boundary checks
// ---------------------------------------------------------------------------

function registryBoundaryConfigViolation(ruleId: string, description: string): Violation {
  return {
    ruleId,
    description,
    severity: 'error',
    confidence: 1,
    category: 'contract',
    location: {},
    fixHint: 'Pass a valid registryManifestPath when enforceRegistryBoundary is enabled.',
  };
}

function checkRegistryBoundary(
  doc: FaceUiDoc,
  registryManifestPath?: string,
): Violation[] {
  if (!registryManifestPath) {
    return [registryBoundaryConfigViolation(
      'composition/registry-boundary-missing-manifest',
      'Registry boundary enforcement requires registryManifestPath',
    )];
  }

  let manifest: ReturnType<typeof loadRegistryManifest>;
  try {
    manifest = loadRegistryManifest(registryManifestPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [registryBoundaryConfigViolation(
      'composition/registry-boundary-invalid-manifest',
      `Registry boundary manifest could not be loaded: ${detail}`,
    )];
  }

  const faceUiTypes = getFaceUiComponentTypes();
  const manifestComponents = new Map(manifest.components.map(component => [component.name, component]));
  const publicManifestTypes = new Set(
    manifest.components
      .filter(component => component.registryVisibility === 'public')
      .map(component => component.name),
  );
  const outsidePublicManifestTypes = new Set<string>();
  const rawInteractiveDomTypes = new Set<string>();

  for (const { node } of collectAllNodes(doc.root)) {
    if (!isUppercaseComponentType(node.type)) {
      if (INTERACTIVE_TYPES.has(node.type)) {
        rawInteractiveDomTypes.add(node.type);
      }
      continue;
    }
    if (faceUiTypes.has(node.type) || publicManifestTypes.has(node.type)) continue;
    outsidePublicManifestTypes.add(node.type);
  }

  const violations: Violation[] = [...rawInteractiveDomTypes].map(type => ({
    ruleId: 'composition/registry-boundary-raw-type',
    description: `Raw DOM type "${type}" bypasses the Face UI/UF registry boundary; interactive controls must be represented by Face UI primitives or public UF components`,
    severity: 'warning',
    confidence: 0.8,
    category: 'contract',
    location: { component: type },
    fixHint: `Replace "${type}" with the matching Face UI primitive or public UF component before enabling broad registry-boundary enforcement.`,
  }));

  const nonPublicComponentViolations: Violation[] = [...outsidePublicManifestTypes].map((type): Violation => {
    const manifestComponent = manifestComponents.get(type);
    const reason = manifestComponent
      ? `has "${manifestComponent.registryVisibility}" registry visibility`
      : 'is not listed in the registry manifest';

    return {
      ruleId: 'composition/registry-boundary-non-public-component',
      description: `Component type "${type}" ${reason}; only Face UI components and public UF registry components are allowed by the registry boundary`,
      severity: 'warning',
      confidence: 0.85,
      category: 'contract',
      location: { component: type },
      fixHint: `Use a Face UI primitive, use a public UF registry component, or mark "${type}" public in the UF registry manifest.`,
    };
  });
  violations.push(...nonPublicComponentViolations);

  return violations;
}

// ---------------------------------------------------------------------------
// $ref/$action resolution checks
// ---------------------------------------------------------------------------

function checkRefs(
  doc: FaceUiDoc,
  context?: Record<string, any>,
  actionNames?: string[],
): Violation[] {
  const violations: Violation[] = [];
  const nodes = collectAllNodes(doc.root);
  const actionSet = actionNames ? new Set(actionNames) : null;

  for (const { node } of nodes) {
    if (!node.props) continue;

    for (const [propName, val] of Object.entries(node.props)) {
      if (isRef(val)) {
        if (context) {
          const { found } = resolvePath(context, val.$ref);
          if (!found) {
            violations.push({
              ruleId: 'composition/unresolved-ref',
              description: `$ref "${val.$ref}" on "${node.type}.${propName}" cannot be resolved in provided context`,
              severity: 'warning',
              confidence: 0.8,
              category: 'contract',
              location: { component: node.type, prop: propName },
              fixHint: `Ensure context contains path "${val.$ref}" or update the $ref path`,
            });
          }
        } else {
          violations.push({
            ruleId: 'composition/unverified-ref',
            description: `$ref "${val.$ref}" on "${node.type}.${propName}" — no context provided to verify resolution`,
            severity: 'info',
            confidence: 0.5,
            category: 'contract',
            location: { component: node.type, prop: propName },
          });
        }
      }

      if (isAction(val)) {
        if (actionSet && !actionSet.has(val.$action)) {
          violations.push({
            ruleId: 'composition/unresolved-action',
            description: `$action "${val.$action}" on "${node.type}.${propName}" is not in the provided action handlers`,
            severity: 'warning',
            confidence: 0.8,
            category: 'contract',
            location: { component: node.type, prop: propName },
            fixHint: `Register handler for action "${val.$action}" or update the action name`,
          });
        } else if (!actionSet) {
          violations.push({
            ruleId: 'composition/unverified-action',
            description: `$action "${val.$action}" on "${node.type}.${propName}" — no action handlers provided to verify`,
            severity: 'info',
            confidence: 0.5,
            category: 'contract',
            location: { component: node.type, prop: propName },
          });
        }
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Pattern compliance
// ---------------------------------------------------------------------------

function checkPatterns(
  doc: FaceUiDoc,
  patternNames: string[],
  customPatternFiles?: string[],
  enforceComponentSelection = false,
): Violation[] {
  const violations: Violation[] = [];
  const nodes = collectAllNodes(doc.root);
  const typeCounts = countTypes(nodes);

  const allPatterns = [
    ...getBuiltinPatterns(),
    ...(customPatternFiles?.length ? loadCustomPatterns(customPatternFiles) : []),
  ];

  for (const patternName of patternNames) {
    const normalizedName = patternName.replace(/^pattern\//, '');
    const pattern = allPatterns.find(p => p.id === `pattern/${normalizedName}` || p.id === normalizedName);
    if (!pattern) {
      violations.push({
        ruleId: 'composition/unknown-pattern',
        description: `Unknown pattern "${patternName}". Available: ${allPatterns.map(p => p.id).join(', ')}`,
        severity: 'info',
        confidence: 1,
        category: 'pattern',
        location: {},
      });
      continue;
    }

    if (pattern.requires) {
      for (const req of pattern.requires) {
        const count = typeCounts.get(req.type) || 0;
        const minCount = req.minCount ?? 1;
        if (count < minCount) {
          violations.push({
            ruleId: `composition/${pattern.id}-missing`,
            description: `Pattern "${pattern.name}" requires at least ${minCount} "${req.type}" but found ${count}`,
            severity: 'warning',
            confidence: 0.8,
            category: 'pattern',
            location: {},
            fixHint: `Add ${minCount - count} more "${req.type}" component(s) to satisfy the ${pattern.name} pattern`,
          });
        }

        if (req.props && count > 0) {
          const matchingNodes = nodes.filter(n => n.node.type === req.type);
          const withRequiredProps = matchingNodes.filter(n => {
            const nodeProps = n.node.props || {};
            return Object.entries(req.props!).every(
              ([k, v]) => nodeProps[k] === v,
            );
          });
          if (withRequiredProps.length === 0) {
            violations.push({
              ruleId: `composition/${pattern.id}-prop-mismatch`,
              description: `Pattern "${pattern.name}" requires "${req.type}" with props ${JSON.stringify(req.props)} but none found`,
              severity: 'warning',
              confidence: 0.75,
              category: 'pattern',
              location: { component: req.type },
              fixHint: `Set ${JSON.stringify(req.props)} on one of the "${req.type}" components`,
            });
          }
        }
      }
    }

    if (pattern.forbids) {
      for (const forbid of pattern.forbids) {
        if (forbid.nested && forbid.nested.length === 2) {
          const [outer, inner] = forbid.nested;
          for (const { node, parentTypes } of nodes) {
            if (node.type === inner && parentTypes.includes(outer)) {
              violations.push({
                ruleId: `composition/${pattern.id}-forbidden-nesting`,
                description: `Pattern "${pattern.name}" forbids "${inner}" nested inside "${outer}"`,
                severity: 'error',
                confidence: 0.9,
                category: 'pattern',
                location: { component: inner },
                fixHint: `Move "${inner}" outside of "${outer}"`,
              });
            }
          }
        }
      }
    }

    if (enforceComponentSelection && pattern.componentSelection) {
      const allowedTypes = new Set([
        ...(pattern.componentSelection.faceUiPrimitives || []),
        ...(pattern.componentSelection.ufProductBlocks || []).map(block => block.name),
      ]);
      const unknownTypes = new Set<string>();

      for (const { node } of nodes) {
        if (!isUppercaseComponentType(node.type) || allowedTypes.has(node.type)) continue;
        unknownTypes.add(node.type);
      }

      for (const type of unknownTypes) {
        violations.push({
          ruleId: 'composition/component-selection-unknown',
          description: `Component type "${type}" is not listed in componentSelection for pattern "${pattern.name}"`,
          severity: 'warning',
          confidence: 0.75,
          category: 'pattern',
          location: { component: type },
          fixHint: `Use a Face UI primitive or UF product block listed for the ${pattern.name} pattern, or update the pattern metadata.`,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Score computation (mirrors ruleEngine)
// ---------------------------------------------------------------------------

function computeScores(violations: Violation[]): ValidationScores {
  const byCat = { structural: 0, contract: 0, a11y: 0, complexity: 0, pattern: 0 };
  const weights = { error: 10, warning: 3, info: 1 };

  for (const v of violations) {
    const cat = v.category as keyof typeof byCat;
    if (cat in byCat) byCat[cat] += weights[v.severity] * v.confidence;
  }

  const maxPenalty = 100;
  const score = (penalty: number) => Math.max(0, Math.round(maxPenalty - penalty));

  const structural = score(byCat.structural);
  const contract = score(byCat.contract);
  const accessibility = score(byCat.a11y);
  const complexity = score(byCat.complexity + byCat.pattern);

  return {
    overall: Math.round((structural + contract + accessibility + complexity) / 4),
    structural,
    contract,
    accessibility,
    complexity,
  };
}

function applyBudget(violations: Violation[], budget: BudgetMode): Violation[] {
  const sorted = [...violations].sort((a, b) => {
    const sevOrder = { error: 0, warning: 1, info: 2 };
    const sa = sevOrder[a.severity] ?? 2;
    const sb = sevOrder[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return b.confidence - a.confidence;
  });

  switch (budget) {
    case 'llm': {
      const errors = new Set(sorted.filter(v => v.severity === 'error').slice(0, 5));
      return sorted.filter(v => errors.has(v) || v.ruleId.startsWith('composition/registry-boundary-'));
    }
    case 'compact': return sorted.filter(v => v.severity !== 'info').slice(0, 10);
    case 'verbose':
    default: return sorted;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validateComposition(
  doc: FaceUiDoc,
  options: CompositionValidateOptions = {},
): ValidationReport {
  const start = performance.now();
  const maxDepth = options.maxDepth ?? 12;
  const budget: BudgetMode = options.budget || 'verbose';
  const allViolations: Violation[] = [];

  allViolations.push(...checkStructural(doc, maxDepth));

  if (options.registry?.length) {
    allViolations.push(...checkContracts(doc, options.registry));
  }

  allViolations.push(...checkRefs(doc, options.context, options.actions));

  if (options.enforceRegistryBoundary) {
    allViolations.push(...checkRegistryBoundary(doc, options.registryManifestPath));
  }

  if (options.patterns?.length) {
    allViolations.push(...checkPatterns(
      doc,
      options.patterns,
      options.customPatternFiles,
      options.enforceComponentSelection,
    ));
  }

  const scores = computeScores(allViolations);
  const budgeted = applyBudget(allViolations, budget);
  const docName = doc.meta?.name || 'composition';

  const report: ValidationReport = {
    component: docName,
    mode: 'fast',
    durationMs: Math.round(performance.now() - start),
    scores,
    violations: budgeted,
    violationsTotal: allViolations.length,
    violationsShown: budgeted.length,
    summary: allViolations.length === 0
      ? `${docName}: all composition checks passed (score: ${scores.overall}/100)`
      : `${docName}: ${allViolations.length} issue(s) found (score: ${scores.overall}/100)`,
  };

  return report;
}

export { BUILTIN_PATTERNS, getBuiltinPatterns };
