/**
 * Userface Engine MCP Server (local, stdin/stdout)
 *
 * JSON-RPC 2.0 over line-delimited stdio.
 * Designed to run as: npx userface mcp-serve
 *
 * Cursor config (.cursor/mcp.json):
 * {
 *   "mcpServers": {
 *     "userface": {
 *       "command": "npx",
 *       "args": ["userface", "mcp-serve"]
 *     }
 *   }
 * }
 */

import { createRequire } from 'node:module';
import * as readline from 'node:readline';
import { resolve, basename, relative, isAbsolute, dirname } from 'node:path';
import { statSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { readComponentFiles, discoverComponents } from './fs-helpers';
import { createEngine, type EngineInstance } from './createEngine';
import type { CreateEngineOptions } from './createEngine';
import { getComponentFaceJsonFileNames } from './faceJsonPaths';
import { scanRegistry } from './registry';
import { RuleEngine, basePolicyPack, type ValidateMode, type BudgetMode } from './rules/index';
import { validateComposition, listPatterns, loadPatternById } from './face-ui/compositionValidator';
import { safeParseFaceJsonV2 } from './schemas/face-v2.schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number | null;
  method: string;
  params?: any;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rpcOk(id: any, result: any) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

class UserfaceEngineMcpServer {
  private engine: EngineInstance;
  private cwd: string;
  private cwdReal: string;
  private packageRequire: ReturnType<typeof createRequire>;
  private specCache = new Map<string, { spec: any; mtime: number }>();
  private ruleEngine: RuleEngine;

  constructor() {
    this.cwd = process.cwd();
    this.cwdReal = this.toRealPath(this.cwd);
    this.packageRequire = createRequire(resolve(this.cwd, 'package.json'));

    const tryResolve = (mod: string): any => {
      try { return this.packageRequire(mod); } catch { return null; }
    };

    const opts: CreateEngineOptions = {
      React: tryResolve('react'),
      ReactDOMServer: tryResolve('react-dom/server'),
    };

    const Babel = tryResolve('@babel/standalone');
    if (Babel) opts.Babel = Babel;

    this.engine = createEngine(opts);
    this.ruleEngine = new RuleEngine();
    this.ruleEngine.loadPolicyPack(basePolicyPack);
  }

  // -------------------------------------------------------------------------
  // Path safety — prevent traversal outside cwd
  // -------------------------------------------------------------------------

  private assertSafePath(inputPath: string): string {
    const absPath = resolve(this.cwd, inputPath);
    const rel = relative(this.cwd, absPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path traversal detected: ${inputPath}`);
    }

    const realPath = this.toRealPath(absPath);
    const realRel = relative(this.cwdReal, realPath);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(`Path traversal detected: ${inputPath}`);
    }

    return realPath;
  }

  private toRealPath(inputPath: string): string {
    try {
      return realpathSync.native(inputPath);
    } catch {
      return resolve(inputPath);
    }
  }

  // -------------------------------------------------------------------------
  // Spec cache (mtime-based invalidation for long-running server)
  // -------------------------------------------------------------------------

  private async getSpec(inputPath: string) {
    const absPath = this.assertSafePath(inputPath);
    let mtime = 0;
    try {
      const stat = statSync(absPath);
      if (stat.isDirectory()) {
        const entries = readdirSync(absPath);
        const mtimes = entries.map(f => {
          try { return statSync(resolve(absPath, f)).mtimeMs; } catch { return 0; }
        });
        mtime = mtimes.length > 0 ? Math.max(...mtimes) : 0;
      } else {
        mtime = stat.mtimeMs;
      }
    } catch { /* fallback: no cache */ }

    const cached = this.specCache.get(absPath);
    if (cached && mtime > 0 && cached.mtime === mtime) {
      return cached.spec;
    }

    const { files, entry } = readComponentFiles(this.cwd, inputPath);
    const spec = await this.engine.analyzeComponent(files, { entryPath: entry });
    if (mtime > 0) {
      this.specCache.set(absPath, { spec, mtime });
    }
    return spec;
  }

  // -------------------------------------------------------------------------
  // Protocol
  // -------------------------------------------------------------------------

  async handle(req: JsonRpcRequest): Promise<any> {
    const id = req.id ?? null;
    const isNotification = !('id' in req);

    switch (req.method) {
      case 'initialize':
        return rpcOk(id, {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'userface-engine', version: '0.1.0' },
          capabilities: { tools: {} },
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'tools/list':
        return rpcOk(id, { tools: this.tools() });

      case 'tools/call':
        return this.handleToolCall(id, req.params?.name, req.params?.arguments || {});

      case 'ping':
        return rpcOk(id, { ok: true });

      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  }

  // -------------------------------------------------------------------------
  // Tools definition
  // -------------------------------------------------------------------------

  private tools(): McpTool[] {
    return [
      {
        name: 'component_analyze',
        description:
          'Analyze a React/Vue/Svelte component file or directory. Returns props, types, framework detection.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to component file or directory' },
          },
          required: ['path'],
        },
      },
      {
        name: 'component_render',
        description:
          'Render a component with given props using SSR. Returns HTML output.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to component' },
            props: { type: 'object', description: 'Props to render with (default: {})' },
          },
          required: ['path'],
        },
      },
      {
        name: 'component_states',
        description:
          'Generate all meaningful visual states for a component (one-at-a-time strategy). Returns named state entries with props.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to component' },
          },
          required: ['path'],
        },
      },
      {
        name: 'component_test',
        description:
          'Test a component or directory of components: renders every generated state via SSR. Returns pass/fail report.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to component or component directory' },
          },
          required: ['path'],
        },
      },
      {
        name: 'component_validate',
        description:
          'Validate a component against quality rules. Returns violations, scores, and fix suggestions. Use this before finalizing UI code.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to component' },
            mode: { type: 'string', enum: ['fast', 'standard', 'deep'], description: 'Validation depth (default: fast)' },
            budget: { type: 'string', enum: ['llm', 'compact', 'verbose'], description: 'Output verbosity (default: llm)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'component_list',
        description:
          'List all components under a directory with metadata: name, framework, props summary, face.json status. Use detail=true for full prop definitions.',
        inputSchema: {
          type: 'object',
          properties: {
            dir: { type: 'string', description: 'Directory to scan for components' },
            detail: { type: 'boolean', description: 'Include full props for each component (default: false)' },
          },
          required: ['dir'],
        },
      },
      {
        name: 'ui_materialize',
        description:
          'Materialize a face schema v1 JSON document into framework code (e.g. React JSX, Vue, HTML). Returns the generated code.',
        inputSchema: {
          type: 'object',
          properties: {
            doc: { type: 'object', description: 'The face schema v1 JSON document object' },
            componentName: { type: 'string', description: 'Name for the generated component (default: GeneratedComponent)' },
            framework: { type: 'string', enum: ['react', 'vue', 'html'], description: 'Target framework (default: react)' },
          },
          required: ['doc'],
        },
      },
      {
        name: 'composition_validate',
        description:
          'Validate a face composition document. Checks structural rules (nesting, interactive-in-interactive), contract compliance against component registry, $ref/$action resolution, and optional pattern matching (form, dashboard, crud-table).',
        inputSchema: {
          type: 'object',
          properties: {
            doc: { type: 'object', description: 'The face schema v1 JSON document to validate' },
            registryDir: { type: 'string', description: 'Directory to scan for component registry (for contract validation)' },
            registryManifestPath: { type: 'string', description: 'Project-relative or cwd-contained path to a default-private UF component registry manifest for opt-in public boundary validation' },
            enforceRegistryBoundary: { type: 'boolean', description: 'When true, only Face UI components and public UF manifest components pass the registry-boundary rule' },
            patterns: { type: 'array', items: { type: 'string' }, description: 'Pattern names to check against: form, dashboard, crud-table, settings, list-detail' },
            customPatternFiles: { type: 'array', items: { type: 'string' }, description: 'Project-relative or cwd-contained paths to custom *.pattern.json files to load alongside built-in patterns' },
            context: { type: 'object', description: 'Data context for $ref resolution verification' },
            actions: { type: 'array', items: { type: 'string' }, description: 'Available action handler names for $action verification' },
            budget: { type: 'string', enum: ['llm', 'compact', 'verbose'], description: 'Output verbosity (default: verbose)' },
          },
          required: ['doc'],
        },
      },
      // ----- v2 tools -----
      {
        name: 'component_composition_guide',
        description:
          'Get a composition guide for a component from face.json v2. Returns required/recommended parts, part tree, keyboard shortcuts, ARIA requirements, and example JSX structure. Ideal for AI code generation.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Component name (e.g. "Dialog", "Tabs", "Select")' },
            dir: { type: 'string', description: 'Component directory (default: ui/)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'component_contract',
        description:
          'Get the full face.json v2 contract for a component, including behavior, keyboard, aria, composition, and platform sections.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Component name (e.g. "Dialog", "Tabs")' },
            dir: { type: 'string', description: 'Component directory (default: ui/)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'design_tokens',
        description:
          'Get available CSS design tokens from the token system. Returns all custom properties organized by category (colors, spacing, typography, etc.).',
        inputSchema: {
          type: 'object',
          properties: {
            category: { type: 'string', description: 'Filter by category: colors, spacing, typography, radius, shadows, sizes, all (default: all)' },
          },
        },
      },
      {
        name: 'library_guide',
        description:
          'Get the FaceUI operating manual (docs.md). Use section="constitution" for core rules only, section="reference" for component reference, section="component:<Name>" for a specific component, or section="all" for everything.',
        inputSchema: {
          type: 'object',
          properties: {
            section: { type: 'string', description: 'Filter: "all", "constitution", "reference", "component:<Name>"' },
          },
        },
      },
      {
        name: 'pattern_list',
        description:
          'List all available composition patterns with id, name, purpose, and component selection counts. Use this to discover patterns before composing UI.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'pattern_get',
        description:
          'Get a full pattern definition by id. Returns zones, layout, requires, forbids, componentSelection, skeleton, variants, and examples. Use this to understand how to compose a specific UI pattern.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Pattern id (e.g. "form", "dashboard", "crud-table", "settings", "list-detail")' },
          },
          required: ['id'],
        },
      },
      {
        name: 'assembly_flow',
        description:
          'Get the FaceUI assembly pipeline: how to build UI step by step. Returns the recommended flow from intent to validated output, quality gates, anti-patterns, and MCP tools for each step.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Tool dispatch
  // -------------------------------------------------------------------------

  private async handleToolCall(id: any, toolName: string, args: any) {
    try {
      let result: any;
      switch (toolName) {
        case 'component_analyze':
          result = await this.toolAnalyze(args.path);
          break;
        case 'component_render':
          result = await this.toolRender(args.path, args.props || {});
          break;
        case 'component_states':
          result = await this.toolStates(args.path);
          break;
        case 'component_test':
          result = await this.toolTest(args.path);
          break;
        case 'component_validate':
          result = await this.toolValidate(args.path, args.mode, args.budget);
          break;
        case 'component_list':
          result = await this.toolList(args.dir, args.detail);
          break;
        case 'ui_materialize':
          result = await this.toolMaterialize(args.doc, args.componentName, args.framework);
          break;
        case 'composition_validate':
          result = await this.toolCompositionValidate(args.doc, args.registryDir, args.patterns, args.context, args.actions, args.budget, args.customPatternFiles, args.registryManifestPath, args.enforceRegistryBoundary);
          break;
        case 'component_composition_guide':
          result = await this.toolCompositionGuide(args.name, args.dir);
          break;
        case 'component_contract':
          result = await this.toolComponentContract(args.name, args.dir);
          break;
        case 'design_tokens':
          result = await this.toolDesignTokens(args.category);
          break;
        case 'library_guide':
          result = await this.toolLibraryGuide(args.section);
          break;
        case 'pattern_list':
          result = this.toolPatternList();
          break;
        case 'pattern_get':
          result = this.toolPatternGet(args.id);
          break;
        case 'assembly_flow':
          result = await this.toolAssemblyFlow();
          break;
        default:
          return rpcError(id, -32601, `Unknown tool: ${toolName}`);
      }
      return rpcOk(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (e: any) {
      return rpcOk(id, {
        content: [{ type: 'text', text: `Error: ${e?.message || e}` }],
        isError: true,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Tool implementations
  // -------------------------------------------------------------------------

  private async toolAnalyze(path: string) {
    const spec = await this.getSpec(path);
    return {
      name: spec.name,
      framework: spec.framework,
      props: spec.props,
      diagnostics: spec.diagnostics,
    };
  }

  private async toolRender(path: string, props: any) {
    const spec = await this.getSpec(path);
    const result = await this.engine.renderFromSpec(spec.name, props, 'ssr');
    return result;
  }

  private async toolStates(path: string) {
    const spec = await this.getSpec(path);
    const states = this.engine.generateStates(spec.props);
    return { component: spec.name, states };
  }

  private async toolTest(path: string) {
    const absPath = this.assertSafePath(path);
    let components: string[];
    try {
      // Try as directory of components
      components = discoverComponents(absPath);
    } catch {
      // Treat as single component
      components = [absPath];
    }

    // If discover returned empty but path itself is a component dir
    if (components.length === 0) {
      components = [absPath];
    }

    const report = { total: 0, passed: 0, failed: 0, results: [] as any[] };

    for (const compDir of components) {
      try {
        const spec = await this.getSpec(compDir);
        const states = this.engine.generateStates(spec.props);

        for (const state of states) {
          report.total++;
          try {
            await this.engine.renderFromSpec(spec.name, state.props, 'ssr');
            report.passed++;
            report.results.push({ component: spec.name, state: state.name, status: 'pass' });
          } catch (e: any) {
            report.failed++;
            report.results.push({
              component: spec.name,
              state: state.name,
              status: 'fail',
              error: String(e?.message || e),
            });
          }
        }
      } catch (e: any) {
        report.total++;
        report.failed++;
        report.results.push({
          component: basename(compDir),
          state: 'analyze',
          status: 'error',
          error: String(e?.message || e),
        });
      }
    }

    return report;
  }

  private async toolValidate(path: string, mode?: string, budget?: string) {
    const spec = await this.getSpec(path);

    let code: string | undefined;
    try {
      const { files, entry } = readComponentFiles(this.cwd, path);
      code = files.find(f => f.name === entry)?.content;
    } catch { /* best effort */ }

    // Load face.json so v2 rules (hasFaceJson: true) can fire
    const faceJson = this.loadFaceJson(spec.name);

    const report = this.ruleEngine.validate(spec, {
      mode: (mode as ValidateMode) || 'fast',
      budget: (budget as BudgetMode) || 'llm',
      code,
      faceJson,
    });

    return report;
  }

  private async toolList(dir: string, detail?: boolean) {
    const absDir = this.assertSafePath(dir);
    const index = scanRegistry(absDir);
    return {
      total: index.components.length,
      durationMs: index.durationMs,
      components: index.components.map(c => ({
        name: c.name,
        path: relative(this.cwd, c.path),
        entry: c.entry,
        framework: c.framework,
        hasFaceJson: c.hasFaceJson,
        propsCount: c.props.length,
        statesCount: c.statesCount,
        ...(detail ? { props: c.props } : {}),
        ...(c.diagnostics.length > 0 ? { diagnostics: c.diagnostics } : {}),
      })),
    };
  }

  private async toolMaterialize(doc: any, componentName?: string, framework?: 'react'|'vue'|'html') {
    const { generateCode } = await import('./face-ui/codegen');
    return generateCode(doc, { componentName, framework: framework || 'react' });
  }

  private async toolCompositionValidate(
    doc: any,
    registryDir?: string,
    patterns?: string[],
    context?: Record<string, any>,
    actions?: string[],
    budget?: string,
    customPatternFiles?: string[],
    registryManifestPath?: string,
    enforceRegistryBoundary?: boolean,
  ) {
    let registry: import('./registry').RegistryEntry[] | undefined;
    if (registryDir) {
      const absDir = this.assertSafePath(registryDir);
      const index = scanRegistry(absDir);
      registry = index.components;
    }

    const safeRegistryManifestPath = registryManifestPath
      ? this.assertSafePath(registryManifestPath)
      : undefined;

    // Validate custom pattern file paths against path traversal
    const safePatternFiles = customPatternFiles
      ? customPatternFiles.map((fp: string) => this.assertSafePath(fp))
      : undefined;

    const parsedDoc = typeof doc === 'string' ? JSON.parse(doc) : doc;
    return validateComposition(parsedDoc, {
      registry,
      registryManifestPath: safeRegistryManifestPath,
      patterns,
      customPatternFiles: safePatternFiles,
      context,
      actions,
      enforceRegistryBoundary,
      budget: (budget as BudgetMode) || 'verbose',
    });
  }

  // -------------------------------------------------------------------------
  // v2 tool implementations
  // -------------------------------------------------------------------------

  private async toolCompositionGuide(name: string, dir?: string) {
    const faceJson = this.loadFaceJson(name, dir);
    if (!faceJson) {
      return { error: `No face.json found for component "${name}"` };
    }

    const composition = faceJson.composition;
    const parts = composition?.parts || {};

    // Build part tree — skip root (it has no parent, becomes tree root)
    const partTree: Record<string, string[]> = {};
    for (const [partName, partDef] of Object.entries(parts) as [string, any][]) {
      if (!partDef.parent || partDef.slot === 'root' || partDef.slot === 'provider') continue;
      const parent = partDef.parent;
      if (!partTree[parent]) partTree[parent] = [];
      partTree[parent].push(partName);
    }

    // Generate example JSX
    const exampleLines: string[] = [];
    const indent = (depth: number) => '  '.repeat(depth);
    const renderTree = (parentName: string, depth: number) => {
      const children = partTree[parentName] || [];
      for (const child of children) {
        const hasChildren = partTree[child]?.length > 0;
        const partDef = parts[child] as any;
        const isMultiple = partDef?.multiple;
        if (hasChildren) {
          exampleLines.push(`${indent(depth)}<${child}${isMultiple ? ' /* multiple */' : ''}>`);
          renderTree(child, depth + 1);
          exampleLines.push(`${indent(depth)}</${child}>`);
        } else {
          const selfClose = ['trigger', 'close', 'separator', 'shortcut', 'indicator'].includes(partDef?.slot || '');
          if (selfClose) {
            exampleLines.push(`${indent(depth)}<${child}${isMultiple ? ' /* multiple */' : ''} />`);
          } else {
            exampleLines.push(`${indent(depth)}<${child}${isMultiple ? ' /* multiple */' : ''}>...</${child}>`);
          }
        }
      }
    };

    // Find root part
    const rootParts = Object.entries(parts).filter(([_, def]: [string, any]) => !def.parent || def.slot === 'root' || def.slot === 'provider');
    const rootName = rootParts.length > 0 ? rootParts[0][0] : name;
    exampleLines.push(`<${rootName}>`);
    renderTree(rootName, 1);
    exampleLines.push(`</${rootName}>`);

    return {
      name: faceJson.name,
      requiredParts: composition?.required || [],
      recommendedParts: composition?.recommended || [],
      partTree,
      exampleUsage: exampleLines.join('\n'),
      keyboard: faceJson.keyboard || {},
      ariaRequirements: faceJson.aria || {},
      behavior: faceJson.behavior || {},
      platform: faceJson.platform || {},
      usage: faceJson.usage || {},
    };
  }

  private async toolComponentContract(name: string, dir?: string) {
    const faceJson = this.loadFaceJson(name, dir);
    if (!faceJson) {
      return { error: `No face.json found for component "${name}"` };
    }
    return faceJson;
  }

  private resolvePackagePath(subpath: string): string | null {
    const packageName = '@userface/face-ui-react';
    const candidates: string[] = [];

    // Published assets are exposed through package exports, e.g.
    // ./assets/* -> ./dist/esm/assets/*.
    if (subpath.startsWith('assets/')) {
      try { candidates.push(this.packageRequire.resolve(`${packageName}/${subpath}`)); } catch {}
    }

    // Monorepo source checkout.
    candidates.push(resolve(this.cwd, 'packages/face-ui-react', subpath));

    // Installed package root, including dist asset layouts created by build-npm.cjs.
    try {
      const packageRoot = dirname(this.packageRequire.resolve(`${packageName}/package.json`));
      candidates.push(
        resolve(packageRoot, subpath),
        resolve(packageRoot, 'dist/esm', subpath),
        resolve(packageRoot, 'dist/cjs', subpath),
      );
    } catch {}

    // Legacy cwd-relative node_modules fallback.
    candidates.push(
      resolve(this.cwd, 'node_modules/@userface/face-ui-react', subpath),
      resolve(this.cwd, 'node_modules/@userface/face-ui-react/dist/esm', subpath),
      resolve(this.cwd, 'node_modules/@userface/face-ui-react/dist/cjs', subpath),
    );

    for (const candidate of candidates) {
      try { statSync(candidate); return candidate; } catch {}
    }
    return null;
  }

  private async toolDesignTokens(category?: string) {
    const tokensPath = this.resolvePackagePath('assets/styles/tokens.css');
    if (!tokensPath) {
      return { error: 'Could not find @userface/face-ui-react assets/styles/tokens.css via package resolution, monorepo packages/face-ui-react, or node_modules. Install @userface/face-ui-react or run from the monorepo root.' };
    }
    let content: string;
    try {
      content = readFileSync(tokensPath, 'utf-8');
    } catch {
      return { error: `Could not read @userface/face-ui-react tokens.css at ${tokensPath}. Check file permissions or reinstall @userface/face-ui-react.` };
    }

    // Parse CSS custom properties
    const tokens: Record<string, Record<string, string>> = {
      colors: {},
      spacing: {},
      typography: {},
      radius: {},
      shadows: {},
      sizes: {},
      other: {},
    };

    const propRegex = /--uf-([^:]+):\s*([^;]+);/g;
    let match;
    while ((match = propRegex.exec(content)) !== null) {
      const name = `--uf-${match[1]}`;
      const value = match[2].trim();
      const key = match[1];

      if (key.startsWith('bg') || key.startsWith('fg') || key.startsWith('muted') ||
          key.startsWith('accent') || key.startsWith('destructive') || key.startsWith('border') ||
          key.startsWith('ring') || key.startsWith('overlay') || key.startsWith('card') ||
          key.startsWith('input') || key.startsWith('chart')) {
        tokens.colors[name] = value;
      } else if (key.startsWith('space') || key.startsWith('gap')) {
        tokens.spacing[name] = value;
      } else if (key.startsWith('text') || key.startsWith('font') || key.startsWith('weight') ||
                 key.startsWith('leading') || key.startsWith('tracking')) {
        tokens.typography[name] = value;
      } else if (key.startsWith('radius')) {
        tokens.radius[name] = value;
      } else if (key.startsWith('shadow')) {
        tokens.shadows[name] = value;
      } else if (key.startsWith('h-') || key.startsWith('w-') || key.startsWith('dialog') ||
                 key.startsWith('sheet') || key.startsWith('sidebar') || key.startsWith('popover') ||
                 key.startsWith('menu') || key.startsWith('command') || key.startsWith('switch') ||
                 key.startsWith('check')) {
        tokens.sizes[name] = value;
      } else {
        tokens.other[name] = value;
      }
    }

    if (category && category !== 'all' && tokens[category]) {
      return { category, tokens: tokens[category] };
    }

    return { tokens };
  }

  // -------------------------------------------------------------------------
  // assembly_flow — return the assembly pipeline document
  // -------------------------------------------------------------------------

  private async toolAssemblyFlow() {
    // Try monorepo path first, then package path
    const candidates = [
      resolve(this.cwd, 'packages/engine/assembly-flow.md'),
      resolve(this.cwd, 'assembly-flow.md'),
    ];

    for (const filePath of candidates) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        return { content };
      } catch {
        // try next
      }
    }

    return { error: 'Could not find assembly-flow.md. Ensure the engine package is available.' };
  }

  // -------------------------------------------------------------------------
  // pattern_list / pattern_get — composition pattern tools
  // -------------------------------------------------------------------------

  private toolPatternList() {
    const patterns = listPatterns();
    if (patterns.length === 0) {
      return { error: 'No patterns found. Ensure pattern files exist in the patterns directory.' };
    }
    return { patterns };
  }

  private toolPatternGet(id: string) {
    const pattern = loadPatternById(id);
    if (!pattern) {
      const available = listPatterns().map(p => p.id);
      return { error: `Pattern "${id}" not found. Available: ${available.join(', ')}` };
    }
    return pattern;
  }

  // -------------------------------------------------------------------------
  // library_guide — return docs.md content with optional filtering
  // -------------------------------------------------------------------------

  private async toolLibraryGuide(section?: string) {
    const docsPath = this.resolvePackagePath('docs.md');
    if (!docsPath) {
      return { error: 'Could not find docs.md. Ensure @userface/face-ui-react is installed or run from monorepo root.' };
    }

    let content: string;
    try {
      content = readFileSync(docsPath, 'utf-8');
    } catch {
      return { error: 'Could not read docs.md.' };
    }

    const filter = (section || 'all').toLowerCase().trim();

    // Split on the constitution/reference separator (HTML comment marker)
    const separatorPattern = /<!-- SEPARATOR:CONSTITUTION_END -->/m;
    const separatorMatch = content.match(separatorPattern);

    if (filter === 'all') {
      return { section: 'all', content };
    }

    if (filter === 'constitution') {
      if (separatorMatch && separatorMatch.index !== undefined) {
        // Everything before the separator marker, trim trailing ---
        let constitutionEnd = separatorMatch.index;
        const beforeSep = content.lastIndexOf('\n---\n', constitutionEnd);
        if (beforeSep > 0 && constitutionEnd - beforeSep < 10) constitutionEnd = beforeSep;
        return { section: 'constitution', content: content.slice(0, constitutionEnd).trim() };
      }
      // Fallback: return sections 1-2
      const sec3 = content.indexOf('\n## 3.');
      return { section: 'constitution', content: content.slice(0, sec3 > 0 ? sec3 : undefined).trim() };
    }

    if (filter === 'reference') {
      // Reference starts at ## 3. — skip the separator block entirely
      const refStart = content.indexOf('\n## 3.');
      return { section: 'reference', content: refStart > 0 ? content.slice(refStart).trim() : content };
    }

    if (filter.startsWith('component:')) {
      const compName = filter.slice('component:'.length).trim();
      // Escape regex metacharacters in component name to prevent ReDoS / SyntaxError
      const escapedName = compName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Find the component section in the reference (### ComponentName or #### ComponentName)
      const patterns = [
        new RegExp(`^###+ ${escapedName}\\b`, 'im'),
        new RegExp(`^\\| \\*\\*${escapedName}\\*\\*`, 'im'),
      ];

      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match.index !== undefined) {
          // Extract until next same-level heading or end
          const startIdx = content.lastIndexOf('\n', match.index);
          const headingLevel = (match[0].match(/^#+/) || ['###'])[0];
          const nextSectionRegex = new RegExp(`^${headingLevel} (?!${escapedName})`, 'm');
          const rest = content.slice(match.index + match[0].length);
          const nextMatch = rest.match(nextSectionRegex);
          const endIdx = nextMatch && nextMatch.index !== undefined
            ? match.index + match[0].length + nextMatch.index
            : match.index + match[0].length + 2000; // cap at ~2000 chars if no boundary found
          return { section: `component:${compName}`, content: content.slice(startIdx, endIdx).trim() };
        }
      }

      return { section: `component:${compName}`, error: `Component "${compName}" not found in docs.md` };
    }

    return { error: `Unknown section filter: "${section}". Use "all", "constitution", "reference", or "component:<Name>".` };
  }

  // -------------------------------------------------------------------------
  // Shared helper: load face.json for a component by name
  // -------------------------------------------------------------------------

  private loadFaceJson(name: string, dir?: string): any {
    const searchDirs: string[] = [];
    if (dir) {
      searchDirs.push(resolve(this.cwd, dir));
    } else {
      // 1. Monorepo path
      searchDirs.push(resolve(this.cwd, 'packages/face-ui-react'));
      // 2. node_modules path (for external consumers)
      searchDirs.push(resolve(this.cwd, 'node_modules/@userface/face-ui-react'));
    }
    const candidates: string[] = [];
    for (const searchDir of searchDirs) {
      candidates.push(...getComponentFaceJsonFileNames(name).map((fileName) => resolve(searchDir, name, fileName)));
    }
    try {
      for (const filePath of candidates) {
        try {
          const raw = readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(raw);
          // Validate through v2 schema (v2 fields are optional, so v1-only files pass)
          const result = safeParseFaceJsonV2(parsed);
          return result.success ? result.data : parsed;
        } catch {
          // try next candidate
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Transport: line-delimited JSON over stdin/stdout
// ---------------------------------------------------------------------------

export function startServer(config: any = {}): void {
  // Redirect console to stderr so stdout stays clean for JSON-RPC
  console.log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');
  console.warn = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

  const server = new UserfaceEngineMcpServer();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  // Track in-flight async handlers to avoid premature exit on stdin close
  let pendingOps = 0;
  let stdinClosed = false;

  function exitIfDone() {
    if (stdinClosed && pendingOps === 0) process.exit(0);
  }

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    pendingOps++;
    (async () => {
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const res = await server.handle(req);
        if (res !== null) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch {
        process.stdout.write(JSON.stringify(rpcError(null, -32700, 'Parse error')) + '\n');
      } finally {
        pendingOps--;
        exitIfDone();
      }
    })();
  });

  rl.on('close', () => {
    stdinClosed = true;
    exitIfDone();
  });

  process.stderr.write('[userface-engine] MCP server ready (stdin/stdout)\n');
}
