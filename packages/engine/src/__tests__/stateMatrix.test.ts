import { expect, it } from 'vitest';
import { generateStates, type StateMatrixProp } from '../stateMatrix.js';

it.each(['one-at-a-time', 'cartesian'] as const)('preserves literal option types and explicit null defaults with %s generation', strategy => {
  const props: StateMatrixProp[] = [
    { name: 'choice', type: 'select', required: false, description: '', defaultValue: 1, options: [1, '1', true] },
    { name: 'label', type: 'string', required: false, description: '', defaultValue: null },
  ];
  const states = generateStates(props, { strategy });
  expect(states.map(state => state.props.choice)).toEqual([1, '1', true]);
  expect(states.every(state => state.props.label === null)).toBe(true);
  expect(props[0].options).toEqual([1, '1', true]);
});

it('keeps falsy defaults and manual overrides while retaining string choice compatibility', () => {
  const states = generateStates([
    { name: 'count', type: 'number', required: false, description: '', defaultValue: 0 },
    { name: 'enabled', type: 'boolean', required: false, description: '', defaultValue: false },
    { name: 'label', type: 'string', required: false, description: '', defaultValue: '' },
    { name: 'tone', type: 'select', required: false, description: '', defaultValue: 'plain', options: ['plain', 'bright'] },
  ], { manualStates: { custom: { label: null } } });
  expect(states[0].props).toEqual({ count: 0, enabled: false, label: '', tone: 'plain' });
  expect(states.find(state => state.name === 'custom')?.props.label).toBeNull();
  expect(states.some(state => state.props.tone === 'bright')).toBe(true);
});
