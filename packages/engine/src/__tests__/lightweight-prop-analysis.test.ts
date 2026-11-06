import { describe, expect, it } from 'vitest';
import {
  extractReactTsPropsFromSource,
  extractVuePropsFromSFC,
  extractSvelteProps,
} from '../prop-analysis/lightweight/index.js';

describe('browser-safe legacy prop extraction contract', () => {
  it('selects the public React props and its forwardRef defaults, not a private renderer contract', () => {
    const props = extractReactTsPropsFromSource({ fileName: 'Card/Card.tsx', code: `
      export interface CardProps {
        variant?: 'default' | 'outline'
        border?: boolean
        fullWidth?: boolean
      }
      interface CardHeaderProps { layout?: string }
      const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(props, ref) {
        return <div ref={ref} />;
      });
      export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(props, ref) {
        const { variant = 'default', border = true, fullWidth = false } = props;
        return <div ref={ref} />;
      });
    ` });
    expect(props.map(prop => prop.name)).toEqual(['variant', 'border', 'fullWidth']);
    expect(props.find(prop => prop.name === 'variant')).toMatchObject({
      type: 'select', options: ['default', 'outline'], defaultValue: 'default', required: false,
    });
    expect(props.find(prop => prop.name === 'border')?.defaultValue).toBe(true);
    expect(props.find(prop => prop.name === 'fullWidth')?.defaultValue).toBe(false);
  });

  it('leaves a composed public alias to semantic analysis rather than borrowing a private interface', () => {
    expect(extractReactTsPropsFromSource({ fileName: 'Field/Field.tsx', code: `
      interface FieldSharedProps { label?: string }
      export type FieldProps = FieldSharedProps & ({ multiline?: false } | { multiline: true; rows?: number })
      const Field = forwardRef(function Field(props, ref) { return null })
    ` })).toEqual([]);
  });

  it('does not treat fields inside callback detail objects as public props', () => {
    const props = extractReactTsPropsFromSource({ fileName: 'Tree/Tree.tsx', code: `
      export interface TreeProps {
        value?: string
        onValueChange?: (details: {
          value: string
        }) => void
        expanded?: readonly string[]
        onExpandedChange?: (details: {
          expanded: string[]
        }) => void
      }
    ` });
    expect(props.map(prop => prop.name)).toEqual([
      'value', 'onValueChange', 'expanded', 'onExpandedChange',
    ]);
  });

  it('preserves Vue literal options and withDefaults without executing the SFC', () => {
    const props = extractVuePropsFromSFC(`<script setup lang="ts">
      const props = withDefaults(defineProps<{ tone?: 'warm' | 'cool'; enabled?: boolean }>(), {
        tone: 'warm', enabled: true
      });
    </script><template><div /></template>`);
    expect(props).toEqual([
      { name: 'tone', type: 'select', required: false, options: ['warm', 'cool'], defaultValue: 'warm' },
      { name: 'enabled', type: 'boolean', required: false, defaultValue: true },
    ]);
  });

  it('preserves Svelte export-let defaults and literal options', () => {
    const props = extractSvelteProps(`<script lang="ts">
      export let count: number = 0;
      export let mode: 'on' | 'off' = 'on';
    </script>`);
    expect(props).toEqual([
      { name: 'count', type: 'number', required: false, defaultValue: 0 },
      { name: 'mode', type: 'select', required: false, options: ['on', 'off'], defaultValue: 'on' },
    ]);
  });
});
