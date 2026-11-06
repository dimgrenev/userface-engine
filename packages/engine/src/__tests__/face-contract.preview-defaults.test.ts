import { describe, expect, it } from 'vitest';
import { decodeFaceJsonContract, resolveFaceJsonPreviewProps } from '../face-contract/index.js';

function resolve(contract: Record<string, unknown>, props: Record<string, unknown> = {}) {
  const face = decodeFaceJsonContract(JSON.stringify({ name: 'Typography', ...contract }));
  expect(face).not.toBeNull();
  return resolveFaceJsonPreviewProps(props, face!);
}

describe('authored preview prop omission', () => {
  it.each(['controls', 'props'] as const)('omits optional size and variant without defaults or options from %s', shape => {
    const definitions = [{ name: 'size', type: 'string', required: false }, { name: 'variant', type: 'string', required: false }];
    const controls = shape === 'controls' ? { controls: definitions }
      : { props: Object.fromEntries(definitions.map(({ name, ...definition }) => [name, definition])) };
    expect(resolve({ ...controls, initialProps: { children: 'Authored content' } })).toEqual({ children: 'Authored content' });
  });

  it.each(['controls', 'props'] as const)('keeps a heading state free of an invented font size even when %s lists size options', shape => {
    const definitions = [{ name: 'size', type: 'enum', required: false, options: ['xs', 'sm', 'md', 'lg', 'xl'] },
      { name: 'variant', type: 'enum', required: false, options: ['body', 'heading'] }];
    const controls = shape === 'controls' ? { controls: definitions }
      : { props: Object.fromEntries(definitions.map(({ name, ...definition }) => [name, definition])) };
    const authored = { ...controls, states: [{ name: 'Heading', props: { children: 'Section title', variant: 'heading' } }] };
    const before = JSON.stringify(authored);
    expect(resolve(authored)).toEqual({ children: 'Section title', variant: 'heading' });
    expect(JSON.stringify(authored)).toBe(before);
  });

  it.each([
    { controls: [{ name: 'size', type: 'string', defaultValue: 'lg' }, { name: 'variant', type: 'string', defaultValue: 'muted' }] },
    { props: { size: { type: 'string', default: 'lg' }, variant: { type: 'string', default: 'muted' } } },
    { props: { size: { type: 'string', defaultValue: 'lg' }, variant: { type: 'string', defaultValue: 'muted' } } },
  ])('retains explicitly declared optional defaults: %j', contract => {
    expect(resolve(contract)).toEqual({ size: 'lg', variant: 'muted' });
  });

  it.each([
    { controls: [{ name: 'size', type: 'string', required: true }, { name: 'variant', type: 'string', required: true }] },
    { props: { size: { type: 'enum', required: true, options: ['md', 'lg'] }, variant: { type: 'enum', required: true, options: ['body', 'heading'] } } },
  ])('preserves required preview seed behavior: %j', contract => {
    const expected = 'controls' in contract ? { size: 'medium', variant: 'primary' } : { size: 'md', variant: 'body' };
    expect(resolve(contract)).toEqual(expected);
  });

  it.each([{ size: 'xl', variant: 'heading' }, { size: null, variant: '' }, { variant: 'h2' }])('retains current authored values and omission: %j', props => {
    const current = Object.freeze({ ...props });
    expect(resolve({ props: { size: { type: 'string' }, variant: { type: 'string' } }, currentState: { props: current } }))
      .toEqual(current);
    expect(current).toEqual(props);
  });

  it('preserves existing required and collection preview seeds independently of optional presentation props', () => {
    const props = resolve({ controls: [{ name: 'label', type: 'string', required: true },
      { name: 'items', type: 'array', required: false }, { name: 'size', type: 'string' }, { name: 'variant', type: 'string' }] });
    expect(props.label).toBe('Typography');
    expect(props.items).toEqual([
      { id: '1', value: '1', label: 'Item 1', title: 'Item 1', content: 'Content 1' },
      { id: '2', value: '2', label: 'Item 2', title: 'Item 2', content: 'Content 2' },
    ]);
    expect(props).not.toHaveProperty('size');
    expect(props).not.toHaveProperty('variant');
  });
});
