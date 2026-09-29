import { describe, expect, it } from 'vitest';
import { discoverSourceComponentExports, orderSourceComponentExports } from '../source/index.js';

const names = async (source: string, path = '/src/button.tsx') => orderSourceComponentExports(
  await discoverSourceComponentExports(source, path), 'button',
).map((entry) => entry.exportName);

describe('source component exports', () => {
  it('selects the component in a lowercase module containing cva utilities and type exports', async () => {
    expect(await names(`import { cva } from 'class-variance-authority';
      export const buttonVariants = cva('button'); export const Example = 'constant';
      export type ButtonProps = {label: string}; export const Button = () => <button />;
      export function useButton() { return null; }`)).toEqual(['Button']);
  });

  it('recognizes every visual export, namespace JSX, custom tags, text and wrappers', async () => {
    expect(await names(`
      export function Compound() { return <Dialog.Root><Dialog.Trigger /></Dialog.Root>; }
      export const Input = React.forwardRef((props, ref) => <input {...props} ref={ref}/>);
      export const Label = () => 'text'; export const Text = props => props.value;
      export const Custom = () => <my-element />;
      export const Styled = styled.button\`color: red\`;
      export const Memo = React.memo(() => <p/>);
      export const Lazy = React.lazy(() => import('./Card'));
      export class ClassView extends React.Component { render() { return <div/>; } }
    `)).toEqual(['Compound', 'Input', 'Label', 'Text', 'Custom', 'Styled', 'Memo', 'Lazy', 'ClassView']);
  });

  it('resolves source reexports and export stars without executing a module, including cycles', async () => {
    const modules: Record<string, string> = {
      '/src/card.tsx': `export function Card() { return <article/>; } export const constant = 1;`,
      '/src/barrel.ts': `export * from './card'; export * from './index';`,
      '/src/index.ts': `export { Card as Renamed } from './card'; export * from './barrel';`,
    };
    const read = async (specifier: string) => {
      const path = Object.keys(modules).find((key) => key.replace(/\.tsx?$/, '') === '/src/' + specifier.slice(2));
      return path ? { path, source: modules[path] } : null;
    };
    const exports = await discoverSourceComponentExports(modules['/src/index.ts'], '/src/index.ts', read);
    expect(exports.map((entry) => entry.exportName)).toEqual(['Renamed', 'Card']);
    expect(orderSourceComponentExports(exports, 'index')).toHaveLength(1);
  });

  it('keeps a default/named alias as one component and respects explicit public aliases', async () => {
    expect(await names(`const Button = () => <button/>; export { Button, Button as default };`)).toEqual(['default']);
    expect(await names(`const Internal = () => <button/>; export { Internal as Button };`)).toEqual(['Button']);
  });

  it('does not confuse types, comments, string literals or TS generics with components', async () => {
    expect(await names(`// export default function Fake(){ return <div/> }
      export const source = "<button/>"; export type Props<T> = {value: T};
      export function identity<T>(value: T) { return value; }
      export const machine = createMachine({ states: { open: {} } });`, '/src/runtime.ts')).toEqual([]);
  });

  it('recognizes renderable defaults and aliases regardless of their private local name', async () => {
    expect(await names('const view=()=>null; export default view;')).toEqual(['default']);
    expect(await names('const text=()=>"hello"; export {text as Label};')).toEqual(['Label']);
    expect(await names('export const Hidden=()=>false;')).toEqual(['Hidden']);
    expect(await names('export default async function Page(){return await Promise.resolve(<main/>)}')).toEqual(['default']);
  });

  it('respects ESM star ambiguity and explicit non-component shadowing', async () => {
    const modules = {
      './a': 'export function Button(){return <button>A</button>}',
      './b': 'export function Button(){return <button>B</button>}',
      './constant': 'export const Button = 2;',
    };
    const read = async (name: string) => name in modules ? {path:name,source:modules[name as keyof typeof modules]} : null;
    expect(await discoverSourceComponentExports('export * from "./a"; export * from "./b";', '/index.ts', read)).toEqual([]);
    expect(await discoverSourceComponentExports('export * from "./a"; export * from "./constant";', '/index.ts', read)).toEqual([]);
    expect(await discoverSourceComponentExports('export const Button=2; export * from "./a";', '/index.ts', read)).toEqual([]);
    const explicit = await discoverSourceComponentExports('export * from "./a"; export * from "./b"; export {Button} from "./a";', '/index.ts', read);
    expect(explicit.map(entry=>entry.exportName)).toEqual(['Button']);
  });

  it('discovers Vue and Svelte compositions without native HTML tags', async () => {
    expect(await names('<template><Other /></template>', '/src/Card.vue')).toEqual(['default']);
    expect(await names('<script>import Other from "./Other.svelte";</script><Other />', '/src/Card.svelte')).toEqual(['default']);
  });
});
