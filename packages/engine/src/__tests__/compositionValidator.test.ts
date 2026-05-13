import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listPatterns, loadPatternById, validateComposition } from '../face-ui/compositionValidator.ts';
import type { FaceUiDoc } from '../face-ui/types.ts';

const BUILTIN_PATTERN_IDS = ['crud-table', 'dashboard', 'form', 'list-detail', 'pricing', 'settings'];
const COMPONENT_SELECTION_RULE_ID = 'composition/component-selection-unknown';
const REGISTRY_BOUNDARY_RULE_ID = 'composition/registry-boundary-non-public-component';
const REGISTRY_BOUNDARY_RAW_TYPE_RULE_ID = 'composition/registry-boundary-raw-type';
const REGISTRY_BOUNDARY_MISSING_MANIFEST_RULE_ID = 'composition/registry-boundary-missing-manifest';
const REGISTRY_BOUNDARY_INVALID_MANIFEST_RULE_ID = 'composition/registry-boundary-invalid-manifest';
const REGISTRY_BOUNDARY_RULE_PREFIX = 'composition/registry-boundary-';
const tempRoots: string[] = [];

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'packages/engine'))) return cwd;
  return resolve(cwd, '../..');
}

function readRepoFaceDoc(relativePath: string): FaceUiDoc {
  return JSON.parse(readFileSync(resolve(repoRoot(), relativePath), 'utf8')) as FaceUiDoc;
}

function actualUfRegistryManifestPath(): string {
  return resolve(repoRoot(), 'packages/uf/component-registry.json');
}

function registryBoundaryRuleIdsInSource(): string[] {
  const source = readFileSync(resolve(repoRoot(), 'packages/engine/src/face-ui/compositionValidator.ts'), 'utf8');
  const matches = source.matchAll(/['"`](composition\/registry-boundary-[^'"`]+)['"`]/g);
  return [...new Set([...matches].map(match => match[1]))].sort();
}

function writeFixtureComponent(packageRoot: string, name: string) {
  mkdirSync(join(packageRoot, name), { recursive: true });
  writeFileSync(join(packageRoot, name, `${name}.tsx`), `export function ${name}() { return null; }\n`);
  writeFileSync(join(packageRoot, name, `${name}.json`), JSON.stringify({ name }));
}

function makeRegistryBoundaryFixture() {
  const root = mkdtempSync(join(tmpdir(), 'userface-composition-registry-boundary-'));
  tempRoots.push(root);

  const packageRoot = join(root, 'packages', 'uf');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@demo/uf' }));
  writeFixtureComponent(packageRoot, 'PublicPanel');
  writeFixtureComponent(packageRoot, 'PrivatePanel');
  writeFileSync(join(packageRoot, 'component-registry.json'), JSON.stringify({
    version: 1,
    package: '@demo/uf',
    defaultRegistryVisibility: 'private',
    components: {
      PublicPanel: {
        registryVisibility: 'public',
        entry: './PublicPanel/PublicPanel.tsx',
        contract: './PublicPanel/PublicPanel.json',
      },
      PrivatePanel: {
        registryVisibility: 'private',
        entry: './PrivatePanel/PrivatePanel.tsx',
        contract: './PrivatePanel/PrivatePanel.json',
      },
    },
  }, null, 2));

  return {
    manifestPath: join(packageRoot, 'component-registry.json'),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function formDocWithChild(type: string): FaceUiDoc {
  return {
    version: 'ui@1',
    meta: { name: `${type} form` },
    root: {
      type: 'Form',
      children: [
        { type },
        { type: 'Input' },
        { type: 'Button', props: { type: 'submit' } },
      ],
    },
  };
}

function docWithChildren(rootType: string, childTypes: string[]): FaceUiDoc {
  return {
    version: 'ui@1',
    meta: { name: `${rootType} composition` },
    root: {
      type: rootType,
      children: childTypes.map(type => ({ type })),
    },
  };
}

function componentSelectionViolations(doc: FaceUiDoc, enforceComponentSelection?: boolean) {
  return validateComposition(doc, {
    patterns: ['form'],
    enforceComponentSelection,
  }).violations.filter(v => v.ruleId === COMPONENT_SELECTION_RULE_ID);
}

function registryBoundaryViolations(
  doc: FaceUiDoc,
  registryManifestPath?: string,
  enforceRegistryBoundary = true,
) {
  return validateComposition(doc, {
    registryManifestPath,
    enforceRegistryBoundary,
  }).violations.filter(v => v.ruleId === REGISTRY_BOUNDARY_RULE_ID);
}

describe('composition pattern component selection', () => {
  it('exposes Face UI primitive and UF product block counts in pattern summaries', () => {
    const patterns = listPatterns();

    for (const id of BUILTIN_PATTERN_IDS) {
      const pattern = patterns.find(item => item.id === id);
      expect(pattern, id).toBeDefined();
      expect(pattern?.componentSelection?.faceUiPrimitives, id).toBeGreaterThan(0);
      expect(pattern?.componentSelection?.ufProductBlocks, id).toBeGreaterThan(0);
    }
  });

  it('keeps UF product block references tied to real contracts', () => {
    const root = repoRoot();

    for (const id of BUILTIN_PATTERN_IDS) {
      const pattern = loadPatternById(id);
      const selection = pattern?.componentSelection;
      expect(selection?.chooseFaceUiWhen?.length, id).toBeGreaterThan(0);
      expect(selection?.chooseUfWhen?.length, id).toBeGreaterThan(0);

      for (const block of selection?.ufProductBlocks || []) {
        expect(block.name, id).toBeTruthy();
        expect(block.contract, block.name).toMatch(/^packages\/uf\//);
        expect(existsSync(resolve(root, block.contract)), block.contract).toBe(true);
      }
    }
  });

  it('keeps pattern Face UI primitive references tied to the Face UI registry', () => {
    const root = repoRoot();
    const faceUiRegistry = JSON.parse(
      readFileSync(resolve(root, 'packages/face-ui-react/component-registry.json'), 'utf8'),
    ) as { components?: Record<string, unknown> };
    const registryNames = new Set(Object.keys(faceUiRegistry.components || {}));

    for (const id of BUILTIN_PATTERN_IDS) {
      const pattern = loadPatternById(id);
      const primitiveNames = pattern?.componentSelection?.faceUiPrimitives || [];
      expect(primitiveNames.length, id).toBeGreaterThan(0);

      for (const name of primitiveNames) {
        expect(registryNames.has(name), `${id}:${name}`).toBe(true);
      }
    }
  });

  it('does not enforce componentSelection by default', () => {
    const violations = componentSelectionViolations(formDocWithChild('LocalWizard'));

    expect(violations).toEqual([]);
  });

  it('flags unknown uppercase component types when componentSelection enforcement is enabled', () => {
    const violations = componentSelectionViolations(formDocWithChild('LocalWizard'), true);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.location.component).toBe('LocalWizard');
  });

  it('accepts listed UF product blocks and Face UI primitives when enforcement is enabled', () => {
    const ufBlockViolations = componentSelectionViolations(formDocWithChild('Form'), true);
    const primitiveViolations = componentSelectionViolations(formDocWithChild('Card'), true);

    expect(ufBlockViolations).toEqual([]);
    expect(primitiveViolations).toEqual([]);
  });

  it('exposes UF pricing CTA blocks through the pricing pattern', () => {
    const pattern = loadPatternById('pricing');
    const blocks = pattern?.componentSelection?.ufProductBlocks || [];

    expect(blocks.map(block => block.name).sort()).toEqual(['ButtonPrice', 'PriceButton']);
    expect(pattern?.componentSelection?.chooseFaceUiWhen?.length).toBeGreaterThan(0);
    expect(pattern?.componentSelection?.chooseUfWhen?.length).toBeGreaterThan(0);
  });
});

describe('composition registry boundary', () => {
  it('does not enforce the UF registry boundary by default', () => {
    const fixture = makeRegistryBoundaryFixture();
    const defaultReport = validateComposition(docWithChildren('Card', ['LocalWizard']), {
      registryManifestPath: fixture.manifestPath,
    });
    const violations = registryBoundaryViolations(
      docWithChildren('Card', ['LocalWizard']),
      fixture.manifestPath,
      false,
    );

    expect(defaultReport.violations.filter(v => v.ruleId === REGISTRY_BOUNDARY_RULE_ID)).toEqual([]);
    expect(violations).toEqual([]);
  });

  it('reports a configuration error when registry boundary enforcement has no manifest', () => {
    const report = validateComposition(docWithChildren('Card', ['LocalWizard']), {
      enforceRegistryBoundary: true,
    });

    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: REGISTRY_BOUNDARY_MISSING_MANIFEST_RULE_ID,
          severity: 'error',
        }),
      ]),
    );
  });

  it('reports a configuration error when the registry boundary manifest is invalid', () => {
    const report = validateComposition(docWithChildren('Card', ['LocalWizard']), {
      enforceRegistryBoundary: true,
      registryManifestPath: join(tmpdir(), 'missing-userface-registry-manifest.json'),
    });

    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: REGISTRY_BOUNDARY_INVALID_MANIFEST_RULE_ID,
          severity: 'error',
        }),
      ]),
    );
  });

  it('accepts Face UI components and public UF manifest components when registry boundary enforcement is enabled', () => {
    const fixture = makeRegistryBoundaryFixture();
    const violations = registryBoundaryViolations(
      docWithChildren('Card', ['Accordion', 'Button', 'Tooltip', 'PublicPanel']),
      fixture.manifestPath,
    );

    expect(violations).toEqual([]);
  });

  it('keeps the Face UI allowlist complete when the registry file cannot be resolved from cwd', () => {
    const fixture = makeRegistryBoundaryFixture();
    const originalCwd = process.cwd();
    const externalCwd = mkdtempSync(join(tmpdir(), 'userface-composition-external-cwd-'));
    tempRoots.push(externalCwd);

    try {
      process.chdir(externalCwd);
      const violations = registryBoundaryViolations(
        docWithChildren('Accordion', ['Tooltip', 'PublicPanel']),
        fixture.manifestPath,
      );

      expect(violations).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('flags uppercase component types outside the public UF manifest when registry boundary enforcement is enabled', () => {
    const fixture = makeRegistryBoundaryFixture();
    const violations = registryBoundaryViolations(
      docWithChildren('Card', ['LocalWizard', 'PrivatePanel']),
      fixture.manifestPath,
    );

    expect(violations.map(v => v.location.component)).toEqual(['LocalWizard', 'PrivatePanel']);
    expect(violations.every(v => v.severity === 'warning')).toBe(true);
  });

  it('flags raw interactive DOM types when registry boundary enforcement is enabled', () => {
    const fixture = makeRegistryBoundaryFixture();
    const report = validateComposition(docWithChildren('Card', ['button', 'input', 'div']), {
      enforceRegistryBoundary: true,
      registryManifestPath: fixture.manifestPath,
    });
    const violations = report.violations
      .filter(v => v.ruleId === REGISTRY_BOUNDARY_RAW_TYPE_RULE_ID)
      .map(v => v.location.component)
      .sort();

    expect(violations).toEqual(['button', 'input']);
  });

  it('keeps opt-in registry-boundary warnings visible in llm budget', () => {
    const fixture = makeRegistryBoundaryFixture();
    const report = validateComposition(docWithChildren('Card', ['button', 'PrivatePanel']), {
      enforceRegistryBoundary: true,
      registryManifestPath: fixture.manifestPath,
      budget: 'llm',
    });
    const violations = report.violations
      .filter(v => v.ruleId.startsWith(REGISTRY_BOUNDARY_RULE_PREFIX))
      .map(v => ({
        ruleId: v.ruleId,
        severity: v.severity,
        component: v.location.component,
      }));

    expect(report.violationsTotal).toBe(2);
    expect(report.violationsShown).toBe(2);
    expect(violations).toEqual([
      {
        ruleId: REGISTRY_BOUNDARY_RULE_ID,
        severity: 'warning',
        component: 'PrivatePanel',
      },
      {
        ruleId: REGISTRY_BOUNDARY_RAW_TYPE_RULE_ID,
        severity: 'warning',
        component: 'button',
      },
    ]);
  });

  it('snapshots every composition registry-boundary rule id', () => {
    const fixture = makeRegistryBoundaryFixture();
    const emittedRuleIds = [
      validateComposition(docWithChildren('Card', ['PrivatePanel', 'button']), {
        enforceRegistryBoundary: true,
        registryManifestPath: fixture.manifestPath,
      }),
      validateComposition(docWithChildren('Card', ['LocalWizard']), {
        enforceRegistryBoundary: true,
      }),
      validateComposition(docWithChildren('Card', ['LocalWizard']), {
        enforceRegistryBoundary: true,
        registryManifestPath: join(tmpdir(), 'missing-userface-registry-manifest.json'),
      }),
    ]
      .flatMap(report => report.violations)
      .filter(v => v.ruleId.startsWith(REGISTRY_BOUNDARY_RULE_PREFIX))
      .map(v => v.ruleId)
      .sort();

    expect([...new Set(emittedRuleIds)]).toEqual(registryBoundaryRuleIdsInSource());
    expect(registryBoundaryRuleIdsInSource()).toMatchInlineSnapshot(`
      [
        "composition/registry-boundary-invalid-manifest",
        "composition/registry-boundary-missing-manifest",
        "composition/registry-boundary-non-public-component",
        "composition/registry-boundary-raw-type",
      ]
    `);
  });

  it('snapshots current UF ui@1 registry-boundary warnings without broadening the public manifest', () => {
    const cases = new Map([
      ['packages/uf/library-workspace.ui@1.json', {
        expectedViolations: [],
        allowedPublicComponents: ['Card', 'InfoTree', 'MetricTabs', 'PriceButton', 'ProgressStack', 'Text'],
      }],
      ['packages/uf/chat-panel.ui@1.json', {
        expectedViolations: [
          { ruleId: REGISTRY_BOUNDARY_RULE_ID, component: 'ChatPanel' },
        ],
        allowedPublicComponents: [],
      }],
      ['packages/uf/userface-browser.ui@1.json', {
        expectedViolations: [
          { ruleId: REGISTRY_BOUNDARY_RULE_ID, component: 'UserfacePanel' },
        ],
        allowedPublicComponents: [],
      }],
    ]);
    const discoveredFixturePaths = readdirSync(resolve(repoRoot(), 'packages/uf'))
      .filter(file => file.endsWith('.ui@1.json'))
      .map(file => `packages/uf/${file}`)
      .sort();

    expect(discoveredFixturePaths).toEqual([...cases.keys()].sort());

    for (const path of discoveredFixturePaths) {
      const entry = cases.get(path);
      expect(entry, path).toBeDefined();
      if (!entry) continue;

      const report = validateComposition(readRepoFaceDoc(path), {
        enforceRegistryBoundary: true,
        registryManifestPath: actualUfRegistryManifestPath(),
      });
      const violations = report.violations
        .filter(v => v.ruleId.startsWith(REGISTRY_BOUNDARY_RULE_PREFIX))
        .map(v => ({
          ruleId: v.ruleId,
          component: v.location.component,
        }))
        .sort((a, b) => `${a.ruleId}:${a.component}`.localeCompare(`${b.ruleId}:${b.component}`));
      const violationComponents = violations.map(v => v.component);

      expect(violations, path).toEqual(entry.expectedViolations);

      for (const component of entry.allowedPublicComponents) {
        expect(violationComponents, path).not.toContain(component);
      }
    }
  });

  it('keeps root-public UF non-pattern surfaces behind the opt-in registry boundary', () => {
    const privateSurfaceTypes = [
      'ActionSurface',
      'ErrorStatusPage',
      'GlobalTopBar',
      'HostedApiDashboard',
      'PaymentStatusCard',
      'TextLink',
    ];
    const report = validateComposition(docWithChildren('Card', [
      'ButtonPrice',
      'PriceButton',
      ...privateSurfaceTypes,
    ]), {
      enforceRegistryBoundary: true,
      registryManifestPath: actualUfRegistryManifestPath(),
    });

    const boundaryComponents = report.violations
      .filter(v => v.ruleId === REGISTRY_BOUNDARY_RULE_ID)
      .map(v => v.location.component)
      .sort();

    expect(boundaryComponents).toEqual([...privateSurfaceTypes].sort());
  });
});
