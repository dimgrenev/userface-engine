import type { FaceUiNode, FaceUiValue, FaceUiActionRef, FaceUiRef } from './types';
import { FaceUiDocSchema } from './schema';

export interface CodegenOptions {
  componentName?: string;
  framework?: 'react' | 'vue' | 'html';
  /** Resolve a component name to its import path. Default: `@/components/${name}` */
  importResolver?: (componentName: string) => string;
}

function isActionRef(v: any): v is FaceUiActionRef {
  return !!v && typeof v === 'object' && typeof v.$action === 'string';
}

function isRef(v: any): v is FaceUiRef {
  return !!v && typeof v === 'object' && typeof v.$ref === 'string';
}

function collectComponents(node: FaceUiNode, set: Set<string>) {
  set.add(node.type);
  if (node.children) {
    for (const child of node.children) {
      if (child && typeof child === 'object' && 'type' in child) {
        collectComponents(child as FaceUiNode, set);
      }
    }
  }
}

// ============================================================================
// React Generator
// ============================================================================

function generateReactValue(v: FaceUiValue): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v.replace(/"/g, '\\"')}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isActionRef(v)) {
    const argsStr = v.args !== undefined ? `, ${JSON.stringify(v.args)}` : '';
    return `() => dispatch("${v.$action}"${argsStr})`;
  }
  if (isRef(v)) {
    return `state.${v.$ref}`;
  }
  return JSON.stringify(v);
}

function generateReactProps(props: Record<string, FaceUiValue> | undefined): string {
  if (!props) return '';
  const entries = Object.entries(props).map(([k, v]) => {
    if (isActionRef(v) || isRef(v)) {
      return `${k}={${generateReactValue(v)}}`;
    }
    if (typeof v === 'string') {
      return `${k}="${v.replace(/"/g, '\\"')}"`;
    }
    return `${k}={${generateReactValue(v)}}`;
  });
  return entries.length > 0 ? ' ' + entries.join(' ') : '';
}

function generateReactNode(node: FaceUiNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const propsStr = generateReactProps(node.props);
  
  if (!node.children || node.children.length === 0) {
    return `${indent}<${node.type}${propsStr} />`;
  }

  const childrenStr = node.children.map(child => {
    if (typeof child === 'string') return `${indent}  ${child}`;
    if (typeof child === 'number' || typeof child === 'boolean') return `${indent}  {${child}}`;
    if (child && typeof child === 'object' && 'type' in child) return generateReactNode(child as FaceUiNode, depth + 1);
    return '';
  }).filter(Boolean).join('\n');

  return `${indent}<${node.type}${propsStr}>\n${childrenStr}\n${indent}</${node.type}>`;
}

export function generateReactCode(doc: any, options: CodegenOptions = {}): string {
  const root = doc.root as FaceUiNode;
  const compName = options.componentName || 'GeneratedComponent';
  const usedComponents = new Set<string>();
  collectComponents(root, usedComponents);

  const resolver = options.importResolver || ((c: string) => `@/components/${c}`);
  const imports = Array.from(usedComponents).sort().map(c => `import { ${c} } from '${resolver(c)}';`).join('\n');
  const jsx = generateReactNode(root, 2);

  return `import React from 'react';
${imports}

export interface ${compName}Props {
  state?: any;
  dispatch?: (action: string, args?: any) => void;
}

export function ${compName}({ state = {}, dispatch = () => {} }: ${compName}Props) {
  return (
${jsx}
  );
}
`;
}

// ============================================================================
// Vue Generator
// ============================================================================

function generateVueValue(v: FaceUiValue): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return `'${v.replace(/'/g, "\\'")}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isActionRef(v)) {
    const argsStr = v.args !== undefined ? `, ${JSON.stringify(v.args)}` : '';
    return `() => dispatch('${v.$action}'${argsStr})`;
  }
  if (isRef(v)) {
    return `state.${v.$ref}`;
  }
  return JSON.stringify(v);
}

function generateVueProps(props: Record<string, FaceUiValue> | undefined): string {
  if (!props) return '';
  const entries = Object.entries(props).map(([k, v]) => {
    if (isActionRef(v)) {
      // Basic heuristic: bind actions as Vue event listeners if it looks like an event
      if (k.startsWith('on')) {
        const eventName = k.charAt(2).toLowerCase() + k.slice(3);
        return `@${eventName}="${generateVueValue(v)}"`;
      }
      return `:${k}="${generateVueValue(v)}"`;
    }
    if (isRef(v)) {
      return `:${k}="${generateVueValue(v)}"`;
    }
    if (typeof v === 'string') {
      return `${k}="${v.replace(/"/g, '\\"')}"`;
    }
    return `:${k}="${generateVueValue(v)}"`;
  });
  return entries.length > 0 ? ' ' + entries.join(' ') : '';
}

function generateVueNode(node: FaceUiNode, depth: number): string {
  const indent = '  '.repeat(depth);
  const propsStr = generateVueProps(node.props);
  
  if (!node.children || node.children.length === 0) {
    return `${indent}<${node.type}${propsStr} />`;
  }

  const childrenStr = node.children.map(child => {
    if (typeof child === 'string') return `${indent}  ${child}`;
    if (typeof child === 'number' || typeof child === 'boolean') return `${indent}  {{ ${child} }}`;
    if (child && typeof child === 'object' && 'type' in child) return generateVueNode(child as FaceUiNode, depth + 1);
    return '';
  }).filter(Boolean).join('\n');

  return `${indent}<${node.type}${propsStr}>\n${childrenStr}\n${indent}</${node.type}>`;
}

export function generateVueCode(doc: any, options: CodegenOptions = {}): string {
  const root = doc.root as FaceUiNode;
  const usedComponents = new Set<string>();
  collectComponents(root, usedComponents);

  const resolver = options.importResolver || ((c: string) => `@/components/${c}.vue`);
  const imports = Array.from(usedComponents).sort().map(c => `import { ${c} } from '${resolver(c)}';`).join('\n');
  const template = generateVueNode(root, 1);

  return `<script setup lang="ts">
import { defineProps } from 'vue';
${imports}

const props = defineProps<{
  state?: Record<string, any>;
  dispatch?: (action: string, args?: any) => void;
}>();

const state = props.state || {};
const dispatch = props.dispatch || (() => {});
</script>

<template>
${template}
</template>
`;
}

// ============================================================================
// HTML Generator
// ============================================================================

function generateHtmlProps(props: Record<string, FaceUiValue> | undefined): string {
  if (!props) return '';
  const entries = Object.entries(props).map(([k, v]) => {
    if (isActionRef(v)) {
      const argsStr = v.args !== undefined ? `, ${JSON.stringify(v.args).replace(/"/g, "&quot;")}` : '';
      return `data-action="${v.$action}" data-args="${argsStr}"`;
    }
    if (isRef(v)) {
      return `data-ref="${v.$ref}"`;
    }
    if (typeof v === 'string') {
      return `${k}="${v.replace(/"/g, '&quot;')}"`;
    }
    return `${k}="${String(v).replace(/"/g, '&quot;')}"`;
  });
  return entries.length > 0 ? ' ' + entries.join(' ') : '';
}

function generateHtmlNode(node: FaceUiNode, depth: number): string {
  const indent = '  '.repeat(depth);
  // Default to a generic div with a class if the component name is custom
  // (In real apps, you'd probably map CustomType -> div.custom-type)
  const tag = node.type.toLowerCase();
  const isCustom = /^[A-Z]/.test(node.type);
  const tagName = isCustom ? 'div' : tag;
  
  let customClass = '';
  if (isCustom) {
    customClass = ` class="${node.type}"`;
  }
  
  const propsStr = generateHtmlProps(node.props);
  const fullProps = `${customClass}${propsStr}`;
  
  if (!node.children || node.children.length === 0) {
    return `${indent}<${tagName}${fullProps}></${tagName}>`;
  }

  const childrenStr = node.children.map(child => {
    if (typeof child === 'string') return `${indent}  ${child}`;
    if (typeof child === 'number' || typeof child === 'boolean') return `${indent}  ${child}`;
    if (child && typeof child === 'object' && 'type' in child) return generateHtmlNode(child as FaceUiNode, depth + 1);
    return '';
  }).filter(Boolean).join('\n');

  return `${indent}<${tagName}${fullProps}>\n${childrenStr}\n${indent}</${tagName}>`;
}

export function generateHtmlCode(doc: any, _options: CodegenOptions = {}): string {
  const root = doc.root as FaceUiNode;
  const template = generateHtmlNode(root, 2);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Materialized UI</title>
</head>
<body>
${template}
</body>
</html>
`;
}

export function generateCode(doc: any, options: CodegenOptions = {}): string {
  const parsed = FaceUiDocSchema.safeParse(doc);
  if (!parsed.success || !parsed.data.root) {
    throw new Error('Invalid face document');
  }

  const normalizedDoc = parsed.data;
  const fw = options.framework || 'react';
  if (fw === 'vue') return generateVueCode(normalizedDoc, options);
  if (fw === 'html') return generateHtmlCode(normalizedDoc, options);
  return generateReactCode(normalizedDoc, options);
}
