import { describe, it, expect } from 'vitest';
import { generateCode, generateReactCode, generateVueCode, generateHtmlCode } from '../face-ui/codegen';

const sampleDoc = {
  schema: 'face',
  'schema-version': 1,
  root: {
    type: 'Card',
    props: { variant: 'outlined' },
    children: [
      {
        type: 'Text',
        props: { text: 'Hello World' },
      },
      {
        type: 'Button',
        props: {
          text: 'Click me',
          onClick: { $action: 'card.click', args: { id: 1 } },
        },
      },
    ],
  },
};

describe('face-ui codegen', () => {
  describe('generateCode (unified)', () => {
    it('throws on invalid documents', () => {
      expect(() => generateCode({ schema: 'face', 'schema-version': 2, root: {} })).toThrow('Invalid face document');
      expect(() => generateCode({ schema: 'face', 'schema-version': 1 })).toThrow('Invalid face document');
      expect(() => generateCode(null)).toThrow();
    });

    it('defaults to react framework', () => {
      const code = generateCode(sampleDoc);
      expect(code).toContain('import React');
      expect(code).toContain('<Card');
      expect(code).toContain('<Button');
    });

    it('accepts framework option', () => {
      const vue = generateCode(sampleDoc, { framework: 'vue' });
      expect(vue).toContain('<script setup');
      const html = generateCode(sampleDoc, { framework: 'html' });
      expect(html).toContain('<!DOCTYPE html>');
    });
  });

  describe('generateReactCode', () => {
    it('generates valid React component', () => {
      const code = generateReactCode(sampleDoc);
      expect(code).toContain('import React');
      expect(code).toContain("import { Button } from '@/components/Button'");
      expect(code).toContain("import { Card } from '@/components/Card'");
      expect(code).toContain("import { Text } from '@/components/Text'");
      expect(code).toContain('export function');
      expect(code).toContain('dispatch(');
    });

    it('handles custom component name', () => {
      const code = generateReactCode(sampleDoc, { componentName: 'MyPage' });
      expect(code).toContain('export function MyPage');
      expect(code).toContain('MyPageProps');
    });

    it('handles leaf nodes', () => {
      const doc = {
        schema: 'face',
        'schema-version': 1,
        root: { type: 'Divider', props: {} },
      };
      const code = generateReactCode(doc);
      expect(code).toContain('<Divider');
      expect(code).toContain('/>');
    });

    it('handles $ref values', () => {
      const doc = {
        schema: 'face',
        'schema-version': 1,
        root: { type: 'Text', props: { text: { $ref: 'user.name' } } },
      };
      const code = generateReactCode(doc);
      expect(code).toContain('state.user.name');
    });
  });

  describe('generateVueCode', () => {
    it('generates valid Vue SFC', () => {
      const code = generateVueCode(sampleDoc);
      expect(code).toContain('<script setup lang="ts">');
      expect(code).toContain("import { defineProps } from 'vue'");
      expect(code).toContain("import { Button } from '@/components/Button.vue'");
      expect(code).toContain('<template>');
      expect(code).toContain('<Card');
    });
  });

  describe('generateHtmlCode', () => {
    it('generates valid HTML', () => {
      const code = generateHtmlCode(sampleDoc);
      expect(code).toContain('<!DOCTYPE html>');
      expect(code).toContain('<div class="Card"');
      expect(code).toContain('<div class="Button"');
      expect(code).toContain('<div class="Text"');
    });

    it('handles $action as data attributes', () => {
      const code = generateHtmlCode(sampleDoc);
      expect(code).toContain('data-action="card.click"');
    });
  });
});
