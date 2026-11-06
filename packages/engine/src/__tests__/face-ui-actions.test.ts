// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materializeFaceUiDoc } from '../face-ui/materialize';
import { StatefulFaceUi } from '../face-ui/StatefulFaceUi';
import { createFaceUiRegistry } from '../face-ui/registry';
import type { FaceUiDoc } from '../face-ui/types';

const documentFor = (action: string, args?: Record<string, any>): FaceUiDoc => ({
  schema: 'face', 'schema-version': 1, state: { value: 'Before' },
  root: { type: 'Control', props: { value: { $ref: 'state.value' }, onValueChange: { $action: action, ...(args ? { args } : {}) } } },
});

it('preserves callback arguments and action metadata without changing no-argument dispatch contexts', () => {
  const dispatch = vi.fn();
  const tree = materializeFaceUiDoc(documentFor('custom', { id: 'owned' }), { registry: createFaceUiRegistry({}), actions: { dispatch } });
  const callback = tree.root.resolvedProps.onValueChange;
  const details = { value: 'After' };
  callback(details, 17);
  expect(dispatch).toHaveBeenLastCalledWith('custom', { id: 'owned' }, { nodeType: 'Control', propName: 'onValueChange', callbackArgs: [details, 17] });
  expect(dispatch.mock.calls[0][2].callbackArgs[0]).toBe(details);
  callback();
  expect(dispatch).toHaveBeenLastCalledWith('custom', { id: 'owned' }, { nodeType: 'Control', propName: 'onValueChange' });
});

it('still drops a disallowed action before it can receive a callback', () => {
  const dispatch = vi.fn(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const tree = materializeFaceUiDoc(documentFor('forbidden'), { registry: createFaceUiRegistry({}), actions: { dispatch, allowlist: ['allowed'] } });
    expect(tree.root.resolvedProps.onValueChange).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  } finally { warn.mockRestore(); }
});

describe('StatefulFaceUi callback bindings', () => {
  let host: HTMLDivElement, root: Root, callback: (...args: unknown[]) => void;
  const onStateChange = vi.fn(), onAction = vi.fn();
  const Control = ({ value, onValueChange }: { value: unknown; onValueChange: typeof callback }) => {
    callback = onValueChange;
    return React.createElement('output', null, JSON.stringify(value));
  };
  const mount = (action = 'setState', args: Record<string, any> = { key: 'value' }) => act(() => root.render(
    React.createElement(StatefulFaceUi, { doc: documentFor(action, args), registry: createFaceUiRegistry({ Control }), onStateChange, onAction }),
  ));
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    onStateChange.mockClear(); onAction.mockClear();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  for (const wrapped of [false, true])
    it.each(['After', '', 0, false, null])(`sets state from ${wrapped ? '{value}' : 'primitive'} callback payload %j`, value => {
      mount();
      act(() => callback(wrapped ? { value } : value));
      expect(host.textContent).toBe(JSON.stringify(value));
      expect(onStateChange).toHaveBeenLastCalledWith({ value });
    });

  it('keeps an explicit static value authoritative over callback arguments', () => {
    mount('setState', { key: 'value', value: 'Explicit' });
    act(() => callback({ value: 'Ignored' }));
    expect(host.textContent).toBe('"Explicit"');
  });

  it('preserves toggle behavior independently from the callback payload', () => {
    mount('toggle', { key: 'value' });
    act(() => callback({ value: 'Ignored' }));
    expect(host.textContent).toBe('false');
    act(() => callback());
    expect(host.textContent).toBe('true');
  });

  it.each([undefined, {}, { target: { value: 'Not a declared binding' } }, { nodeType: 'metadata', propName: 'onChange' }])('does not store missing or unsupported callback data as state: %j', value => {
    mount();
    act(() => value === undefined ? callback() : callback(value));
    expect(host.textContent).toBe('"Before"');
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('forwards custom actions with callback arguments and preserves their declared arguments', () => {
    mount('app.inspect', { id: 'owned' });
    const payload = { value: 'After' };
    act(() => callback(payload, 'secondary'));
    expect(onAction).toHaveBeenCalledWith('app.inspect', { id: 'owned' }, { nodeType: 'Control', propName: 'onValueChange', callbackArgs: [payload, 'secondary'] });
    expect(host.textContent).toBe('"Before"');
  });
});
