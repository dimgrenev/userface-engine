import { describe, expect, it } from 'vitest';
import { discoverSourceComponentExports } from '../source/index.js';

const roles = async (source: string) => Object.fromEntries((await discoverSourceComponentExports(source, '/src/mixed.tsx'))
  .map(entry => [entry.exportName, entry.renderRole]));

describe('automatic source render role', () => {
  it('analyzes each render result across all states, without counting nested callbacks', async () => {
    const found = await roles(`
      import React, {useEffect, memo as cache, forwardRef} from 'react';
      export function ArbitraryName() { useEffect(() => { const callback = () => <div/>; subscribe(callback); }, []); return null; }
      export const DisabledByDefault = ({enabled = false}) => enabled ? <button/> : null;
      export const Text = () => 'ready';
      export const Count = () => 0;
      export const List = () => [null, <span/>];
      export const EmptyList = () => [null, false];
      export const EmptyFragment = () => <>{null}{false}</>;
      export const Waiting = () => undefined;
      export const Cached = cache(() => null);
      export const Forwarded = forwardRef(() => null);
      export class Listener extends React.Component { render() { return null; } }
      const noOutput = () => null;
      export const Helper = () => noOutput();
    `);
    for (const name of ['ArbitraryName', 'EmptyList', 'EmptyFragment', 'Waiting', 'Cached', 'Forwarded', 'Listener'])
      expect(found[name], name).toBe('nonvisual');
    for (const name of ['DisabledByDefault', 'Text', 'Count', 'List']) {
      expect(Object.hasOwn(found, name), name).toBe(true);
      expect(found[name], name).toBeUndefined();
    }
  });

  it('recognizes context provenance and children passthrough, independently of names', async () => {
    const found = await roles(`
      import * as R from 'react';
      const State = R.createContext(null);
      const Alias = State;
      export const Scope = ({children: content}) => <Alias.Provider value={null}>{content}</Alias.Provider>;
      export const Shorthand = props => <State value={null}>{props.children}</State>;
      export const Nested = ({children}) => <State.Provider><State.Provider>{children}</State.Provider></State.Provider>;
      export const EmptyScope = () => <State.Provider value={null}/>;
      export const VisualProvider = ({children}) => <State.Provider><div>{children}</div></State.Provider>;
      export const DefaultChildren = ({children = <span/>}) => <State.Provider>{children}</State.Provider>;
      export const TextProvider = () => <State.Provider>Visible</State.Provider>;
      export const Spreading = props => <State.Provider {...props}/>;
      export const UnknownProvider = props => <Unknown.Provider>{props.children}</Unknown.Provider>;
      const fake = { createContext: () => ({Provider: Custom}) };
      const Other = fake.createContext();
      export const FalseProvenance = props => <Other.Provider>{props.children}</Other.Provider>;
      export function Shadowed(R) { const Local = R.createContext(null); return <Local.Provider/>; }
      const wrap = ({children}) => <State.Provider>{children}</State.Provider>;
      export const ThroughHelper = () => wrap({children: <span/>});
      const registry = {State}; registry.State = Unknown;
      export const MutableContextMember = props => <registry.State.Provider>{props.children}</registry.State.Provider>;
    `);
    for (const name of ['Scope', 'Shorthand', 'Nested', 'EmptyScope']) expect(found[name], name).toBe('provider');
    for (const name of ['VisualProvider', 'DefaultChildren', 'TextProvider', 'Spreading', 'UnknownProvider', 'FalseProvenance', 'Shadowed', 'ThroughHelper', 'MutableContextMember']) {
      expect(Object.hasOwn(found, name), name).toBe(true);
      expect(found[name], name).toBeUndefined();
    }
  });

  it('handles emitted React factories through their actual imports', async () => {
    const found = await roles(`
      import {createContext as context, createElement as element} from 'react';
      import {jsx as node} from 'react/jsx-runtime';
      const State = context(null);
      export const Scope = props => element(State.Provider, {value: null}, props.children);
      export const Emitted = props => node(State.Provider, {value: null, children: props.children});
      export const Visual = props => node(State.Provider, {children: node('div', {})});
      export const Spread = props => node(State.Provider, {...props});
      export const Computed = props => node(State.Provider, {[props.key]: node('span', {})});
      export const LiteralChildren = () => element(State.Provider, {['children']: element('span', {})});
    `);
    expect(found.Scope).toBe('provider'); expect(found.Emitted).toBe('provider');
    expect(found.Visual).toBeUndefined(); expect(found.Spread).toBeUndefined();
    expect(found.Computed).toBeUndefined(); expect(found.LiteralChildren).toBeUndefined();
  });

  it('does not treat mutable bindings, shadowed undefined or unknown HOCs as negative evidence', async () => {
    const found = await roles(`
      import React from 'react';
      import {decorate} from '@vendor/unknown';
      export function Dynamic(props) { let view = null; if (props.enabled) view = <span/>; return view; }
      export function MutableObject(props) { const state = {view: null}; state.view = <span/>; return state.view; }
      export function ShadowedUndefined(undefined) { return undefined; }
      export let Changed = () => null; Changed = () => <button/>;
      const Empty = () => null;
      export const Unknown = decorate(Empty);
      export const ProviderByName = () => <button/>;
      export function Recursive() { return Recursive(); }
      export class CustomBase extends Unknown { render() { return null; } }
      export class Replaced extends React.Component { constructor(props) { super(props); this.render = () => <div/>; } render() { return null; } }
    `);
    for (const name of ['Dynamic', 'MutableObject', 'ShadowedUndefined', 'Changed', 'Unknown', 'ProviderByName', 'CustomBase', 'Replaced']) {
      expect(Object.hasOwn(found, name), name).toBe(true);
      expect(found[name], name).toBeUndefined();
    }
  });

  it('propagates evidence through arbitrary aliases, barrels and imported contexts without executing modules', async () => {
    const modules: Record<string, string> = {
      './owner': `throw new Error('never execute'); export const First = () => null; export const Second = ({on=false}) => on ? <span/> : null;`,
      './barrel': `export {First as Renamed, Second} from './owner';`,
      './context': `import {createContext} from 'react'; export const Shared = createContext(null);`,
    };
    const entries = await discoverSourceComponentExports(`
      import {Renamed} from './barrel'; import {Shared} from './context';
      export {Renamed as Reexport, Second} from './barrel';
      export const LocalAlias = Renamed;
      export const Scope = props => <Shared.Provider>{props.children}</Shared.Provider>;
    `, '/src/entry.tsx', async specifier => modules[specifier] ? {path: '/src/' + specifier.slice(2) + '.tsx', source: modules[specifier]} : null);
    expect(entries.find(entry => entry.exportName === 'Reexport')).toMatchObject({renderRole: 'nonvisual', declarationId: '/src/owner.tsx:First'});
    expect(entries.find(entry => entry.exportName === 'LocalAlias')?.renderRole).toBe('nonvisual');
    expect(entries.find(entry => entry.exportName === 'Scope')?.renderRole).toBe('provider');
    expect(entries.find(entry => entry.exportName === 'Second')?.renderRole).toBeUndefined();
  });
});
