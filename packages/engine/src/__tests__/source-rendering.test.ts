import { describe, expect, it } from 'vitest';
import * as React from 'react';
import * as ReactDOMServer from 'react-dom/server';
import { runInNewContext } from 'node:vm';
import { createEngine } from '../createEngine';
import { transpileVfsToIIFE } from '../transpiler';

const engine = () => createEngine({ React, ReactDOMServer });
const htmlOf = (result: Awaited<ReturnType<ReturnType<typeof engine>['renderFromSpec']>>) => (result.data as { html?: string }).html || '';

describe('selected Source SSR', () => {
  it('compiles a captured CSS Module import with its matching CSS and local asset', async () => {
    const result = await transpileVfsToIIFE({
      entryPath: 'src/Counter.tsx', framework: 'react', exportName: 'default',
      files: [
        { name: 'src/Counter.tsx', content: 'import styles from "./Counter.module.css"; export default function Counter(){return <button className={styles.button}>Counter</button>}' },
        { name: 'src/Counter.module.css', content: '.button { color: rgb(210, 10, 20); background-image: url("./dot.svg"); }' },
        { name: 'src/dot.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>' },
      ],
    });
    const className = /\.([A-Za-z0-9_-]+)\s*\{/.exec(result.styles)?.[1];
    expect(className).toBeTruthy();
    expect(result.cleanCode).toContain(className);
    expect(result.styles).toContain('rgb(210, 10, 20)');
    expect(result.styles).toContain('data:image/svg+xml');
  });

  it.each(['js', 'jsx', 'mjs'])('preserves JSX in a React .%s source entry', async (extension) => {
    const runtime = engine();
    const entryPath = `Source.${extension}`;
    const spec = await runtime.analyzeComponent([{ name: entryPath, content: 'export default function Source(){return <b>JavaScript JSX</b>}' }],
      { entryPath, exportName: 'default' });
    expect(htmlOf(await runtime.renderFromSpec(spec.name, {}, 'ssr'))).toContain('<b>JavaScript JSX</b>');
  });
  it.each([undefined, 'Selected'])('prepares live export %s without executing browser-only source on the server', async (exportName) => {
    const runtime = createEngine();
    const files = [{ name: 'Browser.tsx', content: `
      const title = document.title;
      export default function Legacy() { return <b>{title}:legacy</b>; }
      export function Selected() { return <b>{title}:selected</b>; }
    ` }];
    const spec = await runtime.analyzeComponent(files, { entryPath: 'Browser.tsx', exportName });
    const result = await runtime.renderFromSpec(spec.name, {}, 'live');
    expect(result.type).toBe('react-component');
    expect(result.data.files).toEqual(files);
    const Component = runInNewContext(result.data.componentCode, { React, document: { title: 'browser' } });
    expect(ReactDOMServer.renderToStaticMarkup(React.createElement(Component))).toBe(
      `<b>browser:${exportName ? 'selected' : 'legacy'}</b>`,
    );
  });

  it('keeps the existing default-export API working without an export option', async () => {
    const runtime = engine();
    const spec = await runtime.analyzeComponent([{ name: 'Legacy.tsx', content: 'export default function Legacy(){return <em>legacy default</em>}' }], { entryPath: 'Legacy.tsx' });
    expect(spec.name).toBe('Legacy');
    expect(htmlOf(await runtime.renderFromSpec(spec.name, {}, 'ssr'))).toContain('<em>legacy default</em>');
  });
  it('keeps named and default exports, props and captured inputs independent', async () => {
    const runtime = engine();
    const files = [{ name: 'src/Multiple.tsx', content: `
      export default function Default({ label = 'default-source' }: { label?: string }) { return <h1>{label}</h1>; }
      export function Named({ count = 7 }: { count?: number }) { return <p>named:{count}</p>; }
    ` }];
    const selected = await runtime.analyzeComponent(files, { entryPath: 'src/Multiple.tsx', exportName: 'Named' });
    files[0].content = 'export default function Default(){return <h1>new default</h1>}';
    const other = await runtime.analyzeComponent(files, { entryPath: 'src/Multiple.tsx', exportName: 'default' });
    expect(selected.name).not.toBe(other.name);
    expect(selected.props.map((prop: { name: string }) => prop.name)).toEqual(['count']);
    const selectedHtml = htmlOf(await runtime.renderFromSpec(selected.name, { count: 23 }, 'ssr'));
    expect(selectedHtml).toContain('<p>named:23</p>');
    expect(selectedHtml).not.toContain('<script');
    expect(selectedHtml).not.toContain('default-source');
    expect(htmlOf(await runtime.renderFromSpec(other.name, {}, 'ssr'))).toContain('<h1>new default</h1>');
  });

  it('renders a selected reexport from the same VFS without losing dependencies', async () => {
    const runtime = engine();
    const files = [
      { name: 'library/index.ts', content: "export { Item as Selected } from './Item'; export default function Other(){return null;}" },
      { name: 'library/Item.tsx', content: "import { text } from './text.js'; export function Item({label = text}: {label?: string}){return <article>{label}</article>}" },
      { name: 'library/text.ts', content: "export const text = 'captured dependency';" },
    ];
    const spec = await runtime.analyzeComponent(files, { entryPath: 'library/index.ts', exportName: 'Selected' });
    expect(spec.props.map((prop: { name: string }) => prop.name)).toEqual(['label']);
    expect(htmlOf(await runtime.renderFromSpec(spec.name, {}, 'ssr'))).toContain('<article>captured dependency</article>');
  });

  it.each(['Memo', 'Forward'])('renders %s using the injected React runtime without installing globals', async (exportName) => {
    const before = (globalThis as { React?: unknown }).React;
    const runtime = engine();
    const spec = await runtime.analyzeComponent([{ name: 'Wrappers.tsx', content: `
      import React from 'react';
      export const Memo = React.memo(({label = 'memo'}) => <b>{label}</b>);
      export const Forward = React.forwardRef(({label = 'forward'}, ref) => <i ref={ref}>{label}</i>);
    ` }], { entryPath: 'Wrappers.tsx', exportName });
    expect(htmlOf(await runtime.renderFromSpec(spec.name, { label: exportName }, 'ssr'))).toContain(`>${exportName}</`);
    expect((globalThis as { React?: unknown }).React).toBe(before);
  });

  it('keeps a successful null component distinct from a failed render', async () => {
    const runtime = engine();
    const spec = await runtime.analyzeComponent([{ name: 'Empty.tsx', content: 'export default function Empty(){return null}' }], { entryPath: 'Empty.tsx', exportName: 'default' });
    expect(htmlOf(await runtime.renderFromSpec(spec.name, {}, 'ssr'))).toContain('<div id="app"></div>');
  });

  it.each([
    'async function Selected() { throw new Error("must not execute async SSR"); }',
    'React.memo(async function Selected() { throw new Error("must not execute async SSR"); })',
    'React.forwardRef(async function Selected(props, ref) { throw new Error("must not execute async SSR"); })',
  ])('reports an asynchronous root before React can create an unhandled rejection: %s', async (component) => {
    const runtime = engine();
    const spec = await runtime.analyzeComponent([{ name: 'Async.tsx', content: `import React from 'react'; export default ${component};` }],
      { entryPath: 'Async.tsx', exportName: 'default' });
    await expect(runtime.renderFromSpec(spec.name, {}, 'ssr')).rejects.toMatchObject({
      code: 'UF400', message: expect.stringContaining('asynchronous SSR renderer'),
    });
    expect((await runtime.renderFromSpec(spec.name, {}, 'live')).data.componentCode).toContain('must not execute async SSR');
  });

  it.each([
    ['missing export', 'export default function Other(){return <b>wrong component</b>}', 'Selected', 'Selected'],
    ['missing import', "import { text } from './missing'; export function Selected(){return <b>{text}</b>}", 'Selected', 'missing'],
    ['component error', "export function Selected(){throw new Error('component exploded')}", 'Selected', 'component exploded'],
  ])('reports %s instead of returning an empty success or another export', async (_label, content, exportName, message) => {
    const runtime = engine();
    const spec = await runtime.analyzeComponent([{ name: 'Failure.tsx', content }], { entryPath: 'Failure.tsx', exportName });
    await expect(runtime.renderFromSpec(spec.name, {}, 'ssr')).rejects.toMatchObject({ code: 'UF400', message: expect.stringContaining(message) });
  });

  it('does not map an unknown spec to a successful empty result', async () => {
    await expect(engine().renderFromSpec('missing', {}, 'ssr')).rejects.toMatchObject({ code: 'UF400', message: expect.stringContaining('missing') });
  });
});
