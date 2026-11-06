/**
 * Face UI corpus contract check.
 *
 * The engine ships an AI-facing corpus: composition patterns, recipe packs, the
 * runnable example, and the API lessons in `prompts/` and `README.md`. A model
 * copies those files literally, so a prop that Face UI never declared becomes
 * real emitted UI whose prop is silently dropped at render time. This test
 * resolves every Face UI node in that corpus against the Face UI component
 * contracts and fails on:
 *
 *   - a prop the component does not declare,
 *   - a required prop that is missing,
 *   - node children under a component that does not accept children,
 *   - an enum prop set to a value the contract does not list,
 *   - a pattern advertising a Face UI primitive that Face UI does not have.
 *
 * Contract source. A clean checkout of this repository must build without the
 * sibling `face-ui/` working copy, and the engine bundles no Face UI contracts,
 * so the authority at test time is the committed snapshot
 * `src/__tests__/fixtures/face-ui-contracts.json`. When the canonical Face UI
 * checkout *is* reachable (`FACE_UI_DIR`, else `<repo>/../face-ui`) the snapshot
 * is re-derived from `<Name>/<Name>.json` plus `<Name>/<Name>.tsx` and compared,
 * so contract drift fails here instead of reaching a model. Regenerate the
 * snapshot with `FACE_UI_CONTRACTS_UPDATE=1`.
 *
 * Native surface. Components forward a narrow set of DOM attributes and events
 * to their element; those are accepted unless the component's own props type
 * omits them, as are `data-*` and `aria-*`. `title` is deliberately not in that
 * set: in Face UI a rendered title is a declared prop (Card, Modal, Code, Toast,
 * Icon), so a `title` on a component that does not declare one is a heading the
 * author expects to see and never will.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

interface ComponentContract {
  /** Every prop name the component declares (contract JSON plus its props type). */
  props: string[];
  /** Props the contract marks required. */
  required: string[];
  /** Enum props and the values the contract lists. */
  enums: Record<string, (string | number)[]>;
  /** Whether the component takes node children. */
  acceptsChildren: boolean;
  /** Native attributes the component's props type explicitly omits. */
  deniedNative: string[];
}

interface ContractSnapshot {
  note: string;
  source: { repo: string; ref: string };
  components: Record<string, ComponentContract>;
}

/** DOM attributes a Face UI component forwards to its element. */
const NATIVE_ATTRS = ['className', 'dir', 'hidden', 'id', 'lang', 'role', 'slot', 'style', 'tabIndex', 'type'];

/** DOM events a Face UI component forwards to its element. */
const NATIVE_EVENTS = [
  'onBlur', 'onChange', 'onClick', 'onContextMenu', 'onCopy', 'onCut', 'onDoubleClick',
  'onDragEnd', 'onDragOver', 'onDragStart', 'onDrop', 'onFocus', 'onInput', 'onKeyDown',
  'onKeyUp', 'onMouseDown', 'onMouseEnter', 'onMouseLeave', 'onMouseUp', 'onPaste',
  'onPointerDown', 'onPointerUp', 'onReset', 'onScroll', 'onSubmit', 'onWheel',
];

function repoRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'packages/engine'))) return cwd;
  return resolve(cwd, '../..');
}

const PKG = resolve(repoRoot(), 'packages/engine');
const SNAPSHOT_PATH = resolve(PKG, 'src/__tests__/fixtures/face-ui-contracts.json');

/** The canonical Face UI checkout, when this machine has one. `FACE_UI_DIR`, when set, is the only candidate. */
function faceUiDir(): string | null {
  const dir = process.env.FACE_UI_DIR || resolve(repoRoot(), '../face-ui');
  return existsSync(join(dir, 'Button', 'Button.json')) ? dir : null;
}

/** Top-level members and `Omit<..., 'a' | 'b'>` exclusions of a component's props type. */
function readPropsType(source: string, component: string): { members: string[]; omits: string[] } {
  const members = new Set<string>();
  const omits = new Set<string>();
  const declaration = new RegExp(
    `(?:export\\s+)?(?:interface|type)\\s+(?:${component}(?:Props|SharedProps|BaseProps|SingleProps|MultipleProps))\\b`,
    'g',
  );
  for (let match = declaration.exec(source); match; match = declaration.exec(source)) {
    const open = source.indexOf('{', match.index + match[0].length);
    if (open < 0) continue;
    const head = source.slice(match.index + match[0].length, open);
    for (const omit of head.matchAll(/Omit<[^,]+,([^>]*)>/gs)) {
      for (const name of omit[1].matchAll(/'([^']+)'/g)) omits.add(name[1]);
    }
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === '{') depth += 1;
      else if (source[close] === '}' && (depth -= 1) === 0) break;
    }
    const body = source.slice(open + 1, close);
    for (const member of body.matchAll(/^ {2}'?([A-Za-z][A-Za-z0-9-]*)'?\??\s*:/gm)) members.add(member[1]);
  }
  return { members: [...members], omits: [...omits] };
}

function readLiveContracts(dir: string): Record<string, ComponentContract> {
  const components: Record<string, ComponentContract> = {};
  for (const name of readdirSync(dir).sort()) {
    const contractPath = join(dir, name, `${name}.json`);
    if (!existsSync(contractPath)) continue;
    let contract: any;
    try {
      contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    } catch {
      continue;
    }
    if (contract?.schema !== 'face' || typeof contract?.props !== 'object' || contract.props === null) continue;
    const declared: Record<string, any> = contract.props;
    const tsxPath = join(dir, name, `${name}.tsx`);
    const tsx = existsSync(tsxPath)
      ? readPropsType(readFileSync(tsxPath, 'utf8'), name)
      : { members: [], omits: [] };
    const props = [...new Set([...Object.keys(declared), ...tsx.members])].sort();
    const enums: Record<string, (string | number)[]> = {};
    for (const [prop, def] of Object.entries(declared)) {
      if (def && typeof def === 'object' && def.type === 'enum' && Array.isArray(def.options)) enums[prop] = def.options;
    }
    components[name] = {
      props,
      required: Object.entries(declared)
        .filter(([, def]) => def && typeof def === 'object' && def.required === true)
        .map(([prop]) => prop)
        .sort(),
      enums,
      acceptsChildren: props.includes('children'),
      deniedNative: tsx.omits.sort(),
    };
  }
  return components;
}

const snapshot: ContractSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
const CONTRACTS = snapshot.components;

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  path: string;
  component: string;
  rule: string;
  detail: string;
}

const violations: Violation[] = [];
const resolvedNodesByFile: Record<string, number> = {};

function acceptsProp(contract: ComponentContract, prop: string): boolean {
  if (contract.props.includes(prop)) return true;
  if (prop.startsWith('data-') || prop.startsWith('aria-')) return true;
  if (contract.deniedNative.includes(prop)) return false;
  return NATIVE_ATTRS.includes(prop) || NATIVE_EVENTS.includes(prop);
}

/**
 * Check one reference to a component.
 *
 * `instance` marks a node in a face document, where missing required props and
 * unsupported children are real defects. A pattern constraint entry only names
 * the props it asserts on, so it is checked for prop names and enum values only.
 */
function checkNode(file: string, path: string, node: any, instance: boolean): void {
  const type = node?.type;
  if (typeof type !== 'string') return;
  const contract = CONTRACTS[type];
  if (!contract) return;
  resolvedNodesByFile[file] = (resolvedNodesByFile[file] ?? 0) + 1;
  const props = (node.props && typeof node.props === 'object') ? node.props : {};
  const add = (rule: string, detail: string) => violations.push({ file, path, component: type, rule, detail });

  for (const [prop, value] of Object.entries<any>(props)) {
    if (!acceptsProp(contract, prop)) {
      add('undeclared-prop', `${type} does not declare "${prop}"`);
      continue;
    }
    const options = contract.enums[prop];
    if (options && (typeof value === 'string' || typeof value === 'number') && !options.map(String).includes(String(value))) {
      add('unknown-enum-value', `${type}.${prop} = ${JSON.stringify(value)} is not one of ${JSON.stringify(options)}`);
    }
  }

  if (!instance) return;
  for (const required of contract.required) {
    if (!(required in props)) add('missing-required-prop', `${type} requires "${required}"`);
  }
  const children = Array.isArray(node.children) ? node.children : [];
  if (children.length > 0 && !contract.acceptsChildren) {
    add('children-not-accepted', `${type} takes no children (${children.length} given)`);
  }
}

function walkNode(file: string, path: string, node: any): void {
  if (!node || typeof node !== 'object') return;
  checkNode(file, path, node, true);
  const children = Array.isArray(node.children) ? node.children : [];
  children.forEach((child: any, index: number) => {
    if (child && typeof child === 'object') walkNode(file, `${path}.children[${index}]<${child.type}>`, child);
  });
}

function walkFaceDoc(file: string, path: string, doc: any): boolean {
  if (doc?.schema !== 'face' || !doc.root || typeof doc.root !== 'object') return false;
  walkNode(file, `${path}root<${doc.root.type}>`, doc.root);
  return true;
}

function listJson(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith(suffix)).sort().map(name => join(dir, name));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const PATTERN_FILES = listJson(resolve(PKG, 'src/face-ui/patterns'), '.pattern.json');
const RECIPE_FILES = listJson(resolve(PKG, 'packs/recipes'), '.ui.json');
const EXAMPLE_FILES = (() => {
  const root = resolve(PKG, 'examples');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(name => join(root, name, 'face.json'))
    .filter(path => existsSync(path))
    .sort();
})();
const LESSON_FILES = [...listJson(resolve(PKG, 'prompts'), '.md'), resolve(PKG, 'README.md')].filter(existsSync);

const CORPUS_FILES = [...PATTERN_FILES, ...RECIPE_FILES, ...EXAMPLE_FILES, ...LESSON_FILES];

function label(path: string): string {
  return path.slice(PKG.length + 1);
}

for (const file of PATTERN_FILES) {
  const name = label(file);
  const pattern = readJson(file);
  if (pattern.skeleton) walkFaceDoc(name, 'skeleton.', pattern.skeleton);
  (pattern.examples ?? []).forEach((example: any, index: number) => {
    if (example?.skeleton) walkFaceDoc(name, `examples[${index}].skeleton.`, example.skeleton);
  });
  const constraints = (scope: any, prefix: string) => {
    for (const key of ['requires', 'recommends']) {
      (scope?.[key] ?? []).forEach((entry: any, index: number) => {
        checkNode(name, `${prefix}${key}[${index}]`, entry, false);
      });
    }
  };
  constraints(pattern, '');
  (pattern.variants ?? []).forEach((variant: any, index: number) => constraints(variant, `variants[${index}].`));
}

for (const file of [...RECIPE_FILES, ...EXAMPLE_FILES]) {
  walkFaceDoc(label(file), '', readJson(file));
}

/** Fenced JSON blocks of a Markdown lesson, paired by fence so a tagged block never swallows prose. */
function jsonBlocks(text: string): { line: number; body: string }[] {
  const blocks: { line: number; body: string }[] = [];
  let open: { json: boolean; line: number; body: string[] } | null = null;
  text.split('\n').forEach((raw, index) => {
    const fence = /^```(\S*)\s*$/.exec(raw);
    if (open) {
      if (fence && fence[1] === '') {
        if (open.json) blocks.push({ line: open.line, body: open.body.join('\n') });
        open = null;
      } else {
        open.body.push(raw);
      }
      return;
    }
    if (fence) open = { json: ['', 'json', 'jsonc'].includes(fence[1]), line: index + 2, body: [] };
  });
  return blocks;
}

for (const file of LESSON_FILES) {
  const name = label(file);
  for (const block of jsonBlocks(readFileSync(file, 'utf8'))) {
    let doc: any;
    try {
      doc = JSON.parse(block.body);
    } catch {
      continue;
    }
    walkFaceDoc(name, `block@${block.line}.`, doc);
  }
}

function formatViolations(): string {
  return violations.map(v => `${v.file} ${v.path} [${v.rule}] ${v.detail}`).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Face UI corpus', () => {
  it.skipIf(!faceUiDir())('keeps the contract snapshot in step with the canonical Face UI package', () => {
    const dir = faceUiDir() as string;
    const live = readLiveContracts(dir);
    if (process.env.FACE_UI_CONTRACTS_UPDATE === '1') {
      const next: ContractSnapshot = { ...snapshot, components: live };
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    }
    const current: ContractSnapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    expect(current.components).toEqual(live);
  });

  it('reaches every corpus file that carries Face UI nodes', () => {
    expect(PATTERN_FILES.map(file => basename(file))).toContain('dashboard.pattern.json');
    expect(RECIPE_FILES.map(file => basename(file))).toContain('dashboard.ui.json');
    expect(EXAMPLE_FILES.length).toBeGreaterThan(0);
    const silent = CORPUS_FILES.map(label).filter(name => !resolvedNodesByFile[name]);
    // `cursor-rules.md` and `claude-prompt.md` carry no face document today; a
    // corpus file that stops resolving any Face UI node is otherwise a scanner
    // regression, not a clean corpus.
    expect(silent).toEqual(['prompts/claude-prompt.md', 'prompts/cursor-rules.md']);
  });

  it('emits no prop, child or enum value Face UI does not accept', () => {
    expect(formatViolations()).toBe('');
  });

  it('knows the same Face UI components as the composition validator', () => {
    const source = readFileSync(resolve(PKG, 'src/face-ui/compositionValidator.ts'), 'utf8');
    const roster = /const FALLBACK_FACE_UI_COMPONENT_TYPES\s*=\s*\[([\s\S]*?)\] as const;/.exec(source);
    expect(roster).not.toBeNull();
    const names = [...(roster as RegExpExecArray)[1].matchAll(/'([A-Za-z]+)'/g)].map(match => match[1]);
    expect(names.slice().sort()).toEqual(Object.keys(CONTRACTS).sort());
  });

  it('advertises only real Face UI primitives in pattern component selection', () => {
    const unknown: string[] = [];
    for (const file of PATTERN_FILES) {
      const pattern = readJson(file);
      for (const primitive of pattern?.componentSelection?.faceUiPrimitives ?? []) {
        if (!CONTRACTS[primitive]) unknown.push(`${label(file)} ${primitive}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});
