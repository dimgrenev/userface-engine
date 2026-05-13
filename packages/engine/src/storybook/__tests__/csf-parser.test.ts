import { describe, it, expect } from 'vitest';
import { parseCsfFile, storyNameToDisplayName } from '../csf-parser.js';
import { convertArgTypesToProps } from '../argtype-converter.js';
import { convertStoriesToStates } from '../story-converter.js';

// ─── CSF 3.0 Object Stories ─────────────────────────────────

describe('CSF 3.0 — object stories', () => {
  const source = `
import { Button } from './Button';

export default {
  title: 'Components/Button',
  component: Button,
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'ghost'],
      description: 'Visual style variant',
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    disabled: {
      control: 'boolean',
      defaultValue: false,
    },
    label: {
      control: 'text',
    },
  },
  args: {
    variant: 'primary',
    size: 'md',
    label: 'Click me',
  },
};

export const Primary = {
  args: {
    variant: 'primary',
  },
};

export const Secondary = {
  args: {
    variant: 'secondary',
    label: 'Cancel',
  },
};

export const WithIcon = {
  args: {
    variant: 'primary',
    size: 'lg',
  },
  render: (args) => <Button {...args} icon={<Icon />} />,
};

export const Interactive = {
  args: {
    variant: 'primary',
  },
  play: async ({ canvasElement }) => {
    const button = canvasElement.querySelector('button');
    button.click();
  },
};
`;

  const result = parseCsfFile(source, 'Button.stories.tsx');

  it('extracts title', () => {
    expect(result.title).toBe('Components/Button');
  });

  it('extracts component import path', () => {
    expect(result.componentImportPath).toBe('./Button');
  });

  it('extracts default args', () => {
    expect(result.defaultArgs).toEqual({
      variant: 'primary',
      size: 'md',
      label: 'Click me',
    });
  });

  it('extracts argTypes', () => {
    expect(result.argTypes.variant).toEqual({
      control: 'select',
      options: ['primary', 'secondary', 'ghost'],
      description: 'Visual style variant',
    });
    expect(result.argTypes.disabled).toEqual({
      control: 'boolean',
      defaultValue: false,
    });
    expect(result.argTypes.label).toEqual({
      control: 'text',
    });
  });

  it('extracts all stories', () => {
    expect(result.stories).toHaveLength(4);
    expect(result.stories.map((s) => s.name)).toEqual([
      'Primary',
      'Secondary',
      'WithIcon',
      'Interactive',
    ]);
  });

  it('merges story args with defaults', () => {
    const primary = result.stories.find((s) => s.name === 'Primary')!;
    expect(primary.args.variant).toBe('primary');
    expect(primary.args.size).toBe('md');
    expect(primary.args.label).toBe('Click me');

    const secondary = result.stories.find((s) => s.name === 'Secondary')!;
    expect(secondary.args.variant).toBe('secondary');
    expect(secondary.args.label).toBe('Cancel');
    expect(secondary.args.size).toBe('md'); // from defaults
  });

  it('detects render and play functions', () => {
    const withIcon = result.stories.find((s) => s.name === 'WithIcon')!;
    expect(withIcon.hasRenderFn).toBe(true);
    expect(withIcon.hasPlayFn).toBe(false);

    const interactive = result.stories.find((s) => s.name === 'Interactive')!;
    expect(interactive.hasPlayFn).toBe(true);
  });

  it('generates correct display names', () => {
    const withIcon = result.stories.find((s) => s.name === 'WithIcon')!;
    expect(withIcon.displayName).toBe('With Icon');
  });
});

// ─── CSF 2.0 Template.bind Stories ───────────────────────────

describe('CSF 2.0 — Template.bind stories', () => {
  const source = `
import { Button } from '../components/Button';

export default {
  title: 'UI/Button',
  component: Button,
  args: {
    size: 'md',
  },
};

const Template = (args) => <Button {...args} />;

export const Primary = Template.bind({});
Primary.args = {
  variant: 'primary',
  label: 'Submit',
};

export const Secondary = Template.bind({});
Secondary.args = {
  variant: 'secondary',
  label: 'Cancel',
};

export const Disabled = Template.bind({});
Disabled.args = {
  variant: 'primary',
  disabled: true,
};
`;

  const result = parseCsfFile(source, 'Button.stories.tsx');

  it('extracts title', () => {
    expect(result.title).toBe('UI/Button');
  });

  it('extracts component import path', () => {
    expect(result.componentImportPath).toBe('../components/Button');
  });

  it('extracts all bind stories', () => {
    expect(result.stories).toHaveLength(3);
    expect(result.stories.map((s) => s.name)).toEqual([
      'Primary',
      'Secondary',
      'Disabled',
    ]);
  });

  it('extracts story-specific args', () => {
    const primary = result.stories.find((s) => s.name === 'Primary')!;
    expect(primary.args.variant).toBe('primary');
    expect(primary.args.label).toBe('Submit');
    expect(primary.args.size).toBe('md'); // from defaults
  });

  it('extracts boolean args', () => {
    const disabled = result.stories.find((s) => s.name === 'Disabled')!;
    expect(disabled.args.disabled).toBe(true);
  });
});

// ─── Meta patterns ───────────────────────────────────────────

describe('meta extraction patterns', () => {
  it('handles satisfies Meta pattern', () => {
    const source = `
import { Button } from './Button';
import type { Meta, StoryObj } from '@storybook/react';

const meta = {
  title: 'Components/Button',
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: 'Click' },
};
`;
    const result = parseCsfFile(source, 'Button.stories.tsx');
    expect(result.title).toBe('Components/Button');
    expect(result.componentImportPath).toBe('./Button');
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].name).toBe('Default');
    expect(result.stories[0].args).toEqual({ label: 'Click' });
  });

  it('handles typed meta: Meta<...> = { ... }', () => {
    const source = `
import { Input } from './Input';
import type { Meta } from '@storybook/react';

const meta: Meta<typeof Input> = {
  title: 'Forms/Input',
  component: Input,
};

export default meta;

export const Default = { args: { placeholder: 'Enter text' } };
`;
    const result = parseCsfFile(source, 'Input.stories.tsx');
    expect(result.title).toBe('Forms/Input');
    expect(result.componentImportPath).toBe('./Input');
  });

  it('handles no title in meta', () => {
    const source = `
import { Card } from './Card';

export default {
  component: Card,
};

export const Default = {};
`;
    const result = parseCsfFile(source, 'Card.stories.tsx');
    expect(result.title).toBeUndefined();
    expect(result.componentImportPath).toBe('./Card');
    expect(result.stories).toHaveLength(1);
  });
});

// ─── Edge cases ──────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty file', () => {
    const result = parseCsfFile('', 'empty.stories.tsx');
    expect(result.stories).toEqual([]);
    expect(result.componentImportPath).toBeNull();
    expect(result.argTypes).toEqual({});
    expect(result.defaultArgs).toEqual({});
  });

  it('handles file with no stories', () => {
    const source = `
import { Button } from './Button';

export default {
  title: 'Components/Button',
  component: Button,
};
`;
    const result = parseCsfFile(source, 'Button.stories.tsx');
    expect(result.title).toBe('Components/Button');
    expect(result.stories).toEqual([]);
  });

  it('handles file with no default export', () => {
    const source = `
export const Primary = {
  args: { variant: 'primary' },
};
`;
    const result = parseCsfFile(source, 'orphan.stories.tsx');
    expect(result.componentImportPath).toBeNull();
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].args).toEqual({ variant: 'primary' });
  });

  it('ignores comments', () => {
    const source = `
import { Button } from './Button';

// export const NotAStory = { args: { bad: true } };

export default {
  title: 'Components/Button',
  component: Button,
};

/* This is a block comment
export const AlsoNotAStory = { args: { bad: true } };
*/

export const Real = {
  args: { good: true },
};
`;
    const result = parseCsfFile(source, 'Button.stories.tsx');
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].name).toBe('Real');
  });

  it('handles numeric args', () => {
    const source = `
export default { component: Slider };

export const Default = {
  args: {
    min: 0,
    max: 100,
    step: 5,
  },
};
`;
    const result = parseCsfFile(source, 'Slider.stories.tsx');
    const story = result.stories[0];
    expect(story.args.min).toBe(0);
    expect(story.args.max).toBe(100);
    expect(story.args.step).toBe(5);
  });

  it('skips reserved exports', () => {
    const source = `
export default { component: Button };
export const __namedExportsOrder = ['Primary'];
export const Primary = { args: { variant: 'primary' } };
`;
    const result = parseCsfFile(source, 'Button.stories.tsx');
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0].name).toBe('Primary');
  });

  it('handles mixed CSF 2 and 3', () => {
    const source = `
import { Button } from './Button';

export default {
  component: Button,
  args: { size: 'md' },
};

const Template = (args) => <Button {...args} />;

export const Primary = Template.bind({});
Primary.args = { variant: 'primary' };

export const Secondary = {
  args: { variant: 'secondary' },
};
`;
    const result = parseCsfFile(source, 'Button.stories.tsx');
    expect(result.stories).toHaveLength(2);
    const names = result.stories.map((s) => s.name);
    expect(names).toContain('Primary');
    expect(names).toContain('Secondary');
  });

  it('handles argTypes with object control', () => {
    const source = `
export default {
  component: Select,
  argTypes: {
    color: {
      control: { type: 'color' },
    },
  },
};

export const Default = {};
`;
    const result = parseCsfFile(source, 'Select.stories.tsx');
    expect(result.argTypes.color.control).toBe('color');
  });
});

// ─── storyNameToDisplayName ──────────────────────────────────

describe('storyNameToDisplayName', () => {
  it('converts PascalCase', () => {
    expect(storyNameToDisplayName('PrimaryLarge')).toBe('Primary Large');
  });

  it('keeps single word', () => {
    expect(storyNameToDisplayName('Primary')).toBe('Primary');
  });

  it('handles consecutive caps', () => {
    expect(storyNameToDisplayName('WithCTAButton')).toBe('With CTA Button');
  });

  it('handles camelCase', () => {
    expect(storyNameToDisplayName('darkMode')).toBe('dark Mode');
  });
});

// ─── argtype-converter ───────────────────────────────────────

describe('convertArgTypesToProps', () => {
  it('maps control types to face.json types', () => {
    const argTypes = {
      variant: { control: 'select', options: ['a', 'b'] },
      disabled: { control: 'boolean' },
      label: { control: 'text' },
      count: { control: 'number' },
      color: { control: 'color' },
    };

    const props = convertArgTypesToProps(argTypes, {});
    const byName = Object.fromEntries(props.map((p) => [p.name, p]));

    expect(byName.variant.type).toBe('enum');
    expect(byName.variant.options).toEqual(['a', 'b']);
    expect(byName.disabled.type).toBe('boolean');
    expect(byName.label.type).toBe('string');
    expect(byName.count.type).toBe('number');
    expect(byName.color.type).toBe('string');
  });

  it('uses defaultValue from argType or defaultArgs', () => {
    const argTypes = {
      size: { control: 'select', defaultValue: 'md' },
      variant: { control: 'text' },
    };
    const defaultArgs = { variant: 'primary', extra: true };

    const props = convertArgTypesToProps(argTypes, defaultArgs);
    const byName = Object.fromEntries(props.map((p) => [p.name, p]));

    expect(byName.size.defaultValue).toBe('md');
    expect(byName.size.required).toBe(false);
    expect(byName.variant.defaultValue).toBe('primary');
    expect(byName.variant.required).toBe(false);
    expect(byName.extra.type).toBe('boolean');
    expect(byName.extra.defaultValue).toBe(true);
  });

  it('marks props without defaults as required', () => {
    const props = convertArgTypesToProps(
      { name: { control: 'text' } },
      {},
    );
    expect(props[0].required).toBe(true);
  });

  it('preserves description', () => {
    const props = convertArgTypesToProps(
      { label: { control: 'text', description: 'Button text' } },
      {},
    );
    expect(props[0].description).toBe('Button text');
  });
});

// ─── story-converter ─────────────────────────────────────────

describe('convertStoriesToStates', () => {
  it('converts stories to state presets', () => {
    const stories = [
      {
        name: 'Primary',
        displayName: 'Primary',
        args: { variant: 'primary' },
        hasRenderFn: false,
        hasPlayFn: false,
      },
      {
        name: 'SecondaryLarge',
        displayName: 'Secondary Large',
        args: { variant: 'secondary', size: 'lg' },
        hasRenderFn: false,
        hasPlayFn: false,
      },
    ];

    const presets = convertStoriesToStates(stories, {});

    expect(presets).toHaveLength(2);
    expect(presets[0]).toEqual({
      id: 'primary',
      name: 'Primary',
      props: { variant: 'primary' },
      source: 'storybook',
    });
    expect(presets[1]).toEqual({
      id: 'secondary-large',
      name: 'Secondary Large',
      props: { variant: 'secondary', size: 'lg' },
      source: 'storybook',
    });
  });

  it('merges default args into presets', () => {
    const stories = [
      {
        name: 'Custom',
        displayName: 'Custom',
        args: { label: 'Go' },
        hasRenderFn: false,
        hasPlayFn: false,
      },
    ];

    const presets = convertStoriesToStates(stories, {
      size: 'md',
      variant: 'primary',
    });

    expect(presets[0].props).toEqual({
      size: 'md',
      variant: 'primary',
      label: 'Go',
    });
  });

  it('returns empty array for empty stories', () => {
    expect(convertStoriesToStates([], {})).toEqual([]);
  });
});
