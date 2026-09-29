import { describe, it, expect } from 'vitest';
import { discoverStorybookExports, detectStorybookFramework } from '../source/index.js';

describe('optional Storybook discovery', () => {
  it('discovers CSF2 and CSF3 exports while respecting include/exclude and types', () => {
    const source = `const meta={component:Button,includeStories:/Story$/,excludeStories:['HiddenStory']} satisfies Meta;
      export default meta; export const ObjectStory={args:{label:'example'}};
      const Template=args=><Button {...args}/>; export const FunctionStory=Template.bind({});
      export const HiddenStory={}; export const Helper={}; export type TypeStory=string;`;
    expect(discoverStorybookExports(source, 'Button.stories.tsx').map(entry=>entry.exportName)).toEqual(['ObjectStory','FunctionStory']);
  });
  it('does not confuse ordinary source exports with a story module', () => {
    expect(discoverStorybookExports('export const Button=()=> <button/>;', 'Button.tsx')).toEqual([]);
    expect(detectStorybookFramework(`import type {Meta} from '@storybook/vue3';`)).toBe('vue');
    expect(detectStorybookFramework(`import Component from './Button.svelte';`)).toBe('svelte');
  });
});
