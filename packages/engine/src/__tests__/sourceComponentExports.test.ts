import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { discoverSourceComponentExports, orderSourceComponentExports } from '../source/index.js';

const names = async (source: string, path = '/src/button.tsx') => orderSourceComponentExports(
  await discoverSourceComponentExports(source, path), 'button',
).map((entry) => entry.exportName);

describe('source component exports', () => {
  it('keeps primitive helper results out of component types without rejecting named text components', async () => {
    expect(await names(`
      import {DEFAULT_SIZE} from '@vendor/unknown';
      type Scalar = number;
      function positiveSetting(name:string, fallback:number): Scalar {
        const value = Number(process.env[name]); return Number.isFinite(value) ? value : fallback;
      }
      export const SETTINGS_LIMIT = positiveSetting('SIZE', 100);
      export function loadSize(): number { return DEFAULT_SIZE; }
      export function SizeLabel(): number { return DEFAULT_SIZE; }
      export function TextLabel(): string { return 'valid React child'; }
      export function getWidget() { return <span/>; }
    `)).toEqual(['SizeLabel', 'TextLabel', 'getWidget']);
  });
  it('does not infer a rendering helper from the spelling of an unresolved imported data value', async () => {
    expect(await names(`
      import {DEFAULT_ORIGIN, RemoteComponent} from '@vendor/unknown';
      export function resolveOrigin(input:{fallback?:string}) { return input.fallback || DEFAULT_ORIGIN; }
      export const Alias = RemoteComponent;
      export function TextWidget() { return DEFAULT_ORIGIN; }
      export function getWidget() { return <button/>; }
    `)).toEqual(['Alias', 'TextWidget', 'getWidget']);
  });
  it('does not treat request arguments or render callbacks as evidence of a called result', async () => {
    expect(await names(`
      import {dispatch} from './dispatcher';
      export default async function handler(req, res) { return dispatch(req, res); }
      export const Request = (req, res) => dispatch(req, res);
      export const CallbackData = props => serialize(() => <span>{props.label}</span>);
      export const RenderData = props => makeRecord(props.children);
      export function LocalDispatch(req, res) {
        const forward = (request, response) => response;
        return forward(req, res);
      }
    `, '/pages/api/[[...slug]].tsx')).toEqual([]);
  });

  it('follows proven local helper return values instead of their input arguments', async () => {
    expect(await names(`
      const renderLabel = props => <span>{props.label}</span>;
      const alias = renderLabel;
      function renderContent(props) { return renderLabel(props); }
      const wrapData = callback => ({callback});
      const returnInput = value => value;
      function recursive(props) { return recursive(props); }
      export const Helper = props => renderLabel(props);
      export const Alias = props => (0, alias)(props);
      export const NestedHelper = props => { function renderLocal() { return <button/>; } return renderLocal(); };
      export const Chained = props => renderContent(props);
      export const Data = props => wrapData(() => <span/>);
      export const UnknownInput = props => returnInput(props);
      export const Cyclic = props => recursive(props);
      export const Text = () => 'ready';
      export const Empty = () => null;
      export const Children = props => props.children;
    `)).toEqual(['Helper', 'Alias', 'NestedHelper', 'Chained', 'Text', 'Empty', 'Children']);
  });

  it('only unwraps the result argument of the unshadowed host Promise.resolve', async () => {
    expect(await names(`
      export const AsyncView = async () => await Promise.resolve(<span/>);
      export const IgnoredArgument = props => Promise.resolve({}, props.children);
      export function ShadowedPromise(Promise) { return Promise.resolve(<span/>); }
      export function LocalPromise() { const Promise = {resolve: value => ({value})}; return Promise.resolve(<span/>); }
    `)).toEqual(['AsyncView']);
  });

  it('resolves explicit local compound members without promoting their data or React node values to component types', async () => {
    expect(await names(`
      const Button = props => <button>{props.children}</button>;
      const registry = { Button, theme: {dark: '#111'}, Node: <span/>, render() { return <article/>; } };
      const alias = registry;
      export const Dark = registry.theme.dark;
      export const ElementValue = registry.Node;
      export const Compound = registry.Button;
      export const LiteralCompound = alias['Button'];
      export const MethodCompound = registry.render;
      export const HelperView = props => registry.render(props);
      export const ElementView = () => registry.Node;
      export const TextView = () => registry.theme.dark;
    `)).toEqual(['Compound', 'LiteralCompound', 'MethodCompound', 'HelperView', 'ElementView', 'TextView']);
  });

  it('uses known namespace member exports while preserving unresolved package compound components', async () => {
    const read = async (specifier: string) => specifier === './widgets' ? {
      path: '/src/widgets.tsx', source: `export const Label = 'ready'; export const Node = <span/>;
        export function Button(props) { return <button>{props.children}</button>; }`,
    } : null;
    const entries = await discoverSourceComponentExports(`
      import * as widgets from './widgets';
      import * as external from '@vendor/ui';
      const alias = widgets;
      export const Compound = alias.Button;
      export const DataAlias = widgets.Label;
      export const NodeAlias = widgets.Node;
      export const MissingAlias = widgets.Absent;
      export const TextView = () => widgets.Label;
      export const NodeView = () => widgets.Node;
      export const UnknownCompound = external.Button;
    `, '/src/aliases.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['Compound', 'TextView', 'NodeView', 'UnknownCompound']);
  });

  it('requires a type-selecting binary operator rather than treating arithmetic and comparisons as component aliases', async () => {
    expect(await names(`
      import {LIMIT} from '@vendor/config';
      const Button = props => <button/>;
      export const MaxBytes = LIMIT - 4096;
      export const Added = Button + 1;
      export const Compared = Button === undefined;
      export const CommaData = (Button, 12);
      export const Fallback = maybeButton || Button;
      export const Conditional = enabled && Button;
      export const Nullish = maybeButton ?? Button;
      export const CommaAlias = (0, Button);
    `)).toEqual(['Fallback', 'Conditional', 'Nullish', 'CommaAlias']);
  });

  it('separates known array-map results from component types while allowing components to render mapped nodes', async () => {
    expect(await names(`
      const catalog = [{property: 'width'}, {property: 'height'}] as const;
      const alias = catalog;
      const renderRow = row => <span>{row.property}</span>;
      export const Properties = catalog.map(entry => entry.property);
      export const NodeValues = alias.map(renderRow);
      export const List = () => catalog.map(renderRow);
      export const InlineList = () => alias.flatMap(row => [<span/>, null]);
      export const TextList = () => catalog.map(row => 'ready');
    `)).toEqual(['List', 'InlineList', 'TextList']);
  });

  it('preserves mapped JSX from typed, destructured, aliased and ordinary unannotated props collections', async () => {
    expect(await names(`
      interface Props { items: readonly {label: string}[]; }
      type AliasProps = {rows: ReadonlyArray<{label: string}>};
      const renderRow = row => <li>{row.label}</li>;
      export const Typed = ({items}: Props) => items.map(renderRow);
      export const TypedMember = (props: Props) => props.items.flatMap(row => [<li/>, null]);
      export const Alias = ({rows: items}: AliasProps) => items.map(renderRow);
      export const LocalAlias = props => { const items = props.items; return items.map(row => <li/>); };
      export const Destructured = ({items}) => items.map(row => <li/>);
      export const Member = props => props.items.map(row => <li/>);
      export const LiteralMember = props => props['items'].map(row => <li/>);
      export const Unknown = (props: unknown) => props.items.map(row => <li/>);
      export const ImportedValues = () => importedItems.map(row => <li/>);
      export const MappedValue = importedItems.map(row => <li/>);
    `)).toEqual(['Typed', 'TypedMember', 'Alias', 'LocalAlias', 'Destructured', 'Member', 'LiteralMember', 'Unknown', 'ImportedValues']);
  });

  it('uses contrary local and props type facts instead of assuming every callback consumer named map is an array', async () => {
    expect(await names(`
      interface Props { items: {map: (callback: unknown) => object}; }
      const serialize = callback => ({callback});
      const object = {map: serialize};
      const helper = {map() { return <button/>; }};
      export const ObjectData = () => object.map(() => <span/>);
      export const TypedData = (props: Props) => props.items.map(() => <span/>);
      export const DestructuredData = ({items}: Props) => items.map(() => <span/>);
      export const PrimitiveData = ({items}: {items: string}) => items.map(() => <span/>);
      export const LocalPrimitive = () => { const items = 'ready'; return items.map(() => <span/>); };
      export const ActualHelper = () => helper.map();
      export const PrimitiveFormatter = (items: string) => items.split(',').map(row => <span/>);
      export class ServiceError extends Error { constructor(message: string) { super(message); } }
      export class Service { constructor(input: string) {} execute() { return <span/>; } }
      export class ClassView extends React.Component { constructor(props) { super(props); } render() { return <span/>; } }
    `)).toEqual(['ActualHelper', 'ClassView']);
  });

  it('requires React provenance for bound lazy factories while preserving aliases, namespaces, require and legacy globals', async () => {
    expect(await names(`
      import {lazy as loadComponent, memo as memoComponent, forwardRef as withRef} from 'react';
      import * as ReactRuntime from 'react';
      import {z} from 'schema-toolkit';
      import * as schemas from 'schema-toolkit';
      const {lazy: loadRequired} = require('react');
      const runtime = require('react');
      const fakeRuntime = require('schema-toolkit');
      export const Schema = z.lazy(() => z.object({name: z.string()}));
      export const SchemaNamespace = schemas.lazy(() => schemas.union([]));
      export const SchemaRequired = fakeRuntime.lazy(() => fakeRuntime.object({}));
      export const Component = loadComponent(() => import('./View'));
      export const Namespace = ReactRuntime.lazy(() => import('./View'));
      export const Required = loadRequired(() => import('./View'));
      export const CommaRequired = (0, runtime.lazy)(() => import('./View'));
      export const MemoAlias = memoComponent(props => <span/>);
      export const RefAlias = withRef((props, ref) => <input ref={ref}/>);
      export const Legacy = React.lazy(() => import('./View'));
      export const LegacyGlobal = lazy(() => import('./View'));
    `, '/src/lazy-factories.tsx')).toEqual(['Component', 'Namespace', 'Required', 'CommaRequired', 'MemoAlias', 'RefAlias', 'Legacy', 'LegacyGlobal']);
  });

  it('keeps JSON imports and their aliased members as data, including unresolved guarded module reads', async () => {
    expect(await names(`
      import registry from './component-registry.json';
      import Registry, {Widget} from './metadata.json';
      import * as namespace from './metadata.json';
      const typedRegistry = registry as Registry;
      const metadata = require('./metadata.json');
      export const ComponentsMeta = typedRegistry.components;
      export const NestedMeta = typedRegistry.components.Button;
      export const NamespaceMeta = namespace.Widget;
      export const RequiredMeta = metadata.components;
      export const DefaultMeta = Registry;
      export const NamedMeta = Widget;
      export {ExternalMetadata} from '@vendor/catalog.json';
      export const StringView = () => registry.label;
      export const Visible = () => <button/>;
    `)).toEqual(['StringView', 'Visible']);
  });

  it('does not infer component types from absent closed-literal members or members of arrays and primitives', async () => {
    expect(await names(`
      const object = {label: 'ready'};
      const array = ['ready'];
      const text = 'ready';
      const number = 3;
      export const Missing = object.Absent;
      export const MissingLiteral = object['Absent'];
      export const ArrayMethod = array.map;
      export const ArrayLength = array.length;
      export const StringMethod = text.toString;
      export const NumberMethod = number.toFixed;
      export const Visible = () => <span/>;
    `)).toEqual(['Visible']);
  });

  it('does not promote known local data-helper results because their arguments include component types', async () => {
    expect(await names(`
      function values(_input: unknown) { return []; }
      function Button() { return <button/>; }
      function record(_input: unknown) { return {Button}; }
      function label(_input: unknown) { return 'ready'; }
      function identity(input) { return input; }
      const data = {label: 'ready'};
      export const NOT_A_COMPONENT = values(Button);
      export const RecordResult = record(Button);
      export const LabelResult = label(Button);
      export const ForwardedData = identity(data);
      export const MissingValue = identity();
    `)).toEqual([]);
  });

  it('uses a local shadow lazy function result instead of granting it React wrapper semantics', async () => {
    expect(await names(`
      function lazy(_input) { return []; }
      export const NOT_A_COMPONENT = lazy(() => <button/>);
    `)).toEqual([]);
  });

  it('preserves known local HOCs that return a component function or forward a component', async () => {
    expect(await names(`
      function Button(props) { return <button>{props.children}</button>; }
      function withProviders(Component) {
        return function Wrapped(props) { return <Component {...props}/>; };
      }
      function forward(Component) { return Component; }
      const factory = () => (props: {label: string}) => <span>{props.label}</span>;
      export const Wrapped = withProviders(Button);
      export const Forwarded = forward(Button);
      export const Generated = factory();
    `)).toEqual(['Wrapped', 'Forwarded', 'Generated']);
  });

  it('recognizes named React factory aliases without treating their node values as component types', async () => {
    expect(await names(`
      import {jsx as renderOne, jsxs as renderMany} from 'react/jsx-runtime';
      import {jsxDEV as renderDevelopment} from 'react/jsx-dev-runtime';
      import {createElement as makeElement} from 'react';
      export function One(props){ return renderOne('button', {children: props.label}); }
      export const Many = props => renderMany('div', {children: [props.first, props.second]});
      export const Development = props => renderDevelopment('span', {children: props.label}, undefined, false);
      export const Classic = props => makeElement('p', null, props.label);
      export const ElementValue = renderOne('button', {});
      export const FactoryValue = makeElement;
      export function Cleanup(){ return makeElement; }
    `, '/src/compiled.js')).toEqual(['One', 'Many', 'Development', 'Classic']);
  });

  it('keeps direct React factory references separate from component types and rendered calls', async () => {
    expect(await names(`
      import React from 'react';
      import * as runtime from 'react/jsx-runtime';
      const development = require('react/jsx-dev-runtime');
      export const FactoryValue = React.createElement;
      export const NamespaceFactory = runtime.jsx;
      export const RequiredFactory = development.jsxDEV;
      export const ElementAccessFactory = runtime['jsxs'];
      export const CommaFactory = (0, runtime.jsx);
      export function ReturnedFactory(){ return React.createElement; }
      export function ReturnedNamespace(){ return runtime.jsx; }
      export function ReturnedRequire(){ return development.jsxDEV; }
      export function ReturnedComma(){ return (0, runtime.jsx); }
      export const Actual = () => React.createElement('span', null, 'ok');
      export const ActualNamespace = () => runtime.jsx('span', {children: 'ok'});
      export const ActualRequired = () => (0, development.jsxDEV)('span', {}, undefined, false);
    `, '/src/factory-references.js')).toEqual(['Actual', 'ActualNamespace', 'ActualRequired']);
  });

  it.each([
    ['esm automatic', ts.ModuleKind.ESNext, ts.JsxEmit.ReactJSX],
    ['esm development', ts.ModuleKind.ESNext, ts.JsxEmit.ReactJSXDev],
    ['cjs automatic', ts.ModuleKind.CommonJS, ts.JsxEmit.ReactJSX],
    ['cjs development', ts.ModuleKind.CommonJS, ts.JsxEmit.ReactJSXDev],
  ] as const)('recognizes actual TypeScript-emitted %s component factories', async (_name, module, jsx) => {
    const emitted = ts.transpileModule(`
      import {forwardRef} from 'react';
      export const ButtonGroup = forwardRef(function ButtonGroup(props, ref){
        return <div ref={ref}><span>{props.label}</span><button /></div>;
      });
      export const ElementValue = <button/>;
    `, { fileName: 'Button.tsx', compilerOptions: { module, jsx, target: ts.ScriptTarget.ES2020 } }).outputText;
    if (module === ts.ModuleKind.CommonJS) expect(emitted).toMatch(/\(0, jsx(?:_dev)?_runtime_1\.jsx/);
    else expect(emitted).toMatch(/import \{ jsx(?:DEV|s)? as _jsx/);
    expect(await names(emitted, '/dist/Button.js')).toEqual(['ButtonGroup']);
  });

  it('recognizes React namespace and literal require factories, including zero comma-call targets', async () => {
    expect(await names(`
      import * as runtime from 'react/jsx-runtime';
      import React from 'react';
      const development = require('react/jsx-dev-runtime');
      const {jsx: renderRequired, jsxs: renderRequiredMany} = require('react/jsx-runtime');
      const makeElement = require('react').createElement;
      export const Namespace = props => runtime.jsx('button', {children: props.label});
      export const DefaultReact = props => React.createElement('button', null, props.label);
      export const Required = props => (0, development.jsxDEV)('button', {}, undefined, false);
      export const Destructured = props => renderRequired('button', {children: props.label});
      export const DestructuredMany = props => renderRequiredMany('div', {children: [props.first, props.second]});
      export const RequiredClassic = props => (0, makeElement)('button', null, props.label);
    `, '/src/compiled.js')).toEqual(['Namespace', 'DefaultReact', 'Required', 'Destructured', 'DestructuredMany', 'RequiredClassic']);
  });

  it('does not grant React factory evidence to other modules, arbitrary names, or known local values', async () => {
    expect(await names(`
      import {jsx as _jsx, createElement} from './not-react';
      import * as runtime from './not-react';
      const React = require('./not-react');
      const object = {jsx: () => ({})};
      const jsx = () => ({});
      const madeUp = require('react/' + 'jsx-runtime');
      export const Alias = () => _jsx('button', {});
      export const Named = () => createElement('button', {});
      export const Namespace = () => runtime.jsx('button', {});
      export const ObjectValue = () => object.jsx('button', {});
      export const Local = () => jsx('button', {});
      export const WrongReact = () => React.createElement('button', {});
      export const Dynamic = () => (0, madeUp.jsx)('button', {});
    `, '/src/not-react.js')).toEqual([]);
  });

  it('respects lexical shadowing of proven React factory aliases and namespaces', async () => {
    expect(await names(`
      import {jsx as renderOne, jsx} from 'react/jsx-runtime';
      import * as runtime from 'react/jsx-runtime';
      export const Good = props => renderOne('button', {children: props.label});
      export function AliasParameter(renderOne){ return renderOne('button', {}); }
      export function NamedParameter(jsx){ return jsx('button', {}); }
      export function NamespaceParameter(runtime){ return runtime.jsx('button', {}); }
      export function LocalAlias(){ const renderOne = () => ({}); return renderOne('button', {}); }
      export function LocalNamespace(){ const runtime = {jsx: () => ({})}; return runtime.jsx('button', {}); }
      export function CatchAlias(){ try { throw null; } catch (renderOne) { return renderOne('button', {}); } }
      export function LoopNamespace(){ for (const runtime of []) { return runtime.jsx('button', {}); } }
      export const NamedFunction = function renderOne(){ return renderOne('button', {}); };
      export const NamedClass = class renderOne { render(){ return renderOne('button', {}); } };
    `, '/src/shadow.js')).toEqual(['Good']);
  });

  it.each([
    `import * as require from './local';`,
    `const {require} = custom;`,
  ])('does not mistake a known require binding for the host loader: %s', async declaration => {
    expect(await names(`${declaration}
      const runtime = require('react/jsx-runtime');
      export function Fake(){ return runtime.jsx('button', {}); }
    `, '/src/shadow-require.js')).toEqual([]);
  });

  it('uses known reader facts for imported and reexported data, including local aliases of the retained App values', async () => {
    const modules: Record<string, string> = {
      '@userface/playground': `export const PREVIEW_GLOBAL_NAME = 'UserfacePreviewBundle';
        export function Button(){ return <button/>; }`,
      './icons': `export const AGENT_STATUS_ANIMATION_NAMES = { running: 'running' };
        export const Icon = props => <svg/>;`,
    };
    const read = async (specifier: string) => specifier in modules ? { path: specifier + '.tsx', source: modules[specifier] } : null;
    const entries = await discoverSourceComponentExports(`
      import { AGENT_STATUS_ANIMATION_NAMES, Icon } from './icons';
      import { PREVIEW_GLOBAL_NAME, Button } from '@userface/playground';
      export { PREVIEW_GLOBAL_NAME as PublicName } from '@userface/playground';
      export const AGENT_STATUS_ICON_NAMES = AGENT_STATUS_ANIMATION_NAMES;
      const LOCAL_NAME = PREVIEW_GLOBAL_NAME; export { LOCAL_NAME as GlobalName };
      export const IconAlias = Icon;
      export const ButtonAlias = Button;
    `, '/src/public.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['IconAlias', 'ButtonAlias']);
  });

  it('does not treat a returned cleanup function as a rendered node, including the retained native layout listener', async () => {
    expect(await names(`
      import { USERFACE_DESKTOP_NATIVE_CONTROLS_LAYOUT_CHANGE_EVENT } from '@userface/desktop-contracts/channels';
      export function installDesktopNativeControlsLayoutSignal(target: Window, notify: () => void): () => void {
        if (target.top !== target) return () => {};
        const handleLayoutChange = (event: Event): void => {
          if (event.eventPhase === Event.AT_TARGET) notify();
        };
        target.addEventListener(USERFACE_DESKTOP_NATIVE_CONTROLS_LAYOUT_CHANGE_EVENT, handleLayoutChange);
        return () => target.removeEventListener(USERFACE_DESKTOP_NATIVE_CONTROLS_LAYOUT_CHANGE_EVENT, handleLayoutChange);
      }
      export const RenderFactory = () => () => <button/>;
      export function Cleanup(){ return function(){ return <div/>; }; }
      export function Visible(){ return <button/>; }
    `, '/src/layoutSignal.tsx')).toEqual(['Visible']);
  });

  it('keeps imported React node values inside components without exporting the values as component types', async () => {
    const read = async () => ({ path: '/src/values.tsx', source: `
      export const Label = 'Ready'; export const Count = 3; export const Empty = null;
      export const lowerText = 'lower'; export const hidden = false;
      export const Element = <button/>; export const Nodes = [<span/>, 'text', null];
      export const Data = { label: 'data' };
    ` });
    const entries = await discoverSourceComponentExports(`
      import {Label,Count,Empty,Element,Nodes,Data,lowerText,hidden} from './values';
      export const ValueAlias = Label; export const ElementAlias = Element;
      export const DataAlias = Data;
      export const TextView = () => Label;
      export const CountView = () => Count;
      export const EmptyView = () => Empty;
      export const ElementView = () => Element;
      export const ListView = () => Nodes;
      export const LowerTextView = () => lowerText;
      export const HiddenView = () => hidden;
    `, '/src/views.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['TextView', 'CountView', 'EmptyView', 'ElementView', 'ListView', 'LowerTextView', 'HiddenView']);
    expect(Object.keys(entries[0]).sort()).toEqual(['declarationId', 'exportName', 'localName']);
  });

  it('requires component type evidence for custom HOC arguments while preserving real imported and local wrappers', async () => {
    const read = async () => ({ path: '/src/shared.tsx', source: `
      export const Data = { value: true }; export const Element = <span/>;
      export const Shared = props => <span {...props}/>;
    ` });
    const entries = await discoverSourceComponentExports(`
      import {Data,Element,Shared} from './shared';
      const local = props => <span/>;
      export const ImportedWrapper = withProviders(Shared);
      export const LocalWrapper = withProviders(local);
      export const DataResult = identity(Data);
      export const ElementResult = identity(Element);
      export const MemoData = React.memo(Data);
      export const ForwardedElement = React.forwardRef(Element);
      export const Memo = React.memo(Shared);
      export const Forwarded = React.forwardRef((props, ref) => React.createElement('input', {ref}));
      export const Lazy = React.lazy(() => import('./View'));
      export const Styled = styled.div\`color: red\`;
      export class ClassView extends React.Component { render(){ return [<span/>, null]; } }
    `, '/src/wrapped.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['ImportedWrapper', 'LocalWrapper', 'Memo', 'Forwarded', 'Lazy', 'Styled', 'ClassView']);
  });

  it('retains unresolved external package candidates and terminates cyclic known data aliases', async () => {
    const modules: Record<string, string> = {
      './a': `import { Data as OtherData } from './b'; export const Data = OtherData;
        export function Card(){ return <article/>; }`,
      './b': `export { Data } from './a';`,
    };
    const read = async (specifier: string) => specifier in modules ? { path: specifier + '.tsx', source: modules[specifier] } : null;
    const entries = await discoverSourceComponentExports(`
      import {Data,Card} from './a';
      export const Alias = Data;
      export const Wrapped = withProviders(Card);
      export {ExternalButton} from '@vendor/ui';
    `, '/src/index.ts', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['Wrapped', 'ExternalButton']);
    expect(entries[1].declarationId).toBe('@vendor/ui:ExternalButton');
  });

  it('respects lexical cleanup aliases and props that shadow an imported data value', async () => {
    const read = async () => ({ path: '/src/data.ts', source: `export const Data = { value: true };` });
    const entries = await discoverSourceComponentExports(`
      import {Data} from './data';
      export function Cleanup(){ const cleanup = () => {}; return cleanup; }
      export function Nested(){ function cleanup(){ return <span/>; } return cleanup; }
      export function Actual(){ const node = <span/>; return node; }
      export function PropsValue({Data}: {Data: ReactNode}){ return Data; }
    `, '/src/local.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['Actual', 'PropsValue']);
  });

  it('resolves only referenced imported facts and shares the same module read across repeated aliases', async () => {
    const read = vi.fn(async (specifier: string) => specifier === './shared' ? {
      path: '/src/shared.tsx', source: `export const Data = { ready: true };
        export const text = 'Ready'; export function Button(){ return <button/>; }`,
    } : null);
    const aliases = Array.from({ length: 24 }, (_, index) => `export const Alias${index} = Data;`).join('\n');
    const entries = await discoverSourceComponentExports(`
      import {Data,text,Button} from './shared';
      import {Unused} from './unused';
      ${aliases}
      export const Wrapped = withProviders(Button);
      export const TextView = () => text;
    `, '/src/index.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['Wrapped', 'TextView']);
    expect(read.mock.calls).toEqual([['./shared', '/src/index.tsx']]);
  });

  it('analyzes a requested named barrel export without reading unrelated reexport dependencies', async () => {
    const modules: Record<string, string> = {
      './barrel': `export {Private as Button} from './button'; export {HugeData} from './huge'; export {Other} from './other';`,
      './button': `export const Private = props => <button>{props.children}</button>;`,
      './huge': `export const HugeData = costlyUnrelatedAnalysis();`,
      './other': `export const Other = () => <aside/>;`,
    };
    const read = vi.fn(async (specifier: string, _importer: string) => specifier in modules
      ? {path: specifier + '.tsx', source: modules[specifier]} : null);
    const entries = await discoverSourceComponentExports(`
      import {Button} from './barrel'; export const Wrapped = withProviders(Button);
      export {Button as Renamed} from './barrel';
    `, '/src/index.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['Wrapped', 'Renamed']);
    expect(read.mock.calls.map(call => call[0])).toEqual(['./barrel', './button']);
  });

  it('shares namespace source reads while demanding only the requested member facts', async () => {
    const modules: Record<string, string> = {
      './barrel': `export {Button} from './button'; export {Label} from './labels'; export {HugeData} from './huge';`,
      './button': `export const Button = () => <button/>;`,
      './labels': `export const Label = 'ready';`,
      './huge': `export const HugeData = data;`,
    };
    const read = vi.fn(async (specifier: string, _importer: string) => specifier in modules
      ? {path: specifier + '.tsx', source: modules[specifier]} : null);
    const entries = await discoverSourceComponentExports(`
      import * as widgets from './barrel';
      export const ButtonAlias = widgets.Button;
      export const LabelView = () => widgets.Label;
      export const LabelData = widgets.Label;
    `, '/src/index.tsx', read);
    expect(entries.map(entry => entry.exportName)).toEqual(['ButtonAlias', 'LabelView']);
    expect(read.mock.calls.map(call => call[0])).toEqual(['./barrel', './button', './labels']);
  });

  it('preserves demanded star ambiguity and skips star reads overridden by an explicit non-component export', async () => {
    const modules: Record<string, string> = {
      './ambiguous': `export * from './first'; export * from './second'; export {HugeData} from './huge';`,
      './shadow': `export const Button = 2; export * from './first'; export {HugeData} from './huge';`,
      './first': `export const Button = () => <button/>;`,
      './second': `export const Button = 2;`,
      './huge': `export const HugeData = data;`,
    };
    const read = vi.fn(async (specifier: string, _importer: string) => specifier in modules
      ? {path: specifier + '.tsx', source: modules[specifier]} : null);
    expect(await discoverSourceComponentExports(`export {Button} from './ambiguous';`, '/src/index.tsx', read)).toEqual([]);
    expect(read.mock.calls.map(call => call[0])).toEqual(['./ambiguous', './first', './second']);
    read.mockClear();
    expect(await discoverSourceComponentExports(`export {Button} from './shadow';`, '/src/index.tsx', read)).toEqual([]);
    expect(read.mock.calls.map(call => call[0])).toEqual(['./shadow']);
  });

  it('rejects exported data and element values while preserving those values inside components', async () => {
    expect(await names(`
      export const SUPPORTED_FONT_FORMATS = ["otf", "ttf"] as const;
      export const OPTIONS = { value: "one" };
      export const Node = <button />;
      export const Nodes = [<button />, "text", null];
      export const Element = React.createElement(Collection);
      export const JsxValue = jsx(Collection, {});
      const DataAlias = SUPPORTED_FONT_FORMATS; export { DataAlias };
      export const Collection = () => [<button />, "text", null];
      export function label() { return <span />; }
      export const Empty = () => null;
    `)).toEqual(['Collection', 'label', 'Empty']);
    expect(await names('import js from "@eslint/js"; export default [{ ignores: [] }, js.configs.recommended];',
      '/eslint.config.mjs')).toEqual([]);
    expect(await names('export default { element: <button /> };')).toEqual([]);
    expect(await names('export default <button />;')).toEqual([]);
  });

  it('distinguishes JSX formatters accepting primitives from props-based component APIs', async () => {
    expect(await names(`
      type Address = string;
      export function breakableAddress(address: string): ReactNode {
        return String(address).split(".").map(part => <span>{part}</span>);
      }
      export const FormatAmount = (amount: number) => <span>{amount}</span>;
      export const AliasFormatter = (address: Address | null) => <span>{address}</span>;
      export const UnionFormatter = (value: string | number | undefined) => <span>{value}</span>;
      export const ObjectView = (props: { address: string }) => <span>{props.address}</span>;
      export const MixedView = (props: { address: string } | string) => <span />;
      export const UnknownView = (props: unknown) => <span />;
      export function lowerCaseView(props: { label: string }) { return <span>{props.label}</span>; }
      const privateView = (props: { label: string }) => <span>{props.label}</span>;
      export { privateView as Label };
    `)).toEqual(['ObjectView', 'MixedView', 'UnknownView', 'lowerCaseView', 'Label']);
    expect(await names('const format = (value: string) => <span>{value}</span>; export default format;')).toEqual([]);
  });

  it('preserves component factories and wrappers after separating exported values from node returns', async () => {
    expect(await names(`
      const inner = (props: { label: string }) => <span>{props.label}</span>;
      export const Wrapped = withProviders(inner);
      export const Memoized = React.memo(inner);
      export const Forwarded = React.forwardRef((props: { label: string }, ref) => <input ref={ref} />);
      export const LazyView = React.lazy(() => import('./View'));
      export const StyledView = styled.div\`color: red\`;
      export class ClassView extends React.Component { render() { return [<span />, null]; } }
    `)).toEqual(['Wrapped', 'Memoized', 'Forwarded', 'LazyView', 'StyledView', 'ClassView']);
  });

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

  it('forwards one anchored opaque import binding through renamed, chained and star aliases', async () => {
    const modules: Record<string, string> = {
      '/workspace/Origin.ts': "import {Widget as Internal} from '@vendor/ui'; export {Internal as Widget, Internal as Alias, Internal as default};",
      '/workspace/Chain.ts': "export {Widget as Renamed} from './Origin'; export * from './Origin';",
      '/workspace/index.ts': "export * from './Chain';",
    };
    const read = async (specifier: string, importer: string) => {
      const resolved = path.posix.resolve(path.posix.dirname(importer), specifier) + '.ts';
      return modules[resolved] === undefined ? null : { path: resolved, source: modules[resolved] };
    };
    const expectedBinding = '/workspace/Origin.ts:import:["@vendor/ui","Widget"]';
    const origin = await discoverSourceComponentExports(modules['/workspace/Origin.ts'], '/workspace/Origin.ts', read);
    expect(origin.map(entry => entry.exportName)).toEqual(['Widget', 'Alias', 'default']);
    expect(origin.every(entry => entry.bindingId === expectedBinding && entry.declarationId === '@vendor/ui:Widget')).toBe(true);
    const aliases = await discoverSourceComponentExports(modules['/workspace/index.ts'], '/workspace/index.ts', read);
    expect(aliases.map(entry => entry.exportName)).toEqual(['Renamed', 'Widget', 'Alias']);
    expect(aliases.every(entry => entry.bindingId === expectedBinding)).toBe(true);
    expect(orderSourceComponentExports(aliases, 'index')).toHaveLength(1);
    const renamed = await discoverSourceComponentExports(modules['/workspace/Origin.ts'].replaceAll('Internal', 'OtherLocal'), '/workspace/Origin.ts', read);
    expect(renamed.map(entry => entry.bindingId)).toEqual(origin.map(entry => entry.bindingId));
  });

  it('does not collapse opaque imports from independent source origins or resolve their ambiguous stars', async () => {
    const source = "export {Widget} from '@vendor/ui';";
    const modules: Record<string, string> = { '/workspace/first/Origin.ts': source, '/workspace/second/Origin.ts': source };
    const read = async (specifier: string, importer: string) => {
      const resolved = path.posix.resolve(path.posix.dirname(importer), specifier) + '.ts';
      return modules[resolved] === undefined ? null : { path: resolved, source: modules[resolved] };
    };
    const aliases = await discoverSourceComponentExports("export {Widget as First} from './first/Origin'; export {Widget as Second} from './second/Origin';", '/workspace/index.ts', read);
    expect(aliases.map(entry => entry.declarationId)).toEqual(['@vendor/ui:Widget', '@vendor/ui:Widget']);
    expect(new Set(aliases.map(entry => entry.bindingId)).size).toBe(2);
    expect(orderSourceComponentExports(aliases, 'index').map(entry => entry.exportName)).toEqual(['First', 'Second']);
    expect(await discoverSourceComponentExports("export * from './first/Origin'; export * from './second/Origin';", '/workspace/index.ts', read)).toEqual([]);
    const explicit = await discoverSourceComponentExports("export * from './first/Origin'; export * from './second/Origin'; export {Widget} from './first/Origin';", '/workspace/index.ts', read);
    expect(explicit).toEqual([expect.objectContaining({ exportName: 'Widget', bindingId: aliases[0].bindingId })]);
  });

  it('keeps imported requests and exports distinct and does not change local value classification', async () => {
    const entries = await discoverSourceComponentExports(`
      export {Widget as First, Other as Second} from '@vendor/ui';
      export {Widget as Third} from '@other/ui';
      export function View(){return <article/>}
      export function Callback(){return () => null}
      export const Data = {label:'fixture'};
    `, '/workspace/Origin.tsx');
    expect(entries.map(entry => entry.exportName)).toEqual(['First', 'Second', 'Third', 'View']);
    expect(new Set(entries.filter(entry => entry.exportName !== 'View').map(entry => entry.bindingId)).size).toBe(3);
    expect(entries.find(entry => entry.exportName === 'View')).not.toHaveProperty('bindingId');
    const separate = await discoverSourceComponentExports("export {Widget} from '@vendor/ui';", '/workspace/Independent.ts');
    expect(separate[0].bindingId).not.toBe(entries[0].bindingId);
    expect(separate[0].declarationId).toBe(entries[0].declarationId);
  });
});
