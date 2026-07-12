// Core adapters for the transformation and rendering engine

import { ITransformer, IValidator, IRenderer, TransformOptions, ValidationResult, ComponentSpec, RenderResult } from '../core-engine';
import { UniversalCodeSanitizer, Framework } from '../codeSanitizer';

function ensureIIFE(snippet: string): string {
  const s = (snippet || '').trim();
  if (s.startsWith('(function()') && s.endsWith('})();')) return snippet;
  return `(function(){ return ${snippet}; })();`;
}
// transpilation now happens in CoreEngine; adapters expect spec.code to be an IIFE string

// Framework adapter interface
export interface FrameworkAdapter {
  framework: 'react' | 'vue' | 'svelte';
  transform(code: string): string;
  render(code: string, props: any, styles?: string): Promise<string>;
  validate?(code: string): string[]; // returns list of issues
}

// Babel transformer implementation
export class BabelTransformer implements ITransformer {
  private babel: any;

  constructor(babel: any) {
    this.babel = babel;
  }

  async transform(code: string, options: TransformOptions): Promise<string> {
    try {
      if (typeof window !== 'undefined') {
        // Browser environment
        return this.transformInBrowser(code, options.framework as Framework);
      } else {
        // Node.js environment
        return this.transformInNode(code, options.framework as Framework);
      }
    } catch (error) {
      console.warn('Babel transformation failed, using fallback:', error);
      return this.fallbackTransform(code, options.framework as Framework);
    }
  }

  private transformInNode(code: string, framework: Framework): string {
    try {
      const result = this.babel.transform(code, {
        presets: [
          ['@babel/preset-react', { runtime: 'classic' }],
          '@babel/preset-typescript'
        ],
        plugins: [
          '@babel/plugin-transform-modules-commonjs',
          '@babel/plugin-proposal-class-properties',
          '@babel/plugin-proposal-object-rest-spread'
        ]
      });

      const sanitizer = new UniversalCodeSanitizer(framework);
      const sanitized = sanitizer.sanitizeCode(result.code || code);
      if (!sanitized.success) {
        throw new Error('Code sanitization failed in Node.js transform');
      }
      return sanitized.cleanCode;
    } catch (error) {
      console.warn('Node.js Babel transformation failed:', error);
      return this.fallbackTransform(code, framework);
    }
  }

  private transformInBrowser(code: string, framework: Framework): string {
    try {
      if (this.babel && this.babel.transform) {
        const result = this.babel.transform(code, {
          presets: [
            ['@babel/preset-react', { runtime: 'classic' }],
            '@babel/preset-typescript'
          ],
          plugins: [
            '@babel/plugin-transform-modules-umd'
          ]
        });

        const sanitizer = new UniversalCodeSanitizer(framework);
        const sanitized = sanitizer.sanitizeCode(result.code || code);
        if (!sanitized.success) {
          throw new Error('Code sanitization failed in browser transform');
        }
        return sanitized.cleanCode;
      } else {
        return this.fallbackTransform(code, framework);
      }
    } catch (error) {
      console.warn('Browser Babel transformation failed:', error);
      return this.fallbackTransform(code, framework);
    }
  }

  private fallbackTransform(code: string, framework: Framework): string {
    const sanitizer = new UniversalCodeSanitizer(framework);
    const result = sanitizer.sanitizeCode(code);
    if (!result.success) {
      throw new Error('Fallback transformation failed: code sanitization error');
    }
    return result.cleanCode;
  }

  validate(code: string): boolean {
    try {
      this.babel.parse(code, { sourceType: 'module' });
      return true;
    } catch {
      return false;
    }
  }
}

// Zod validator implementation
export class ZodValidator implements IValidator {
  private schemas: Map<string, any> = new Map();
  private zod: any;

  constructor(zod: any) {
    this.zod = zod;
  }

  validate(componentName: string, props: any): ValidationResult {
    const schema = this.schemas.get(componentName);
    if (!schema) {
      return { success: true, errors: [] };
    }

    try {
      schema.parse(props);
      return { success: true, errors: [] };
    } catch (error: any) {
      return {
        success: false,
        errors: error.errors?.map((e: any) => e.message) || [error.message]
      };
    }
  }

  registerSchema(componentName: string, schema: any): void {
    this.schemas.set(componentName, schema);
  }

  createSchema(props: any[]): any {
    if (!this.zod) {
      return null;
    }

    const schemaObject: any = {};
    for (const prop of props) {
      if (prop.name && prop.type) {
        schemaObject[prop.name] = this.createPropSchema(prop);
      }
    }

    return this.zod.object(schemaObject);
  }

  private createPropSchema(_prop: any): any {
    // Implementation depends on Zod API
    return this.zod.any();
  }
}

// React renderer implementation
export class ReactRenderer implements IRenderer {
  private React: any;
  private ReactDOMServer: any;

  constructor(ReactLib?: any, ReactDOMServerLib?: any) {
    this.React = ReactLib;
    this.ReactDOMServer = ReactDOMServerLib;
  }

  async render(spec: ComponentSpec, props: any): Promise<RenderResult> {
    try {
      const { code, name: componentName } = spec;
      const React = this.React || require('react');
      const ReactDOMServer = this.ReactDOMServer || require('react-dom/server');
      const renderToStaticMarkup = ReactDOMServer && ReactDOMServer.renderToStaticMarkup
        ? ReactDOMServer.renderToStaticMarkup
        : require('react-dom/server').renderToStaticMarkup;

      const factory = new Function(`return ${code}`);
      const Component = factory();
      if (typeof Component !== 'function') {
        throw new Error('IIFE did not return a React component');
      }

      const element = React.createElement(Component, props);
      const bodyHtml = renderToStaticMarkup(element);
      const styles = (spec as any).styles || '';
      
      // Полный HTML документ для SSR
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>React Component</title>
  <style>
    body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; }
    ${styles}
  </style>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
</head>
<body>
  <div id="app">${bodyHtml}</div>
  <script>
${ensureIIFE(code)}
  </script>
</body>
</html>`;

      return { 
        type: 'html', 
        data: { 
          html,
          componentCode: ensureIIFE(code),
          componentName: componentName,
          styles
        }, 
        spec 
      };
    } catch (error: any) {
      return {
        type: 'error',
        data: error.message,
        spec,
      };
    }
  }
}

// Vue renderer implementation
export class VueRenderer implements IRenderer {
  private Vue: any;
  private VueServerRenderer: any;

  constructor(Vue: any, VueServerRenderer?: any) {
    this.Vue = Vue;
    this.VueServerRenderer = VueServerRenderer;
  }

  async render(spec: ComponentSpec, props: any): Promise<RenderResult> {
    try {
      const { code, name: componentName } = spec;
      // Lazy import SSR pieces to avoid top-level requirements
      const vueMod = this.Vue || require('vue');
      const createSSRApp = vueMod && vueMod.createSSRApp ? vueMod.createSSRApp : require('vue').createSSRApp;
      const ssrMod = this.VueServerRenderer || require('@vue/server-renderer');
      const renderToString = ssrMod && ssrMod.renderToString ? ssrMod.renderToString : require('@vue/server-renderer').renderToString;

      const factory = new Function(`return ${code}`);
      const Component = factory();
      if (!Component) throw new Error('IIFE did not return a Vue component');

      const app = createSSRApp(Component, props);
      const bodyHtml = await renderToString(app);
      const styles = (spec as any).styles || '';
      
      // Полный HTML документ для SSR
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Vue Component</title>
  <style>
    body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; }
    ${styles}
  </style>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
</head>
<body>
  <div id="app">${bodyHtml}</div>
  <script>
${ensureIIFE(code)}
  </script>
</body>
</html>`;

      return { 
        type: 'html', 
        data: { 
          html,
          componentCode: ensureIIFE(code),
          componentName: componentName,
          styles
        }, 
        spec 
      };
    } catch (error: any) {
      return {
        type: 'error',
        data: error.message,
        spec,
      };
    }
  }

  private findSourceFile(_componentName: string, _framework: string): { name: string; content: string } | null {
    return null;
  }
}

// Svelte renderer implementation
export class SvelteRenderer implements IRenderer {
  private Svelte: any;

  constructor(Svelte: any) {
    this.Svelte = Svelte;
  }

  async render(spec: ComponentSpec, props: any): Promise<RenderResult> {
    try {
      const { code, name: componentName } = spec;
      const factory = new Function(`return ${code}`);
      const Comp = factory();
      if (!Comp || typeof Comp !== 'object' || typeof Comp.render !== 'function') {
        throw new Error('IIFE did not return a Svelte SSR module with .render');
      }

      const rendered = Comp.render(props);
      const bodyHtml = typeof rendered === 'string' ? rendered : (rendered && rendered.html) || '';
      const styles = (spec as any).styles || '';
      
      // Полный HTML документ для SSR
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Svelte Component</title>
  <style>
    body { margin: 0; padding: 16px; font-family: -apple-system, sans-serif; }
    ${styles}
  </style>
  <script src="https://unpkg.com/svelte@4/compiler/svelte-compiler.min.js"></script>
</head>
<body>
  <div id="app">${bodyHtml}</div>
  <script>
${ensureIIFE(code)}
  </script>
</body>
</html>`;

      return { 
        type: 'html', 
        data: { 
          html,
          componentCode: ensureIIFE(code),
          componentName: componentName,
          styles
        }, 
        spec 
      };
    } catch (error: any) {
      return {
        type: 'error',
        data: error.message,
        spec,
      };
    }
  }
}
