// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaceUi } from '../face-ui/FaceUi';
import { StatefulFaceUi } from '../face-ui/StatefulFaceUi';
import { renderFaceUiToReact } from '../face-ui/react';
import { createFaceUiRegistry } from '../face-ui/registry';
import type { FaceUiDoc } from '../face-ui/types';

type Identity = Readonly<{ nodeId: string; type: string }>;
type Observation = { element: HTMLElement | null; identity: Identity };

const Box = ({ children }: { children?: React.ReactNode }) => React.createElement('section', null, children);
const Label = ({ children }: { children?: React.ReactNode }) => React.createElement('strong', null, children);
const registry = createFaceUiRegistry({ Box, Label });
const doc = (root: FaceUiDoc['root']): FaceUiDoc => ({ schema: 'face', 'schema-version': 1, root });

describe('Face UI React node observation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('observes only canonical wrappers, including nested nodes, without forwarding the observer', () => {
    const receivedProps: Record<string, unknown>[] = [];
    const Misleading = (props: Record<string, unknown>) => {
      receivedProps.push(props);
      return React.createElement('i', { 'data-uf-nodeid': 'not-a-face-node' }, 'inner DOM');
    };
    const observations: Observation[] = [];
    const onNodeElement = (element: HTMLElement | null, identity: Identity) => observations.push({ element, identity });
    const tree = doc({ type: 'Box', children: [{ type: 'Misleading', key: 'actual', props: { title: 'given' } }] });

    act(() => root.render(renderFaceUiToReact(tree, { registry: createFaceUiRegistry({ Box, Misleading }) }, { onNodeElement })));

    expect(observations).toHaveLength(2);
    expect(observations.map(({ identity }) => identity)).toEqual([
      { nodeId: 'Box:i0/Misleading:kactual', type: 'Misleading' },
      { nodeId: 'Box:i0', type: 'Box' },
    ]);
    for (const { element, identity } of observations) {
      expect(element?.tagName).toBe('SPAN');
      expect(element?.dataset.ufNodeid).toBe(identity.nodeId);
      expect(element?.style.display).toBe('contents');
      expect(Object.isFrozen(identity)).toBe(true);
    }
    expect(container.querySelector('i[data-uf-nodeid="not-a-face-node"]')).not.toBeNull();
    expect(receivedProps).toEqual([{ title: 'given' }]);
  });

  it('detaches with the captured old identity and attaches the current identity on node changes', () => {
    const observations: Observation[] = [];
    const options = { onNodeElement: (element: HTMLElement | null, identity: Identity) => observations.push({ element, identity }) };
    act(() => root.render(renderFaceUiToReact(doc({ type: 'Box', children: ['before'] }), { registry }, options)));
    const before = observations[0];
    expect(before).toBeDefined();
    observations.length = 0;

    act(() => root.render(renderFaceUiToReact(doc({ type: 'Label', children: ['after'] }), { registry }, options)));
    expect(observations.map(({ element, identity }) => ({ attached: element !== null, ...identity }))).toEqual([
      { attached: false, nodeId: 'Box:i0', type: 'Box' },
      { attached: true, nodeId: 'Label:i0', type: 'Label' },
    ]);
    expect(observations[0].identity).toBe(before.identity);
    const current = observations[1];
    observations.length = 0;
    act(() => root.render(null));
    expect(observations).toEqual([{ element: null, identity: current.identity }]);
    expect(observations[0].identity).toBe(current.identity);
  });

  it('forwards the optional observer through FaceUi and its current callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const tree = doc({ type: 'Box', children: ['visible'] });
    act(() => root.render(React.createElement(FaceUi, { doc: tree, registry, onNodeElement: first })));
    expect(first).toHaveBeenCalledWith(container.firstElementChild, { nodeId: 'Box:i0', type: 'Box' });

    act(() => root.render(React.createElement(FaceUi, { doc: tree, registry, onNodeElement: second })));
    expect(first).toHaveBeenLastCalledWith(null, { nodeId: 'Box:i0', type: 'Box' });
    expect(second).toHaveBeenCalledWith(container.firstElementChild, { nodeId: 'Box:i0', type: 'Box' });
    act(() => root.render(null));
    expect(second).toHaveBeenLastCalledWith(null, { nodeId: 'Box:i0', type: 'Box' });
  });

  it('forwards the observer through StatefulFaceUi during real local state updates', () => {
    const Button = ({ label, onClick }: { label: string; onClick: () => void }) => React.createElement('button', { onClick }, label);
    const onNodeElement = vi.fn();
    const onStateChange = vi.fn();
    const tree: FaceUiDoc = {
      ...doc({ type: 'Button', props: { label: { $ref: 'state.label' }, onClick: { $action: 'setState', args: { key: 'label', value: 'After' } } } }),
      state: { label: 'Before' },
    };
    act(() => root.render(React.createElement(StatefulFaceUi, {
      doc: tree, registry: createFaceUiRegistry({ Button }), onNodeElement, onStateChange,
    })));
    expect(container.querySelector('button')?.textContent).toBe('Before');
    expect(onNodeElement).toHaveBeenCalledWith(container.firstElementChild, { nodeId: 'Button:i0', type: 'Button' });

    act(() => container.querySelector('button')!.click());
    expect(onStateChange).toHaveBeenCalledWith({ label: 'After' });
    expect(container.querySelector('button')?.textContent).toBe('After');
    expect(onNodeElement).toHaveBeenLastCalledWith(container.firstElementChild, { nodeId: 'Button:i0', type: 'Button' });
    act(() => root.render(null));
    expect(onNodeElement).toHaveBeenLastCalledWith(null, { nodeId: 'Button:i0', type: 'Button' });
  });

  it('preserves the legacy wrapper and does not attach a ref when no observer is supplied', () => {
    const element = renderFaceUiToReact(doc({ type: 'Box', children: ['legacy'] }), { registry });
    expect(Object.getOwnPropertyDescriptor(element, 'ref')?.value).toBeNull();
    expect(element.props).toEqual({ 'data-uf-nodeid': 'Box:i0', style: { display: 'contents' }, children: expect.anything() });
    act(() => root.render(element));
    expect(container.innerHTML).toBe('<span data-uf-nodeid="Box:i0" style="display: contents;"><section>legacy</section></span>');
  });

  it('preserves keyed component state and DOM through reorder and props updates, resetting only a replaced key', () => {
    const Counter = ({ label }: { label: string }) => {
      const [count, setCount] = React.useState(0);
      return React.createElement('button', { onClick: () => setCount(value => value + 1) }, `${label}:${count}`);
    };
    const registry = createFaceUiRegistry({ Box, Counter });
    const node = (key: string, label = key) => ({ type: 'Counter', key, props: { label } });
    const render = (children: FaceUiDoc['root']['children']) => act(() => root.render(
      React.createElement(FaceUi, { doc: doc({ type: 'Box', children }), registry })));
    render([node('A'), node('B')]);
    const firstA = container.querySelector('button')!;
    act(() => firstA.click());
    expect(container.textContent).toBe('A:1B:0');
    render([node('B'), node('A')]);
    expect(container.textContent).toBe('B:0A:1');
    expect(container.querySelectorAll('button')[1]).toBe(firstA);
    render([node('B'), node('A', 'renamed')]);
    expect(container.textContent).toBe('B:0renamed:1');
    render([node('B'), node('new-A', 'renamed')]);
    expect(container.textContent).toBe('B:0renamed:0');
    expect(container.querySelectorAll('button')[1]).not.toBe(firstA);
  });

  it('does not invoke observers during SSR or for unknown component fallbacks', () => {
    const onNodeElement = vi.fn();
    const tree = doc({ type: 'Box', children: [{ type: 'Label', key: 'title', children: ['SSR'] }] });
    const legacy = renderToStaticMarkup(renderFaceUiToReact(tree, { registry }));
    expect(renderToStaticMarkup(renderFaceUiToReact(tree, { registry }, { onNodeElement }))).toBe(legacy);
    expect(onNodeElement).not.toHaveBeenCalled();
    act(() => root.render(renderFaceUiToReact(doc({ type: 'Unknown' }), { registry }, { onNodeElement })));
    expect(container.textContent).toBe('UF_FACE_UNKNOWN_COMPONENT(Unknown)');
    expect(onNodeElement).not.toHaveBeenCalled();
  });

  it('does not swallow exceptions from the React ref callback', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('observer failed');
    const handleExpectedError = (event: ErrorEvent) => { if (event.error === failure) event.preventDefault(); };
    const onNodeElement = (element: HTMLElement | null) => { if (element) throw failure; };
    window.addEventListener('error', handleExpectedError);
    try {
      expect(() => act(() => root.render(renderFaceUiToReact(doc({ type: 'Box' }), { registry }, { onNodeElement })))).toThrow(failure);
    } finally {
      window.removeEventListener('error', handleExpectedError);
    }
  });
});
