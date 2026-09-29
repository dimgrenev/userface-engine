import { describe, expect, it } from 'vitest';
import { decodeFaceJsonContract, isLikelyFaceJsonRecord, resolveFaceJsonPreviewProps, parseJsonRecord } from '../face-contract/index.js';

describe('public Face contract semantics', () => {
  it('rejects malformed JSON and non-contract records', () => {
    expect(decodeFaceJsonContract('{')).toBeNull();
    expect(decodeFaceJsonContract('[]')).toBeNull();
    expect(decodeFaceJsonContract('{"unrelated":true}')).toBeNull();
    expect(parseJsonRecord('  {"empty":null}  ')).toEqual({ empty: null });
  });

  it('keeps legacy truthy name and schema type detection for facade consumers', () => {
    const legacy = { name: 7, schema: { props: { count: { type: 123, default: 2 } } } };
    expect(isLikelyFaceJsonRecord(legacy)).toBe(true);
    expect(decodeFaceJsonContract(JSON.stringify(legacy))?.controls).toMatchObject([
      { name: 'count', type: '123', defaultValue: 2 },
    ]);
  });

  it('preserves explicit current values over declared defaults without changing caller props', () => {
    const face = decodeFaceJsonContract(JSON.stringify({
      name: 'Button', props: { label: { type: 'string', default: 'Default label' } },
      states: [{ name: 'Default', props: { label: 'State label', disabled: false } }],
      currentState: { props: { label: '', disabled: null } },
    }));
    expect(face).not.toBeNull();
    const base = Object.freeze({ id: 'source-button' });
    expect(resolveFaceJsonPreviewProps(base, face!)).toEqual({ id: 'source-button', label: '', disabled: null });
    expect(base).toEqual({ id: 'source-button' });
  });

  it('uses a default-like state in object state maps', () => {
    const face = decodeFaceJsonContract(JSON.stringify({
      name: 'Badge', states: { Loading: { label: 'Loading' }, Default: { label: 'Ready' } },
    }));
    expect(face).not.toBeNull();
    expect(resolveFaceJsonPreviewProps({}, face!)).toEqual({ label: 'Ready' });
  });

  it('preserves explicit empty control defaults instead of inventing preview values', () => {
    const face = decodeFaceJsonContract(JSON.stringify({
      name: 'Button',
      controls: [
        { name: 'label', type: 'string', required: true, defaultValue: '' },
        { name: 'variant', type: 'enum', options: ['primary', 'secondary'], defaultValue: '' },
      ],
    }));
    expect(face).not.toBeNull();
    expect(resolveFaceJsonPreviewProps({}, face!)).toEqual({ label: '', variant: '' });
  });

  it('preserves typed null defaults, including when defaultValue also exists', () => {
    const face = decodeFaceJsonContract(JSON.stringify({
      name: 'Button',
      props: {
        label: { type: 'string', default: null },
        tone: { type: 'string', default: null, defaultValue: 'fallback' },
      },
    }));
    expect(face).not.toBeNull();
    expect(face?.controls?.[0]?.defaultValue).toBeUndefined();
    expect(face?.controls?.[1]?.defaultValue).toBe('fallback');
    expect(resolveFaceJsonPreviewProps({}, face!)).toEqual({ label: null, tone: null });
  });

  it('keeps distinct null precedence for explicit controls and props arrays', () => {
    const face = decodeFaceJsonContract(JSON.stringify({
      name: 'Button',
      controls: [
        { name: 'explicit', type: 'string', defaultValue: null, default: 'fallback' },
      ],
      props: [
        { name: 'arrayFallback', type: 'string', defaultValue: null, default: 'fallback' },
        { name: 'arrayNull', type: 'string', defaultValue: null, default: null },
      ],
    }));
    expect(face?.controls?.map((control) => control.defaultValue)).toEqual([null, 'fallback', null]);
    expect(resolveFaceJsonPreviewProps({}, face!)).toEqual({
      explicit: null,
      arrayFallback: 'fallback',
      arrayNull: null,
    });
  });

  it('uses legacy truthiness for required metadata and preview seeds', () => {
    const face = decodeFaceJsonContract(JSON.stringify({
      name: 'Button',
      controls: [
        { name: 'truthyString', type: 'boolean', required: 'yes' },
        { name: 'truthyNumber', type: 'boolean', required: 1 },
        { name: 'truthyObject', type: 'boolean', required: {} },
        { name: 'falseBoolean', type: 'boolean', required: false },
        { name: 'falseNumber', type: 'boolean', required: 0 },
        { name: 'falseString', type: 'boolean', required: '' },
        { name: 'falseNull', type: 'boolean', required: null },
      ],
    }));
    expect(face?.controls?.map((control) => control.required)).toEqual([
      true, true, true, false, false, false, false,
    ]);
    expect(resolveFaceJsonPreviewProps({}, face!)).toEqual({
      truthyString: false,
      truthyNumber: false,
      truthyObject: false,
    });
  });
});
