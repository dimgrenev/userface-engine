import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdvancedPropParser } from '../prop-analysis/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('canonical prop analysis', () => {
  it.each([
    { fileName: 'Empty.tsx', framework: 'react' as const, exportName: 'Empty', content: 'export function Empty(){ return null; }' },
    { fileName: 'Empty.jsx', framework: 'react' as const, exportName: 'default', content: 'export default function Empty(){ return null; }' },
    { fileName: 'Empty.js', framework: 'react' as const, exportName: 'default', content: 'export default function Empty(){ return null; }' },
    { fileName: 'Empty.vue', framework: 'vue' as const, exportName: 'default', content: '<script setup lang="ts"></script><template><p>Empty</p></template>' },
    { fileName: 'EmptyGeneric.vue', framework: 'vue' as const, exportName: 'default', content: '<script setup lang="ts">defineProps<{}>()</script><template><p>Empty</p></template>' },
    { fileName: 'EmptyRuntime.vue', framework: 'vue' as const, exportName: 'default', content: '<script setup lang="ts">defineProps({})</script><template><p>Empty</p></template>' },
    { fileName: 'Empty.svelte', framework: 'svelte' as const, exportName: 'default', content: '<script lang="ts"></script><p>Empty</p>' },
    { fileName: 'EmptyRune.svelte', framework: 'svelte' as const, exportName: 'default', content: '<script lang="ts">let {} = $props();</script><p>Empty</p>' },
  ])('reports a valid zero-prop $framework source as success', ({ fileName, framework, exportName, content }) => {
    const parser = new AdvancedPropParser();
    try {
      const result = parser.parseResult({ fileName, framework, exportName, format: 'source' }, { [fileName]: { content } });
      expect(result).toEqual({ ok: true, props: [], diagnostics: [] });
    } finally { parser.dispose(); }
  });

  it('distinguishes invalid format, missing captured entry, and missing Source/Story exports', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'uf-prop-result-'));
    roots.push(root);
    await writeFile(path.join(root, 'OnlyOnDisk.tsx'), 'export function OnlyOnDisk(){return null;}');
    const parser = new AdvancedPropParser({ root, allowFileSystem: true });
    const source = { 'Multiple.tsx': { content: 'export function Present(){return null;} export default function Empty(){return null;}' } };
    const stories = { 'Multiple.stories.tsx': { content: 'export default { args: { neighbor: 1 } }; export const Present = { args: { own: 2 } };' } };
    try {
      expect(parser.parseResult({ fileName: 'OnlyOnDisk.tsx', exportName: 'OnlyOnDisk' }, {})).toMatchObject({
        ok: false, error: { reason: 'missing-entry' }, diagnostics: [{ reason: 'advancedPropParser.parse' }],
      });
      expect(parser.parseResult({ fileName: 'Multiple.tsx', format: 'invalid' as 'source' }, source)).toMatchObject({
        ok: false, error: { reason: 'invalid-format' },
      });
      expect(parser.parseResult({ fileName: 'Multiple.tsx', exportName: 'Absent', format: 'source' }, source)).toMatchObject({
        ok: false, error: { reason: 'missing-export' },
      });
      for (const format of ['story', undefined] as const) {
        const result = parser.parseResult({ fileName: 'Multiple.stories.tsx', exportName: 'Absent', format }, stories);
        expect(result).toMatchObject({ ok: false, error: { reason: 'missing-export' } });
        expect(result.ok ? result.props : []).toEqual([]);
      }
      expect(parser.parse('Multiple.tsx', source, 'react', 'Absent')).toEqual([]);
    } finally { parser.dispose(); }
  });

  it('keeps CSF2/CSF3 selected stories successful and rejects missing story exports', () => {
    const parser = new AdvancedPropParser();
    const fileName = 'Button.stories.tsx';
    const files = { [fileName]: { content: `
      export default { argTypes: { tone: { options: ['warm', 'cool'] } } };
      export const Modern = { args: { tone: 'warm' } };
      const Template = () => null;
      export const Legacy = Template.bind({});
      Legacy.args = { tone: 'cool' };
    ` } };
    try {
      const results = parser.parseManyResults(['Modern', 'Legacy', 'Absent'].map(exportName => ({ fileName, exportName, format: 'story' })), files);
      expect(results[0]).toMatchObject({ ok: true, props: [{ name: 'tone', defaultValue: 'warm' }] });
      expect(results[1]).toMatchObject({ ok: true, props: [{ name: 'tone', defaultValue: 'cool' }] });
      expect(results[2]).toMatchObject({ ok: false, error: { reason: 'missing-export' } });
    } finally { parser.dispose(); }
  });

  it('resolves local CSF3 spreads across Story, meta, args, and argTypes with last-write precedence', () => {
    const parser = new AdvancedPropParser();
    const fileName = 'Spread.stories.tsx';
    const files = { [fileName]: { content: `
      const metaBase = { args: { fromMeta: 'Meta' } };
      export default { ...metaBase };
      const baseArgs = { label: 'Base', count: 1 };
      const overriddenArgs = { ...baseArgs, label: 'Own' };
      const choices = { tone: { options: ['warm', 'cool'] } };
      const shared = { args: overriddenArgs, argTypes: { ...choices } };
      export const Primary = { ...shared };
    ` } };
    try {
      const result = parser.parseResult({ fileName, exportName: 'Primary', format: 'story' }, files);
      expect(result).toMatchObject({ ok: true, diagnostics: [] });
      expect(result.ok && result.props.map(prop => prop.name)).toEqual(['fromMeta', 'label', 'count', 'tone']);
      expect(result.ok && result.props.find(prop => prop.name === 'label')?.defaultValue).toBe('Own');
      expect(result.ok && result.props.find(prop => prop.name === 'tone')?.options).toEqual(['warm', 'cool']);
    } finally { parser.dispose(); }
  });

  it('does not call dynamic Story spreads and reports an unknown empty schema', () => {
    const parser = new AdvancedPropParser();
    const fileName = 'Dynamic.stories.tsx';
    try {
      const unknown = parser.parseResult({ fileName, exportName: 'Primary', format: 'story' },
        { [fileName]: { content: 'export default {}; export const Primary = { ...makeStory() };' } });
      expect(unknown).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
      expect(unknown.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.story.unresolvedSpread' }),
      ]));
      const partial = parser.parseResult({ fileName, exportName: 'Primary', format: 'story' },
        { [fileName]: { content: 'export default {}; export const Primary = { ...makeStory(), args: { label: "Known" } };' } });
      expect(partial).toMatchObject({ ok: true, props: [{ name: 'label', defaultValue: 'Known' }] });
      expect(partial.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.story.unresolvedSpread' }),
      ]));
    } finally { parser.dispose(); }
  });

  it('resolves a local dotted object reference inside a nested CSF3 args spread', () => {
    const parser = new AdvancedPropParser();
    const fileName = 'Dotted.stories.tsx';
    try {
      const result = parser.parseResult({ fileName, exportName: 'Primary', format: 'story' },
        { [fileName]: { content: `
          const shared = { args: { label: 'Shared', count: 2 } };
          export default {};
          export const Primary = { args: { ...shared.args, label: 'Own' } };
        ` } });
      expect(result).toMatchObject({ ok: true, diagnostics: [] });
      expect(result.ok && result.props.map(prop => [prop.name, prop.defaultValue]))
        .toEqual([['label', 'Own'], ['count', 2]]);
    } finally { parser.dispose(); }
  });

  it('guards cyclic local Story spreads and reports a metadata failure', () => {
    const parser = new AdvancedPropParser();
    const fileName = 'Cycle.stories.tsx';
    try {
      const result = parser.parseResult({ fileName, exportName: 'Primary', format: 'story' },
        { [fileName]: { content: 'const a = { ...b }; const b = { ...a }; export default {}; export const Primary = { ...a };' } });
      expect(result).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.story.unresolvedSpread' }),
      ]));
    } finally { parser.dispose(); }
  });

  it('rejects type-only exports as selected Story or Source values', () => {
    const parser = new AdvancedPropParser();
    try {
      const storyFile = 'TypeOnly.stories.tsx';
      const storyFiles = { [storyFile]: { content: 'export default { args: { borrowed: 1 } }; export type Primary = { args: { own: number } };' } };
      expect(parser.parseResult({ fileName: storyFile, exportName: 'Primary', format: 'story' }, storyFiles))
        .toMatchObject({ ok: false, error: { reason: 'missing-export' } });
      const sourceFile = 'TypeOnly.tsx';
      const sourceFiles = { [sourceFile]: { content: 'export type Primary = { own: number };' } };
      expect(parser.parseResult({ fileName: sourceFile, exportName: 'Primary', format: 'source' }, sourceFiles))
        .toMatchObject({ ok: false, error: { reason: 'missing-export' } });
    } finally { parser.dispose(); }
  });

  it('keeps type-checker failure visible for an explicit React export', () => {
    const parser = new AdvancedPropParser();
    const internal = parser as any;
    const checker = vi.spyOn(internal, 'extractPropsFromTypeChecker').mockImplementation(() => { throw new Error('checker failed'); });
    try {
      const result = parser.parseResult({ fileName: 'Demo.tsx', exportName: 'Demo', format: 'source' },
        { 'Demo.tsx': { content: 'export function Demo(props: { label: string }) { return null; }' } });
      expect(result).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.react.typeChecker' }),
      ]));
    } finally { checker.mockRestore(); parser.dispose(); }
  });

  it('reports an unresolved imported props type on the selected result', () => {
    const parser = new AdvancedPropParser();
    try {
      const target = { fileName: 'Demo.tsx', exportName: 'Demo', format: 'source' as const };
      const files = { 'Demo.tsx': { content: 'import type { Props } from "./missing"; export function Demo(props: Props) { return null; }' } };
      const first = parser.parseResult(target, files);
      const cached = parser.parseResult(target, files);
      expect(first).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
      expect(first.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.type.unresolvedImport' }),
      ]));
      expect(cached).toEqual(first);
    } finally { parser.dispose(); }
  });

  it('keeps a valid empty selected component separate from an unrelated missing type import', () => {
    const parser = new AdvancedPropParser();
    try {
      const result = parser.parseResult({ fileName: 'Empty.tsx', exportName: 'Empty', format: 'source' },
        { 'Empty.tsx': { content: 'import type { Unused } from "./missing"; export function Empty() { return null; }' } });
      expect(result).toMatchObject({ ok: true, props: [] });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.type.unresolvedImport' }),
      ]));
    } finally { parser.dispose(); }
  });

  it('does not misreport runtime CSS or asset imports as unresolved props types', () => {
    const parser = new AdvancedPropParser();
    try {
      const target = { fileName: 'Counter.tsx', exportName: 'Counter', format: 'source' as const };
      const result = parser.parseResult(target, {
        'Counter.tsx': { content: `
          import styles from './Counter.module.css';
          import iconUrl from './icon.svg?url';
          export function Counter({ value }: { value: string }) { return null; }
        ` },
        'Counter.module.css': { content: '.root { color: red; }' },
        'icon.svg': { content: '<svg></svg>' },
      });
      expect(result).toMatchObject({ ok: true, props: [{ name: 'value' }], diagnostics: [] });
      const missingSource = parser.parseResult({ fileName: 'MissingSource.tsx', exportName: 'Empty', format: 'source' }, {
        'MissingSource.tsx': { content: 'import { helper } from "./missing.ts"; export function Empty() { return null; }' },
      });
      expect(missingSource).toMatchObject({ ok: true, props: [] });
      expect(missingSource.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.type.unresolvedImport' }),
      ]));
    } finally { parser.dispose(); }
  });

  it('fails an unknown selected props type without confusing unrelated or partial type errors', () => {
    const parser = new AdvancedPropParser();
    const target = { fileName: 'Demo.tsx', exportName: 'Demo', format: 'source' as const };
    try {
      for (const content of [
        'export function Demo(props: MissingProps) { return null; }',
        'type LocalProps = MissingProps; export function Demo(props: LocalProps) { return null; }',
      ]) {
        const result = parser.parseResult(target, { 'Demo.tsx': { content } });
        expect(result).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({ reason: 'advancedPropParser.type.unresolvedType' }),
        ]));
      }
      const partial = parser.parseResult(target, { 'Demo.tsx': { content:
        'export function Demo(props: { label: string; missing: MissingProps }) { return null; }' } });
      expect(partial).toMatchObject({ ok: true, props: [{ name: 'label' }, { name: 'missing' }] });
      expect(partial.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.type.unresolvedType' }),
      ]));
      const unrelated = parser.parseResult({ fileName: 'Demo.tsx', exportName: 'Empty', format: 'source' },
        { 'Demo.tsx': { content: 'type Unused = MissingProps; export function Empty() { return null; }' } });
      expect(unrelated).toMatchObject({ ok: true, props: [] });
    } finally { parser.dispose(); }
  });

  it('preserves positive fallback props and warning when type checking fails', () => {
    const parser = new AdvancedPropParser();
    const checker = vi.spyOn(parser as any, 'extractPropsFromTypeChecker').mockImplementation(() => { throw new Error('checker failed'); });
    try {
      const result = parser.parseResult({ fileName: 'Demo.tsx', format: 'source' },
        { 'Demo.tsx': { content: 'export function Demo({ label }: { label: string }) { return null; }' } });
      expect(result).toMatchObject({ ok: true, props: [{ name: 'label' }] });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.react.typeChecker' }),
      ]));
    } finally { checker.mockRestore(); parser.dispose(); }
  });

  it('extracts common named Vue and Svelte 5 props and flags unresolved forms', () => {
    const parser = new AdvancedPropParser();
    try {
      const vue = parser.parseResult({ fileName: 'Demo.vue', framework: 'vue', exportName: 'default', format: 'source' },
        { 'Demo.vue': { content: '<script setup lang="ts">interface Props { label: string; count?: number } const props = defineProps<Props>()</script><template><p>{{ props.label }}</p></template>' } });
      expect(vue).toMatchObject({ ok: true, props: [{ name: 'label' }, { name: 'count' }], diagnostics: [] });
      const svelte = parser.parseResult({ fileName: 'Demo.svelte', framework: 'svelte', exportName: 'default', format: 'source' },
        { 'Demo.svelte': { content: '<script lang="ts">let { label, count }: { label: string; count?: number } = $props();</script><p>{label}</p>' } });
      expect(svelte).toMatchObject({ ok: true, props: [{ name: 'label' }, { name: 'count' }], diagnostics: [] });
      const vueUnresolved = parser.parseResult({ fileName: 'Missing.vue', framework: 'vue', exportName: 'default', format: 'source' },
        { 'Missing.vue': { content: '<script setup lang="ts">import type { Props } from "./types"; defineProps<Props>()</script>' } });
      expect(vueUnresolved).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
      expect(vueUnresolved.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.vue.unresolvedPropsType' }),
      ]));
      const svelteUnresolved = parser.parseResult({ fileName: 'Missing.svelte', framework: 'svelte', exportName: 'default', format: 'source' },
        { 'Missing.svelte': { content: '<script lang="ts">let { label }: Props = $props();</script>' } });
      expect(svelteUnresolved).toMatchObject({ ok: false, error: { reason: 'parse-exception' } });
      expect(svelteUnresolved.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'advancedPropParser.svelte.unresolvedPropsType' }),
      ]));
    } finally { parser.dispose(); }
  });

  it('keeps diagnostics independent per target even when observer telemetry deduplicates', () => {
    const observed: string[] = [];
    const parser = new AdvancedPropParser({ onDiagnostic: diagnostic => observed.push(diagnostic.reason) });
    const files = { 'Valid.tsx': { content: 'export function Valid(){return null;}' } };
    try {
      const results = parser.parseManyResults([
        { fileName: 'Missing.tsx', exportName: 'Missing' },
        { fileName: 'Missing.tsx', exportName: 'Missing' },
        { fileName: 'Valid.tsx', exportName: 'Valid' },
      ], files);
      expect(results.map(result => result.ok)).toEqual([false, false, true]);
      expect(results.map(result => result.diagnostics.map(diagnostic => diagnostic.reason))).toEqual([
        ['advancedPropParser.parse'], ['advancedPropParser.parse'], [],
      ]);
      expect(observed).toEqual(['advancedPropParser.parse']);
    } finally { parser.dispose(); }
  });

  it('returns warning-only success from cache and never caches a clone or project failure', () => {
    const parser = new AdvancedPropParser();
    const files = { 'Empty.tsx': { content: 'export function Empty(){return null;}' } };
    const target = { fileName: 'Empty.tsx', exportName: 'Empty', format: 'source' as const };
    const internal = parser as any;
    const originalBuildTypeCache = internal.buildTypeCache.bind(parser);
    const warning = vi.spyOn(internal, 'buildTypeCache').mockImplementation((sourceFile: unknown) => {
      internal.reportAdvancedPropParserRecoverable('test.partial-metadata', new Error('recoverable'), { fileName: 'Empty.tsx' });
      return originalBuildTypeCache(sourceFile);
    });
    try {
      const first = parser.parseResult(target, files);
      const cached = parser.parseResult(target, files);
      expect(first).toMatchObject({ ok: true, props: [], diagnostics: [{ reason: 'test.partial-metadata' }] });
      expect(cached).toEqual(first);
      warning.mockRestore();

      const projectFailure = vi.spyOn(internal, 'initProject').mockImplementationOnce(() => { throw new Error('project broke'); });
      parser.dispose();
      expect(parser.parseResult(target, files)).toMatchObject({ ok: false, error: { reason: 'project-unavailable' } });
      projectFailure.mockRestore();
      const cloneFailure = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(() => { throw new Error('clone broke'); });
      try { expect(parser.parseResult(target, files)).toMatchObject({ ok: false, error: { reason: 'parse-exception' } }); }
      finally { cloneFailure.mockRestore(); }
      expect(parser.parseResult(target, files)).toEqual({ ok: true, props: [], diagnostics: [] });
    } finally { warning.mockRestore(); parser.dispose(); }
  });

  it('retains empty and null-like string literals alongside typed union values', () => {
    const parser = new AdvancedPropParser();
    try {
      const props = parser.parse('Choices.tsx', { 'Choices.tsx': { content: `
        export function Choices({ choice = 0 }: { choice?: 0 | '0' | false | 'false' | '' | 'null' | 'undefined' | 'NaN' }) { return null; }
      ` } }, 'react', 'Choices');
      const choice = props.find(prop => prop.name === 'choice');
      expect(choice?.options).toHaveLength(8);
      expect(choice?.options).toEqual(expect.arrayContaining([0, '0', false, 'false', '', 'null', 'undefined', 'NaN']));
      expect(choice?.defaultValue).toBe(0);
    } finally { parser.dispose(); }
  });

  it.each(['Mixed.stories.tsx', 'Scenarios.tsx'])('keeps explicit source and story metadata independent in %s and in cache', (fileName) => {
    const parser = new AdvancedPropParser();
    const files = { [fileName]: { content: `
      export function Sample({ sourceOnly = 'code' }: { sourceOnly?: string }) { return null; }
      Sample.args = { storyOnly: 'scenario' };
      export default { component: Sample };
    ` } };
    const source = { fileName, exportName: 'Sample', format: 'source' as const };
    const story = { fileName, exportName: 'Sample', format: 'story' as const };
    try {
      const names = (targets: Array<typeof source | typeof story>) => parser.parseMany(targets, files).map(props => props.map(prop => prop.name));
      expect(names([source, story, source])).toEqual([['sourceOnly'], ['sourceOnly', 'storyOnly'], ['sourceOnly']]);
      expect(names([story, source, story])).toEqual([['sourceOnly', 'storyOnly'], ['sourceOnly'], ['sourceOnly', 'storyOnly']]);
      const legacy = parser.parse(fileName, files, 'react', 'Sample').map(prop => prop.name);
      expect(legacy).toEqual(fileName.includes('.stories.') ? ['sourceOnly', 'storyOnly'] : ['sourceOnly']);
      const firstStory = parser.parseMany([story], files)[0];
      firstStory[0].name = 'mutated';
      expect(names([story])).toEqual([['sourceOnly', 'storyOnly']]);
    } finally { parser.dispose(); }
  });

  it('extracts only the selected forwardRef export from an isolated snapshot', () => {
    const parser = new AdvancedPropParser();
    try {
      const files = { 'Button.tsx': { content: `
        import { forwardRef } from 'react';
        interface ButtonProps { label: string; variant?: 'solid' | 'ghost'; }
        export function Neighbor(props: { neighborOnly: number }) { return null; }
        export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ label, variant = 'solid' }, ref) {
          return null;
        });
      ` } };
      const props = parser.parseMany([{ fileName: 'Button.tsx', exportName: 'Button', format: 'source' }], files)[0];
      expect(props.map(prop => prop.name)).toEqual(['label', 'variant']);
      expect(props.find(prop => prop.name === 'variant')).toMatchObject({
        options: ['solid', 'ghost'], defaultValue: 'solid',
      });
    } finally { parser.dispose(); }
  });

  it('requires an existing named story export instead of borrowing meta props', () => {
    const diagnostics: string[] = [];
    const parser = new AdvancedPropParser({ onDiagnostic: diagnostic => diagnostics.push(diagnostic.message) });
    const files = { 'Scenarios.tsx': { content: `
      export default { args: { neighbor: 'wrong' } };
      export const Selected = { args: { own: 1 } };
    ` } };
    try {
      const targets = ['Missing', 'default', undefined].map(exportName => ({ fileName: 'Scenarios.tsx', exportName, format: 'story' as const }));
      expect(parser.parseMany(targets, files)).toEqual([[], [], []]);
      expect(diagnostics).toHaveLength(3);
      expect(diagnostics.every(message => /story.*export/i.test(message))).toBe(true);
    } finally { parser.dispose(); }
  });

  it.each(['Scenarios.tsx', 'Scenarios.stories.tsx'])('preserves native story literal options and defaults without executing %s', (fileName) => {
    const parser = new AdvancedPropParser();
    const files = { [fileName]: { content: `
      throw new Error('metadata must not execute');
      export default { argTypes: { choice: { options: [-1, 1, '1', true, false], control: 'select' } } };
      export const Selected = { args: { choice: false, label: null, count: -2 } };
    ` } };
    try {
      expect(parser.parseMany([{ fileName, exportName: 'Selected', format: 'story' }], files)[0]).toMatchObject([
        { name: 'choice', options: [-1, 1, '1', true, false], defaultValue: false },
        { name: 'label', defaultValue: null },
        { name: 'count', defaultValue: -2 },
      ]);
    } finally { parser.dispose(); }
  });

  it('analyzes a batch against one snapshot and invalidates imported types between revisions', () => {
    const parser = new AdvancedPropParser();
    const files = {
      'types.ts': { content: 'export type Props = { label: string };' },
      'First.tsx': { content: 'import type { Props } from "./types"; export function First(p: Props) { return null; }' },
      'Second.tsx': { content: 'import type { Props } from "./types"; export function Second(p: Props) { return null; }' },
    };
    const targets = [{ fileName: 'First.tsx', exportName: 'First' }, { fileName: 'Second.tsx', exportName: 'Second' }];
    const first = parser.parseMany(targets, files);
    expect(first.map(props => props.map(prop => prop.name))).toEqual([['label'], ['label']]);
    first[0][0].name = 'mutation';
    expect(first[1][0].name).toBe('label');
    files['types.ts'].content = 'export type Props = { count: number };';
    expect(parser.parseMany(targets, files).map(props => props.map(prop => prop.name))).toEqual([['count'], ['count']]);
    const { 'types.ts': removed, ...deleted } = files;
    expect(parser.parseMany(targets, deleted)).toEqual([[], []]);
    expect(parser.parseMany(targets, files).map(props => props.map(prop => prop.name))).toEqual([['count'], ['count']]);
    parser.dispose();
  });

  it('captures batch inputs before invoking host diagnostics', () => {
    const files = { 'First.tsx': { content: 'export function First(p: { label: string }) { return null; }' } };
    const targets = [{ fileName: 'Missing.tsx', exportName: 'Missing' }, { fileName: 'First.tsx', exportName: 'First' }];
    const parser = new AdvancedPropParser({ onDiagnostic: () => {
      targets[1].exportName = 'Missing';
      files['First.tsx'].content = 'export function First(p: { changed: string }) { return null; }';
    } });
    expect(parser.parseMany(targets, files).map(props => props.map(prop => prop.name))).toEqual([[], ['label']]);
  });

  it('selects named, default and reexported component metadata without borrowing a neighbor schema', () => {
    const parser = new AdvancedPropParser();
    const files = {
      'Multiple.tsx': { content: `
        export function First({label='first'}:{label?:string}) { return null; }
        export function Second({count=7}:{count?:number}) { return null; }
        export default function Empty() { return null; }
      ` },
      'index.ts': { content: 'export { Second as Renamed } from "./Multiple";' },
    };
    expect(parser.parse('Multiple.tsx', files, 'react', 'First')).toMatchObject([{ name: 'label', defaultValue: 'first' }]);
    expect(parser.parse('Multiple.tsx', files, 'react', 'Second')).toMatchObject([{ name: 'count', defaultValue: 7 }]);
    expect(parser.parse('index.ts', files, 'react', 'Renamed')).toMatchObject([{ name: 'count', defaultValue: 7 }]);
    expect(parser.parse('Multiple.tsx', files, 'react', 'default')).toEqual([]);
    expect(parser.parse('Multiple.tsx', files, 'react', 'Missing')).toEqual([]);
  });

  it('uses snapshot types without loading omitted files or tsconfig from the host filesystem', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'uf-prop-analysis-'));
    roots.push(root);
    await writeFile(path.join(root, 'types.ts'), 'export type Props = { secretFromDisk: string };');
    await writeFile(path.join(root, 'tsconfig.json'), '{invalid');
    const parser = new AdvancedPropParser({ root });
    const component = { content: 'import type {Props} from "./types"; export function Sample(props: Props) { return null; }' };
    const props = parser.parse('Sample.tsx', {
      'Sample.tsx': component,
      'types.ts': { content: 'export type Props = { captured: string };' },
    }, 'react', 'Sample');
    expect(props.map(prop => prop.name)).toEqual(['captured']);
    const afterDeletion = parser.parse('Sample.tsx', { 'Sample.tsx': component }, 'react', 'Sample');
    expect(afterDeletion).toEqual([]);
  });

  it('isolates returned metadata, caches and independent instances', () => {
    const first = new AdvancedPropParser();
    const second = new AdvancedPropParser();
    const files = { 'Sample.tsx': { content: 'export function Sample({tone}: {tone: "light" | "dark"}) { return null; }' } };
    const props = first.parse('Sample.tsx', files, 'react', 'Sample');
    props[0].name = 'corrupted';
    props[0].options?.push('foreign');
    const expected = [{ name: 'tone', options: ['light', 'dark'] }];
    expect(first.parse('Sample.tsx', files, 'react', 'Sample')).toMatchObject(expected);
    expect(second.parse('Sample.tsx', files, 'react', 'Sample')).toMatchObject(expected);
    first.dispose();
    expect(second.parse('Sample.tsx', files, 'react', 'Sample')).toMatchObject(expected);
  });

  it('does not evaluate top-level code and reports missing input through the instance observer', () => {
    const diagnostics: string[] = [];
    const parser = new AdvancedPropParser({ onDiagnostic: value => { diagnostics.push(value.reason); throw new Error('observer'); } });
    expect(parser.parse('Sample.tsx', {
      'Sample.tsx': { content: 'throw new Error("must not execute"); export function Sample({id}:{id:string}) { return null; }' },
    }, 'react', 'Sample').map(prop => prop.name)).toEqual(['id']);
    expect(parser.parse('Missing.tsx', {}, 'react', 'default')).toEqual([]);
    expect(diagnostics).toContain('advancedPropParser.parse');
  });
});

it('resolves imported props through instance-owned paths without reading the filesystem', () => {
  const paths = { '@model': ['types.ts'] };
  const parser = new AdvancedPropParser({ root: '/preview', paths });
  paths['@model'][0] = 'wrong.ts';
  try {
    const result = parser.parse('Button.tsx', {
      'Button.tsx': { content: 'import type { Props } from "@model"; export default function Button(props: Props){return null}' },
      'types.ts': { content: 'export interface Props { tone: "warm" | "cold"; count?: number }' },
      'wrong.ts': { content: 'export interface Props { unrelated: boolean }' },
    });
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tone', required: true, options: ['warm', 'cold'] }),
      expect.objectContaining({ name: 'count', type: 'number' }),
    ]));
    expect(result.some(prop => prop.name === 'unrelated')).toBe(false);
  } finally { parser.dispose(); }
});

it('unwraps an explicitly selected default forwardRef export and keeps the same props as its named export', () => {
  const parser = new AdvancedPropParser({ root: '/preview' });
  const files = { 'Text.tsx': { content: `
    import React from 'react';
    export interface TextProps { children?: string; tone?: 'warm' | 'cold'; }
    export const Text = React.forwardRef<HTMLElement, TextProps>(function Text(props, ref) { return null; });
    export default Text;
  ` } };
  try {
    const defaults = parser.parseResult({ fileName: 'Text.tsx', exportName: 'default', format: 'source' }, files);
    const named = parser.parseResult({ fileName: 'Text.tsx', exportName: 'Text', format: 'source' }, files);
    expect(defaults).toMatchObject({ ok: true, props: [
      expect.objectContaining({ name: 'children', type: 'string', required: false }),
      expect.objectContaining({ name: 'tone', options: ['warm', 'cold'], required: false }),
    ] });
    expect(defaults).toEqual(named);
  } finally { parser.dispose(); }
});

it('keeps installed component props through utility/intersection/generic types while filtering React intrinsic noise', () => {
  const parser = new AdvancedPropParser({ root: '/preview', paths: {
    '@vendor/control': ['/preview/node_modules/@vendor/control/index.d.ts'],
    'react': ['/preview/node_modules/@types/react/index.d.ts'],
  } });
  try {
    const result = parser.parseResult({ fileName: 'Control.tsx', exportName: 'default', format: 'source' }, {
      'Control.tsx': { content: `
        import type { ControlProps } from '@vendor/control';
        type Props = Omit<ControlProps<'warm' | 'cool'>, 'hidden'> & { own?: number };
        export default function Control(props: Props) { return null; }
      ` },
      'node_modules/@vendor/control/index.d.ts': { content: `
        import type { HTMLAttributes } from 'react';
        export interface ControlProps<T> extends HTMLAttributes { tone: T; hidden: boolean; caption: string }
      ` },
      'node_modules/@types/react/index.d.ts': { content: `
        export interface HTMLAttributes { children?: string; onAuxClick?: () => void; className?: string }
      ` },
    });
    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.props).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tone', required: true, options: ['warm', 'cool'] }),
      expect.objectContaining({ name: 'caption', required: true, type: 'string' }),
      expect.objectContaining({ name: 'own', required: false, type: 'number' }),
      expect.objectContaining({ name: 'children', isInherited: true }),
    ]));
    expect(result.props.find(prop => prop.name === 'caption')?.isInherited).toBeUndefined();
    expect(result.props.some(prop => prop.name === 'hidden' || prop.name === 'onAuxClick')).toBe(false);
  } finally { parser.dispose(); }
});

it('resolves captured modern package exports per importer and forgets deleted package manifests', () => {
  const parser = new AdvancedPropParser({ root: '/preview' });
  const files = {
    'Control.tsx': { content: `import type { Outer } from '@vendor/control'; export function Control(p:Outer){return null}` },
    'node_modules/@vendor/control/package.json': { content: JSON.stringify({ name: '@vendor/control', exports: { '.': { types: './entry.d.ts' } } }) },
    'node_modules/@vendor/control/entry.d.ts': { content: `import type { Inner } from '@vendor/value'; export interface Outer { outer: 'root'; nested: Inner }` },
    'node_modules/@vendor/value/package.json': { content: JSON.stringify({ name: '@vendor/value', exports: { '.': { types: './entry.d.ts' } } }) },
    'node_modules/@vendor/value/entry.d.ts': { content: `export type Inner = 'wrong-root'` },
    'node_modules/@vendor/control/node_modules/@vendor/value/package.json': { content: JSON.stringify({ name: '@vendor/value', exports: { '.': { types: './entry.d.ts' } } }) },
    'node_modules/@vendor/control/node_modules/@vendor/value/entry.d.ts': { content: `export type Inner = 'correct-nested'` },
  };
  try {
    const result = parser.parseResult({ fileName: 'Control.tsx', exportName: 'Control', format: 'source' }, files);
    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    expect(result.ok && result.props).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'nested', type: '"correct-nested"' }),
    ]));
    const withoutManifest = { ...files };
    delete (withoutManifest as Partial<typeof files>)['node_modules/@vendor/control/package.json'];
    expect(parser.parseResult({ fileName: 'Control.tsx', exportName: 'Control', format: 'source' }, withoutManifest)).toMatchObject({ ok: false });
  } finally { parser.dispose(); }
});

it('analyzes a selected export-star component without treating a type-only star export as a runtime value', () => {
  const parser = new AdvancedPropParser({ root: '/preview' });
  try {
    const files = {
      'index.ts': { content: 'export * from "./Control"; export type * from "./types";' },
      'Control.tsx': { content: 'export function Control({caption="Source"}:{caption?:string}){return null}' },
      'types.ts': { content: 'export interface TypeOnly { forbidden: string }' },
    };
    expect(parser.parseResult({ fileName: 'index.ts', exportName: 'Control', format: 'source' }, files)).toMatchObject({
      ok: true, props: [expect.objectContaining({ name: 'caption', type: 'string' })], diagnostics: [],
    });
    expect(parser.parseResult({ fileName: 'index.ts', exportName: 'TypeOnly', format: 'source' }, files)).toMatchObject({ ok: false });
  } finally { parser.dispose(); }
});

it('does not let one parser instance borrow another instance path mappings', () => {
  const vfs = {
    'Button.tsx': { content: 'import type { Props } from "@model"; export default function Button(props: Props){return null}' },
    'first.ts': { content: 'export interface Props { first: string }' },
    'second.ts': { content: 'export interface Props { second: boolean }' },
  };
  const first = new AdvancedPropParser({ paths: { '@model': ['first.ts'] } });
  const second = new AdvancedPropParser({ paths: { '@model': ['second.ts'] } });
  try {
    expect(first.parse('Button.tsx', vfs).map(prop => prop.name)).toEqual(['first']);
    expect(second.parse('Button.tsx', vfs).map(prop => prop.name)).toEqual(['second']);
    expect(first.parse('Button.tsx', vfs).map(prop => prop.name)).toEqual(['first']);
  } finally { first.dispose(); second.dispose(); }
});

it('does not turn the snapshot root into an implicit baseUrl when only paths are supplied', () => {
  const parser = new AdvancedPropParser({ root: '/preview', paths: {} });
  try {
    expect(parser.parse('Button.tsx', {
      'Button.tsx': { content: 'import type { Props } from "types"; export default function Button(props: Props){return null}' },
      'types.ts': { content: 'export interface Props { unrelated: boolean }' },
    })).toEqual([]);
  } finally { parser.dispose(); }
});
