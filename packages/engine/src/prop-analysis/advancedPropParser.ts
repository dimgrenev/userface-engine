/**
 * Advanced TypeScript AST Parser using ts-morph
 * Извлекает prop definitions из TypeScript/TSX/Vue/Svelte с полной поддержкой:
 * - Union types, enums, type aliases
 * - JSDoc комментарии (@control, @min, @max, @step, @autocomplete, @multiline)
 * - Import resolution для type aliases
 * - Framework-specific syntax (React, Vue, Svelte)
 */

import { Project, SourceFile, InterfaceDeclaration, TypeAliasDeclaration, EnumDeclaration, Node, SyntaxKind, ts, type Type, type ObjectLiteralExpression } from 'ts-morph';
import path from 'path';
export type PropAnalysisFile = { name?: string; content: string };
type VFSFile = PropAnalysisFile;
export interface PropAnalysisTarget {
  fileName: string;
  framework?: 'react' | 'vue' | 'svelte';
  exportName?: string | null;
  /** Explicit selection overrides filename inference. Omit for legacy behavior. */
  format?: 'source' | 'story';
}

export interface PropAnalysisDiagnostic { reason: string; message: string; details: Record<string, unknown> }
export interface AdvancedPropParserOptions {
  root?: string;
  /** Captured TypeScript paths, relative to root or absolute; never read from disk. */
  paths?: Readonly<Record<string, readonly string[]>>;
  /** Legacy host integration only. The default is an isolated in-memory filesystem. */
  allowFileSystem?: boolean;
  tsConfigFilePath?: string;
  onDiagnostic?: (diagnostic: PropAnalysisDiagnostic) => void;
  onDebug?: (event: string, details: Record<string, unknown>) => void;
}

export interface ParsedProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  description?: string;
  jsdoc?: {
    control?: string;
    min?: number;
    max?: number;
    step?: number;
    autocomplete?: string;
    multiline?: boolean;
    example?: string;
  };
  // Enriched metadata
  options?: Array<string | number | boolean>; // для union types (closed set)
  suggestions?: Array<string | number | boolean>; // для mixed unions (open-ended with known values)
  enumValues?: Record<string, string | number>; // для enums
  isArray?: boolean;
  arrayItemType?: string;
  isObject?: boolean;
  objectShape?: Record<string, string>;
  /** True when the prop is inherited from React/HTML intrinsic types (node_modules). */
  isInherited?: boolean;
}

export type PropParseResult =
  | { ok: true; props: ParsedProp[]; diagnostics: PropAnalysisDiagnostic[] }
  | { ok: false; error: { reason: string; message: string }; diagnostics: PropAnalysisDiagnostic[] };


interface TypeCache {
  aliases: Map<string, string>; // typeName -> resolved type
  enums: Map<string, Record<string, string | number>>;
  interfaces: Map<string, ParsedProp[]>;
}

type PropDefaults = Record<string, unknown>;
type JsDocTags = ParsedProp['jsdoc'];
type BindingElementLike = {
  getName?: () => string;
  getInitializer?: () => Node | undefined;
};
type BindingPatternLike = {
  getElements?: () => BindingElementLike[];
};
type FunctionLike = {
  getParameters?: () => Array<{
    getNameNode?: () => Node;
    getName?: () => string;
  }>;
  getBody?: () => Node | undefined;
};
type AdvancedPropParserRecoverableMeta = Record<string, unknown>;

class PropParseFailure extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

function defaultValueFrom(defaults: PropDefaults | undefined, name: string): unknown {
  return defaults && Object.prototype.hasOwnProperty.call(defaults, name)
    ? defaults[name]
    : undefined;
}

function advancedPropParserErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return 'Advanced prop parser recoverable failure';
}

/** Instance-owned analysis of source metadata; never executes project modules. */
export class AdvancedPropParser {
  private project: Project | null = null;
  private projectSnapshotKey: string | null = null;
  private cache: TypeCache = {
    aliases: new Map(),
    enums: new Map(),
    interfaces: new Map(),
  };
  private maxImportDepth = 5;
  private pathMap = new Map<string, string>();
  private capturedManifestPaths = new Set<string>();
  private readonly cwd: string;
  private readonly paths: Record<string, string[]> | undefined;
  private readonly recoverableKeys = new Set<string>();
  private activeResultDiagnostics: { items: PropAnalysisDiagnostic[]; keys: Set<string> } | null = null;
  constructor(private readonly options: AdvancedPropParserOptions = {}) {
    this.cwd = options.root ? path.resolve(options.root) : "/__userface_analysis__";
    this.paths = options.paths === undefined ? undefined
      : Object.fromEntries(Object.entries(options.paths).map(([name, targets]) => [name, targets.map(target => path.resolve(this.cwd, target))]));
  }

  dispose(): void {
    this.project = null;
    this.projectSnapshotKey = null;
    this.resultCache.clear();
    this.pathMap.clear();
    this.capturedManifestPaths.clear();
    this.recoverableKeys.clear();
    this.cleanup();
  }

  // Task 3.2: LRU result cache — avoids re-parsing unchanged files.
  private static readonly RESULT_CACHE_MAX = 64;
  private static readonly RESULT_CACHE_TTL = 60_000; // 60 seconds
  private resultCache = new Map<string, { snapshotKey: string; result: ParsedProp[]; diagnostics: PropAnalysisDiagnostic[]; ts: number }>();

  private captureSnapshot(vfs: Record<string, VFSFile>) {
    const entries = Object.keys(vfs).sort().map(key => [key, { content: vfs[key]?.content }] as const);
    return { files: Object.fromEntries(entries), key: JSON.stringify(entries) };
  }

  /**
   * Инициализация виртуального ts-morph проекта
   */
  private initProject(vfs: Record<string, VFSFile>, snapshotKey: string): void {
    // Only a complete in-memory snapshot is safe to reuse without consulting IO.
    if (this.project && !this.options.allowFileSystem && this.projectSnapshotKey === snapshotKey) return;
    // Task 3.2: Reuse existing Project to avoid expensive re-initialization.
    // Only create a new Project if one doesn't exist yet.
    if (!this.project) {
      try {
        this.project = new Project({
          tsConfigFilePath: this.options.allowFileSystem ? this.options.tsConfigFilePath : undefined,
          skipAddingFilesFromTsConfig: true,
          useInMemoryFileSystem: !this.options.allowFileSystem,
          compilerOptions: {
            target: 99, // ESNext
            ...(this.options.allowFileSystem ? {} : { moduleResolution: ts.ModuleResolutionKind.Bundler }),
            module: 99, // ESNext
            jsx: 2, // React
            allowJs: true,
            checkJs: false,
            strict: false,
            skipLibCheck: true,
            esModuleInterop: true,
            ...(this.paths === undefined ? {} : { paths: this.paths }),
          },
        });
      } catch (e) {
        // Fallback: in case tsconfig is unavailable, keep a minimal project.
        this.project = new Project({
          useInMemoryFileSystem: !this.options.allowFileSystem,
          compilerOptions: {
            target: 99,
            ...(this.options.allowFileSystem ? {} : { moduleResolution: ts.ModuleResolutionKind.Bundler }),
            module: 99,
            jsx: 2,
            allowJs: true,
            checkJs: false,
            strict: false,
            skipLibCheck: true,
            esModuleInterop: true,
            ...(this.paths === undefined ? {} : { paths: this.paths }),
          },
        });
      }
    } else {
      // Clear existing source files from the reused Project
      this.invokeAdvancedPropParserRecoverable('advancedPropParser.initProject.clearSourceFiles', () => {
        for (const sf of this.project?.getSourceFiles() || []) {
          this.project?.removeSourceFile(sf);
        }
      });
    }

    this.pathMap.clear();
    if (!this.options.allowFileSystem) {
      for (const manifest of this.capturedManifestPaths) this.project?.getFileSystem().deleteSync(manifest);
      this.capturedManifestPaths.clear();
    }

    // Добавляем все файлы из VFS в проект
    for (const [fileName, file] of Object.entries(vfs)) {
      try {
        const rel = String(fileName || '').replace(/\\/g, '/');
        if (!rel) continue;
        const abs = path.isAbsolute(rel) ? rel : path.join(this.cwd, rel);
        this.pathMap.set(rel, abs);
        if (!this.options.allowFileSystem && path.basename(abs) === 'package.json') {
          // TypeScript reads package export conditions through its filesystem,
          // independently of source files. This filesystem is instance-owned RAM.
          this.project?.getFileSystem().writeFileSync(abs, file.content);
          this.capturedManifestPaths.add(abs);
          continue;
        }
        this.project?.createSourceFile(abs, file.content, { overwrite: true });
      } catch (err) {
        this.debugAdvancedPropParser(`[AdvancedPropParser] failed to add file ${fileName}:`, err);
      }
    }
    this.projectSnapshotKey = snapshotKey;
  }

  /**
   * Основной метод парсинга
   */
  public parse(fileName: string, vfs: Record<string, VFSFile>, framework: 'react' | 'vue' | 'svelte' = 'react', exportName?: string | null): ParsedProp[] {
    const result = this.parseResult({ fileName, framework, exportName }, vfs);
    return result.ok ? result.props : [];
  }

  /** Analyze a catalog against one captured snapshot and one TypeScript project. */
  public parseMany(targets: readonly PropAnalysisTarget[], vfs: Record<string, VFSFile>): ParsedProp[][] {
    return this.parseManyResults(targets, vfs).map(result => result.ok ? result.props : []);
  }

  /** Analyze one selected component and distinguish a valid empty schema from hard failure. */
  public parseResult(target: PropAnalysisTarget, vfs: Record<string, VFSFile>): PropParseResult {
    return this.parseManyResults([target], vfs)[0];
  }

  /** Analyze a batch against one captured VFS; diagnostics belong to each target. */
  public parseManyResults(targets: readonly PropAnalysisTarget[], vfs: Record<string, VFSFile>): PropParseResult[] {
    const selections = targets.map(target => ({ ...target }));
    let snapshot: ReturnType<AdvancedPropParser['captureSnapshot']>;
    try {
      snapshot = this.captureSnapshot(vfs);
    } catch (error) {
      return selections.map(target => this.snapshotFailureResult(target, error));
    }
    return selections.map(target => this.parseSnapshotResult(target, snapshot.files, snapshot.key));
  }

  private snapshotFailureResult(target: PropAnalysisTarget, error: unknown): PropParseResult {
    const diagnostics: PropAnalysisDiagnostic[] = [];
    const previous = this.activeResultDiagnostics;
    this.activeResultDiagnostics = { items: diagnostics, keys: new Set() };
    try {
      this.reportAdvancedPropParserRecoverable('advancedPropParser.parse', error, { ...target });
    } finally {
      this.activeResultDiagnostics = previous;
      this.cleanup();
    }
    return { ok: false, error: { reason: 'parse-exception', message: advancedPropParserErrorMessage(error) }, diagnostics };
  }

  private snapshotAbsolutePath(fileName: string): string {
    const normalized = String(fileName || '').replace(/\\/g, '/');
    return path.isAbsolute(normalized) ? path.normalize(normalized) : path.join(this.cwd, normalized);
  }

  private parseSnapshotResult({ fileName, framework = 'react', exportName, format }: PropAnalysisTarget,
    vfs: Record<string, VFSFile>, snapshotKey: string): PropParseResult {
    const diagnostics: PropAnalysisDiagnostic[] = [];
    const previous = this.activeResultDiagnostics;
    this.activeResultDiagnostics = { items: diagnostics, keys: new Set() };
    try {
      if (format !== undefined && format !== 'source' && format !== 'story') {
        throw new PropParseFailure('invalid-format', `Unsupported prop analysis format: ${String(format)}`);
      }
      const abs = this.snapshotAbsolutePath(fileName);
      if (!Object.entries(vfs).some(([name, file]) =>
        this.snapshotAbsolutePath(name) === abs && typeof file?.content === 'string')) {
        throw new PropParseFailure('missing-entry', `Source file ${fileName} was not provided in the captured VFS`);
      }
      // Task 3.2: check result cache
      const cacheKey = JSON.stringify([fileName, framework, exportName ?? null, format ?? null]);
      const cached = this.resultCache.get(cacheKey);
      if (cached && cached.snapshotKey === snapshotKey && Date.now() - cached.ts < AdvancedPropParser.RESULT_CACHE_TTL) {
        this.debugAdvancedPropParser(`[AdvancedPropParser] cache hit for ${fileName} (${framework})`);
        return { ok: true, props: structuredClone(cached.result), diagnostics: structuredClone(cached.diagnostics) };
      }

      this.debugAdvancedPropParser(`[AdvancedPropParser] parsing ${fileName} (${framework})`);

      try { this.initProject(vfs, snapshotKey); }
      catch (error) {
        throw new PropParseFailure('project-unavailable', `Failed to initialize ts-morph project: ${advancedPropParserErrorMessage(error)}`);
      }
      if (!this.project) {
        throw new PropParseFailure('project-unavailable', 'Failed to initialize ts-morph project');
      }

      const rel = String(fileName || '').replace(/\\/g, '/');
      const sourceFile = this.project.getSourceFile(this.pathMap.get(rel) || abs);
      if (!sourceFile) {
        throw new PropParseFailure('project-unavailable', `Source file ${fileName} could not be added from the captured VFS`);
      }

      const isStory = format === 'story' || (format === undefined && !!exportName && /\.(stories|story)\.[cm]?[jt]sx?$/i.test(fileName));
      if (isStory && (!exportName || exportName === 'default' || !this.hasRuntimeExport(sourceFile, exportName))) {
        throw new PropParseFailure('missing-export', `Story analysis requires an existing named story export: ${exportName ?? '(missing)'}`);
      }
      if (!isStory && exportName && (
        framework === 'react' ? !this.hasRuntimeExport(sourceFile, exportName) : exportName !== 'default'
      )) {
        throw new PropParseFailure('missing-export', `Source analysis requires an existing component export: ${exportName}`);
      }

      // Vue/Svelte script syntax has its own parser below; those source files
      // are not native TypeScript program entries for semantic diagnostics.
      const unresolvedImports = framework === 'react' ? this.reportUnresolvedImports(sourceFile) : new Set<string>();
      const unresolvedTypes = !isStory && framework === 'react'
        ? this.reportUnresolvedSelectedPropsTypes(sourceFile, exportName)
        : new Set<string>();

      // Сначала собираем все type aliases и enums для резолва
      this.buildTypeCache(sourceFile);

      let result: ParsedProp[];
      if (isStory) {
        result = this.parseStorybookProps(sourceFile, exportName!);
      } else {
        switch (framework) {
          case 'react':
            result = this.parseReactProps(sourceFile, exportName);
            break;
          case 'vue':
            result = this.parseVueProps(sourceFile);
            break;
          case 'svelte':
            result = this.parseSvelteProps(sourceFile);
            break;
          default:
            result = this.parseReactProps(sourceFile, exportName);
        }
      }

      if (!isStory && framework === 'react' && result.length === 0) {
        if (diagnostics.some(item => item.reason === 'advancedPropParser.react.typeChecker')) {
          throw new PropParseFailure('parse-exception', `Could not determine props for ${exportName || fileName}: type checker failed`);
        }
        if (this.selectedPropsDependOnNames(sourceFile, exportName, unresolvedImports)) {
          throw new PropParseFailure('parse-exception', `Could not determine props for ${exportName || fileName}: imported props type is unresolved`);
        }
        if (unresolvedTypes.size > 0) {
          throw new PropParseFailure('parse-exception', `Could not determine props for ${exportName || fileName}: props type is unresolved`);
        }
      }

      // Clone before caching: clone failure is a hard failure, never a cached empty result.
      const props = structuredClone(result);
      const resultDiagnostics = structuredClone(diagnostics);
      // Task 3.2: store successful results only (evict oldest if over limit).
      this.resultCache.set(cacheKey, { snapshotKey, result, diagnostics, ts: Date.now() });
      if (this.resultCache.size > AdvancedPropParser.RESULT_CACHE_MAX) {
        const oldest = this.resultCache.keys().next().value;
        if (oldest !== undefined) this.resultCache.delete(oldest);
      }

      return { ok: true, props, diagnostics: resultDiagnostics };
    } catch (error) {
      this.reportAdvancedPropParserRecoverable('advancedPropParser.parse', error, { fileName, framework, exportName, format });
      return { ok: false, error: {
        reason: error instanceof PropParseFailure ? error.reason : 'parse-exception',
        message: advancedPropParserErrorMessage(error),
      }, diagnostics };
    } finally {
      // Очищаем type cache после парсинга (Project is preserved for reuse)
      this.cleanup();
      this.activeResultDiagnostics = previous;
    }
  }

  private hasRuntimeExport(sourceFile: SourceFile, exportName: string): boolean {
    const symbol = sourceFile.getExportSymbols().find(item => item.getName() === exportName);
    if (!symbol) return false;
    for (const declaration of symbol.getDeclarations()) {
      if (Node.isExportSpecifier(declaration) && (
        declaration.isTypeOnly() || declaration.getFirstAncestorByKind(SyntaxKind.ExportDeclaration)?.isTypeOnly()
      )) return false;
    }
    const target = symbol.getAliasedSymbol() || symbol;
    return !!(target.getFlags() & ts.SymbolFlags.Value);
  }

  private reportUnresolvedImports(sourceFile: SourceFile): Set<string> {
    const unresolvedNames = new Set<string>();
    if (!this.project) return unresolvedNames;
    const imports = sourceFile.getImportDeclarations().filter(declaration => {
      const moduleName = declaration.getModuleSpecifierValue();
      const typeOnly = !!declaration.getImportClause()?.isTypeOnly()
        || declaration.getNamedImports().some(specifier => specifier.isTypeOnly());
      // Bundlers resolve these runtime assets without TypeScript declarations.
      // A TS2307 here is not evidence that the selected props type is unavailable.
      if (!typeOnly && /\.(?:css|scss|sass|less|styl|pcss|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)(?:[?#].*)?$/i.test(moduleName)) return false;
      return moduleName.startsWith('.') || typeOnly;
    });
    if (imports.length === 0) return unresolvedNames;
    const importRanges = imports.map(declaration => ({
      start: declaration.getStart(), end: declaration.getEnd(), moduleName: declaration.getModuleSpecifierValue(), declaration,
    }));
    for (const diagnostic of sourceFile.getPreEmitDiagnostics()) {
      if (![2305, 2307, 2614, 2724].includes(diagnostic.getCode())) continue;
      if (diagnostic.getSourceFile()?.getFilePath() !== sourceFile.getFilePath()) continue;
      const start = diagnostic.getStart();
      const match = importRanges.find(item => start !== undefined && item.start <= start && start < item.end);
      if (!match) continue;
      const selectedSpecifier = match.declaration.getNamedImports().find(item =>
        start !== undefined && item.getStart() <= start && start < item.getEnd());
      const importedNames = selectedSpecifier
        ? [selectedSpecifier.getAliasNode()?.getText() || selectedSpecifier.getName()]
        : [
          match.declaration.getDefaultImport()?.getText(),
          match.declaration.getNamespaceImport()?.getText(),
          ...match.declaration.getNamedImports().map(item => item.getAliasNode()?.getText() || item.getName()),
        ].filter((name): name is string => !!name);
      for (const name of importedNames) unresolvedNames.add(name);
      this.reportAdvancedPropParserRecoverable('advancedPropParser.type.unresolvedImport',
        new Error(String(diagnostic.getMessageText())), {
          fileName: sourceFile.getFilePath(), moduleName: match.moduleName, compilerCode: diagnostic.getCode(), importedNames,
        });
    }
    return unresolvedNames;
  }

  private reportUnresolvedSelectedPropsTypes(sourceFile: SourceFile, exportName: string | null | undefined): Set<string> {
    const unresolvedNames = new Set<string>();
    if (!this.project) return unresolvedNames;
    const content = sourceFile.getFullText();
    for (const diagnostic of sourceFile.getPreEmitDiagnostics()) {
      if (diagnostic.getCode() !== 2304 || diagnostic.getSourceFile()?.getFilePath() !== sourceFile.getFilePath()) continue;
      const start = diagnostic.getStart();
      const length = diagnostic.getLength();
      if (start === undefined || length === undefined) continue;
      const name = content.slice(start, start + length);
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (!this.selectedPropsDependOnNames(sourceFile, exportName, new Set([name]))) continue;
      unresolvedNames.add(name);
      this.reportAdvancedPropParserRecoverable('advancedPropParser.type.unresolvedType',
        new Error(String(diagnostic.getMessageText())), {
          fileName: sourceFile.getFilePath(), typeName: name, compilerCode: diagnostic.getCode(),
        });
    }
    return unresolvedNames;
  }

  private selectedPropsDependOnNames(sourceFile: SourceFile, exportName: string | null | undefined,
    unresolvedNames: ReadonlySet<string>): boolean {
    if (unresolvedNames.size === 0) return false;
    const selected = this.resolveReactComponentNode(sourceFile, exportName);
    if (!selected) return false;
    const typeTexts: string[] = [];
    const addFunctionType = (node: Node) => {
      if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        const typeNode = node.getParameters()[0]?.getTypeNode();
        if (typeNode) typeTexts.push(typeNode.getText());
      }
    };
    addFunctionType(selected);
    if (Node.isVariableDeclaration(selected)) {
      const declaredType = selected.getTypeNode();
      if (declaredType) typeTexts.push(declaredType.getText());
      const initializer = selected.getInitializer();
      if (initializer) {
        addFunctionType(initializer);
        if (Node.isCallExpression(initializer)) {
          typeTexts.push(...initializer.getTypeArguments().map(argument => argument.getText()));
          for (const argument of initializer.getArguments()) addFunctionType(argument);
        }
      }
    }
    if (typeTexts.length === 0) return false;
    const mentions = (value: string, name: string) =>
      new RegExp(`(?:^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\w$])`).test(value);
    let expanded = typeTexts.join(' ');
    const localTypes = [...sourceFile.getTypeAliases(), ...sourceFile.getInterfaces()];
    const visited = new Set<string>();
    for (let depth = 0; depth < 5; depth++) {
      let added = false;
      for (const declaration of localTypes) {
        const name = declaration.getName();
        if (visited.has(name) || !mentions(expanded, name)) continue;
        visited.add(name);
        expanded += ` ${declaration.getText()}`;
        added = true;
      }
      if (!added) break;
    }
    return [...unresolvedNames].some(name => mentions(expanded, name));
  }

  /**
   * Собираем кеш типов (aliases, enums, interfaces)
   */
  private buildTypeCache(sourceFile: SourceFile): void {
    // Type aliases
    sourceFile.getTypeAliases().forEach((alias) => {
      const name = alias.getName();
      const typeNode = alias.getTypeNode();
      if (typeNode) {
        this.cache.aliases.set(name, typeNode.getText());
      }
    });

    // Enums
    sourceFile.getEnums().forEach((enumDecl) => {
      const name = enumDecl.getName();
      const values: Record<string, string | number> = {};
      let lastNumeric = -1;
      enumDecl.getMembers().forEach((member) => {
        const memberName = member.getName();
        const initializer = member.getInitializer();
        if (initializer) {
          const value = initializer.getText().replace(/['"]/g, '');
          const numVal = Number(value);
          if (!isNaN(numVal)) {
            values[memberName] = numVal;
            lastNumeric = numVal;
          } else {
            values[memberName] = value;
          }
        } else {
          // Enum без значения: автоинкремент от последнего числового
          lastNumeric++;
          values[memberName] = lastNumeric;
        }
      });
      this.cache.enums.set(name, values);
    });

    // Interfaces (для будущего резолва)
    sourceFile.getInterfaces().forEach((iface) => {
      const name = iface.getName();
      const props = this.extractPropsFromInterface(iface);
      this.cache.interfaces.set(name, props);
    });
  }

  /**
   * Парсинг React props (interface/type с Props в названии или FC generic)
   */
  private parseStorybookProps(sourceFile: SourceFile, exportName: string): ParsedProp[] {
    let unresolvedSpread = false;
    const resolveObject = (initial: Node | undefined, visiting = new Set<number>(),
      seen = new Set<Node>()): ObjectLiteralExpression | undefined => {
      let node = initial;
      while (node && !seen.has(node)) {
        seen.add(node);
        if (Node.isObjectLiteralExpression(node)) return node;
        if (Node.isVariableDeclaration(node)) node = node.getInitializer();
        else if (Node.isExportAssignment(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isParenthesizedExpression(node)) node = node.getExpression();
        else if (Node.isIdentifier(node)) node = node.getSymbol()?.getDeclarations()[0];
        else if (Node.isPropertyAccessExpression(node)) {
          const receiver = resolveObject(node.getExpression(), visiting, seen);
          node = objectValues(receiver, 'reference', visiting).get(node.getName());
        }
        else break;
      }
      return undefined;
    };
    const objectValues = (object: ReturnType<typeof resolveObject>, context: string,
      visiting = new Set<number>()): Map<string, Node> => {
      const values = new Map<string, Node>();
      if (!object) return values;
      const position = object.getStart();
      if (visiting.has(position) || visiting.size >= 32) {
        unresolvedSpread = true;
        this.reportAdvancedPropParserRecoverable('advancedPropParser.story.unresolvedSpread',
          new Error(`Cyclic or too deep ${context} object spread`), { fileName: sourceFile.getFilePath(), exportName });
        return values;
      }
      visiting.add(position);
      try {
        for (const property of object.getProperties()) {
          if (Node.isPropertyAssignment(property)) {
            const initializer = property.getInitializer();
            if (initializer) values.set(property.getName().replace(/^['"]|['"]$/g, ''), initializer);
          } else if (Node.isShorthandPropertyAssignment(property)) {
            values.set(property.getName(), property.getNameNode());
          } else if (Node.isSpreadAssignment(property)) {
            const expression = property.getExpression();
            const spread = resolveObject(expression, visiting);
            if (!spread || spread.getSourceFile().getFilePath() !== sourceFile.getFilePath()) {
              unresolvedSpread = true;
              this.reportAdvancedPropParserRecoverable('advancedPropParser.story.unresolvedSpread',
                new Error(`Cannot resolve ${context} object spread ${expression.getText()}`),
                { fileName: sourceFile.getFilePath(), exportName });
              continue;
            }
            for (const [name, value] of objectValues(spread, context, visiting)) values.set(name, value);
          }
        }
      } finally {
        visiting.delete(position);
      }
      return values;
    };
    const literal = (node: Node | undefined): unknown => {
      if (!node) return undefined;
      if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
      if (Node.isNumericLiteral(node)) return Number(node.getText());
      if (Node.isPrefixUnaryExpression(node)) {
        const operand = literal(node.getOperand());
        if (typeof operand === 'number') {
          if (node.getOperatorToken() === SyntaxKind.MinusToken) return -operand;
          if (node.getOperatorToken() === SyntaxKind.PlusToken) return operand;
        }
        return undefined;
      }
      if (node.getKind() === SyntaxKind.TrueKeyword) return true;
      if (node.getKind() === SyntaxKind.FalseKeyword) return false;
      if (node.getKind() === SyntaxKind.NullKeyword) return null;
      if (Node.isArrayLiteralExpression(node)) return node.getElements().map(literal);
      return undefined;
    };
    const propertyValue = (object: ReturnType<typeof resolveObject>, name: string, context: string): Node | undefined =>
      objectValues(object, context).get(name);
    const exports = sourceFile.getExportedDeclarations();
    const meta = resolveObject(exports.get('default')?.[0]);
    const storyDeclaration = exports.get(exportName)?.[0];
    const story = resolveObject(storyDeclaration);
    const props = new Map<string, ParsedProp>();
    const component = propertyValue(meta, 'component', 'meta');
    const parameter = component?.getType().getCallSignatures()[0]?.getParameters()[0];
    const declaration = parameter?.getDeclarations()[0];
    if (parameter && declaration && this.project) {
      const type = this.project.getTypeChecker().getTypeOfSymbolAtLocation(parameter, declaration);
      for (const prop of this.extractPropsFromType(type, declaration)) props.set(prop.name, prop);
    }
    const applyArgs = (args: ReturnType<typeof resolveObject>, context: string) => {
      for (const [name, value] of objectValues(args, context)) {
        const existing = props.get(name);
        props.set(name, { name, type: this.simplifyType(value?.getType().getText() || 'any'), required: false,
          ...existing, defaultValue: literal(value) });
      }
    };
    for (const [scope, annotation] of [['meta', meta], ['story', story]] as const) {
      applyArgs(resolveObject(propertyValue(annotation, 'args', scope)), `${scope}.args`);
      const argTypes = resolveObject(propertyValue(annotation, 'argTypes', scope));
      for (const [name, configValue] of objectValues(argTypes, `${scope}.argTypes`)) {
        const config = resolveObject(configValue);
        const options = literal(propertyValue(config, 'options', `${scope}.argTypes.${name}`));
        const control = propertyValue(config, 'control', `${scope}.argTypes.${name}`);
        const controlType = literal(control) || literal(propertyValue(resolveObject(control), 'type', `${scope}.argTypes.${name}.control`));
        const existing = props.get(name);
        props.set(name, { name, type: typeof controlType === 'string' ? controlType : 'any', required: false, ...existing,
          ...(Array.isArray(options) ? { options: options.filter((v): v is string | number | boolean =>
            typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') } : {}),
          ...(typeof controlType === 'string' ? { jsdoc: { ...existing?.jsdoc, control: controlType } } : {}) });
      }
    }
    // CSF2 assigns args to a bound template after its export declaration.
    for (const statement of sourceFile.getStatements()) {
      if (!Node.isExpressionStatement(statement)) continue;
      const expression = statement.getExpression();
      if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      if (expression.getLeft().getText() === `${exportName}.args`) applyArgs(resolveObject(expression.getRight()), 'story.args');
    }
    if (props.size === 0 && unresolvedSpread) {
      throw new PropParseFailure('parse-exception', `Cannot determine props for story ${exportName}: object spread is unresolved`);
    }
    return [...props.values()];
  }

  private parseReactProps(sourceFile: SourceFile, exportName?: string | null): ParsedProp[] {
    const defaults = this.extractReactDefaults(sourceFile, exportName);
    const cvaMeta = this.extractCvaVariants(sourceFile);

    // Preferred: resolve props via type checker (covers extends, React.ComponentProps, VariantProps, etc.)
    try {
      const propsFromTypes = this.extractPropsFromTypeChecker(sourceFile, defaults, cvaMeta, exportName);
      if (propsFromTypes.length > 0) return propsFromTypes;
    } catch (e) {
      this.reportAdvancedPropParserRecoverable('advancedPropParser.react.typeChecker', e, {
        fileName: sourceFile.getFilePath(), exportName: exportName ?? null,
      });
      this.debugAdvancedPropParser('[AdvancedPropParser] type-checker extraction failed, falling back:', e);
    }

    // An explicit export may legitimately have no props. Never borrow another export's schema.
    if (exportName) return [];

    // Fallback 0: infer prop names from React component parameters (destructuring)
    const inferredNames = this.extractReactPropNamesFromParams(sourceFile);
    if (inferredNames.length > 0) {
      const inferred = inferredNames.map((name) => ({
        name,
        type: 'any',
        required: false,
        defaultValue: defaultValueFrom(defaults, name),
      }));
      return this.applyCvaMeta(inferred, cvaMeta, defaults);
    }

    // Fallback 1: interface with "Props" in name
    const propsInterface = sourceFile.getInterfaces().find((iface) =>
      iface.getName().toLowerCase().includes('props')
    );
    if (propsInterface) {
      try {
        if (this.project) {
          const ifaceType = propsInterface.getType();
          const base = this.extractPropsFromType(ifaceType, propsInterface, defaults);
          if (base.length > 0) return this.applyCvaMeta(base, cvaMeta, defaults);
        }
      } catch (error) {
        this.reportAdvancedPropParserRecoverable('advancedPropParser.react.interfaceTypeFallback', error, {
          fileName: sourceFile.getFilePath(),
          typeName: propsInterface.getName(),
        });
      }
      const base = this.extractPropsFromInterface(propsInterface, defaults);
      return this.applyCvaMeta(base, cvaMeta, defaults);
    }

    // Fallback 2: type alias with "Props" in name
    const propsType = sourceFile.getTypeAliases().find((alias) =>
      alias.getName().toLowerCase().includes('props')
    );
    if (propsType) {
      try {
        if (this.project) {
          const typeNode = propsType.getTypeNode();
          if (typeNode) {
            const aliasType = propsType.getType();
            const base = this.extractPropsFromType(aliasType, propsType, defaults);
            if (base.length > 0) return this.applyCvaMeta(base, cvaMeta, defaults);
          }
        }
      } catch (error) {
        this.reportAdvancedPropParserRecoverable('advancedPropParser.react.typeAliasFallback', error, {
          fileName: sourceFile.getFilePath(),
          typeName: propsType.getName(),
        });
      }
      const base = this.extractPropsFromTypeAlias(propsType);
      return this.applyCvaMeta(base, cvaMeta, defaults);
    }

    // Fallback 3: React.FC<PropsType>
    const fcComponent = sourceFile.getVariableDeclarations().find((varDecl) => {
      const typeNode = varDecl.getTypeNode();
      if (!typeNode) return false;
      const typeText = typeNode.getText();
      return typeText.includes('React.FC') || typeText.includes('FC<');
    });
    if (fcComponent) {
      const typeNode = fcComponent.getTypeNode();
      if (typeNode) {
        const match = typeNode.getText().match(/FC<(\w+)>/);
        if (match) {
          const propsTypeName = match[1];
          if (this.cache.interfaces.has(propsTypeName)) {
            const base = this.cache.interfaces.get(propsTypeName)!;
            const merged = base.map((p) => ({
              ...p,
              defaultValue: p.defaultValue === undefined
                ? defaultValueFrom(defaults, p.name)
                : p.defaultValue,
            }));
            return this.applyCvaMeta(merged, cvaMeta, defaults);
          }
        }
      }
    }

    this.debugAdvancedPropParser('[AdvancedPropParser] no React props found in', sourceFile.getFilePath());
    return [];
  }

  private extractReactPropNamesFromParams(sourceFile: SourceFile): string[] {
    const out: string[] = [];
    const addName = (n: string) => {
      const name = String(n || '').trim();
      if (!name || name === '...props') return;
      if (!out.includes(name)) out.push(name);
    };

    const extractFromBindingPattern = (bp: BindingPatternLike) => {
      this.invokeAdvancedPropParserRecoverable('advancedPropParser.react.paramBindingPattern', () => {
        const els = bp.getElements ? bp.getElements() : [];
        for (const el of els) {
          const name = String(el.getName ? el.getName() : '').trim();
          if (!name) continue;
          addName(name.replace(/^\.{3}/, ''));
        }
      }, { fileName: sourceFile.getFilePath() });
    };

    const extractFromFn = (fn: FunctionLike) => {
      this.invokeAdvancedPropParserRecoverable('advancedPropParser.react.paramFunction', () => {
        const p0 = fn.getParameters ? fn.getParameters()[0] : null;
        if (!p0) return;
        const nameNode = p0.getNameNode ? p0.getNameNode() : null;
        if (nameNode && Node.isObjectBindingPattern(nameNode)) {
          extractFromBindingPattern(nameNode);
          return;
        }
        const paramName = p0.getName ? String(p0.getName() || '') : '';
        if (paramName && fn.getBody) {
          const body = fn.getBody();
          const decls = body ? body.getDescendantsOfKind(SyntaxKind.VariableDeclaration) : [];
          for (const d of decls) {
            const init = d.getInitializer ? d.getInitializer() : null;
            if (!init) continue;
            if (String(init.getText ? init.getText() : '') !== paramName) continue;
            const nm = d.getNameNode ? d.getNameNode() : null;
            if (nm && Node.isObjectBindingPattern(nm)) {
              extractFromBindingPattern(nm);
            }
          }
        }
      }, { fileName: sourceFile.getFilePath() });
    };

    const node = this.resolveReactComponentNode(sourceFile);
    if (node) {
      if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        extractFromFn(node);
      } else if (Node.isVariableDeclaration(node)) {
        const init = node.getInitializer();
        if (init && Node.isCallExpression(init)) {
          const exprText = String(init.getExpression().getText() || '');
          if (exprText.includes('forwardRef')) {
            const a0 = init.getArguments()[0];
            if (a0 && (Node.isArrowFunction(a0) || Node.isFunctionExpression(a0))) {
              extractFromFn(a0);
            }
          }
        } else if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          extractFromFn(init);
        }
      }
    }

    return out;
  }

  /**
   * Extract props via TS type checker (most complete path).
   */
  private extractPropsFromTypeChecker(
    sourceFile: SourceFile,
    defaults?: PropDefaults,
    cvaMeta?: Record<string, { options?: string[]; defaultValue?: string }>,
    exportName?: string | null
  ): ParsedProp[] {
    if (!this.project) return [];
    const checker = this.project.getTypeChecker();

    const componentNode = this.resolveReactComponentNode(sourceFile, exportName);
    if (!componentNode) return [];

    const compType = checker.getTypeAtLocation(componentNode);
    const sigs = compType.getCallSignatures();
    if (!sigs || sigs.length === 0) {
      // In an isolated snapshot React's package types may be unavailable, so
      // forwardRef has no callable signature. Its explicit second type argument
      // still belongs to this selected export and can be analyzed without IO.
      if (Node.isVariableDeclaration(componentNode)) {
        let call = componentNode.getInitializer();
        while (call && Node.isCallExpression(call)) {
          const expression = call.getExpression();
          const isForwardRef = expression.getText() === 'forwardRef'
            || (Node.isPropertyAccessExpression(expression) && expression.getName() === 'forwardRef');
          if (isForwardRef) {
            const propsTypeNode = call.getTypeArguments()[1];
            if (propsTypeNode) {
              const props = this.extractPropsFromType(propsTypeNode.getType(), propsTypeNode, defaults, { includeNodeModules: false });
              return this.applyCvaMeta(props, cvaMeta, defaults);
            }
            break;
          }
          const firstArgument = call.getArguments()[0];
          call = firstArgument && Node.isCallExpression(firstArgument) ? firstArgument : undefined;
        }
      }
      return [];
    }
    const sig = sigs[0];
    const params = sig.getParameters();
    if (!params || params.length === 0) return [];

    const paramSymbol = params[0];
    const paramDecl = (paramSymbol.getDeclarations && paramSymbol.getDeclarations()[0]) || componentNode;
    const propsType = checker.getTypeOfSymbolAtLocation(paramSymbol, paramDecl);
    if (!propsType) return [];

    const props = this.extractPropsFromType(propsType, paramDecl, defaults, { includeNodeModules: false });
    return this.applyCvaMeta(props, cvaMeta, defaults);
  }

  /**
   * Resolve the React component declaration for the default export.
   */
  private resolveReactComponentNode(sourceFile: SourceFile, exportName?: string | null): Node | null {
    try {
      if (exportName && exportName !== 'default') return sourceFile.getExportedDeclarations().get(exportName)?.[0] || null;
      const defSym = sourceFile.getDefaultExportSymbol();
      if (defSym) {
        const decls = defSym.getDeclarations();
        if (!decls || decls.length === 0) return null;
        let d: Node = decls[0];
        if (Node.isExportAssignment(d)) {
          const expr = d.getExpression();
          if (Node.isIdentifier(expr)) {
            const sym = expr.getSymbol();
            const sdecl = sym?.getDeclarations()?.[0];
            if (sdecl) d = sdecl;
          } else if (expr) {
            d = expr;
          }
        }
        return d;
      }

      // Fallback for named exports: try to match file name (e.g. badge.tsx -> Badge)
      const base = sourceFile.getBaseNameWithoutExtension();
      const preferred = this.toPascalCase(base);
      const exported = sourceFile.getExportedDeclarations();
      const pickFromDecls = (decls: Node[]): Node | null => {
        for (const d of decls) {
          if (Node.isFunctionDeclaration(d) || Node.isClassDeclaration(d)) return d;
          if (Node.isVariableDeclaration(d)) return d;
        }
        return null;
      };
      if (exported.has(preferred)) {
        const d = pickFromDecls(exported.get(preferred) || []);
        if (d) return d;
      }
      // Otherwise pick the first exported PascalCase component-like symbol
      for (const [name, decls] of exported.entries()) {
        if (!/^[A-Z]/.test(name)) continue;
        const d = pickFromDecls(decls);
        if (d) return d;
      }

      return null;
    } catch (error) {
      this.reportAdvancedPropParserRecoverable('advancedPropParser.react.resolveComponentNode', error, {
        fileName: sourceFile.getFilePath(),
      });
      return null;
    }
  }

  private toPascalCase(value: string): string {
    const s = String(value || '').replace(/[^a-zA-Z0-9]+/g, ' ').trim();
    if (!s) return value;
    return s
      .split(/\s+/)
      .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : ''))
      .join('');
  }

  private extractPropsFromType(
    type: Type,
    loc: Node,
    defaults?: PropDefaults,
    opts?: { includeNodeModules?: boolean; skippedNodeModules?: { count: number } }
  ): ParsedProp[] {
    const props: ParsedProp[] = [];
    if (!this.project) return props;
    const checker = this.project.getTypeChecker();
    const symbols = type.getProperties ? type.getProperties() : [];
    const seen = new Set<string>();
    const intrinsicAllow = new Set([
      'children',
      'className',
      'style',
      'id',
      'key',
      'disabled',
      'checked',
      'defaultChecked',
      'value',
      'defaultValue',
      'name',
      'placeholder',
      'type',
      'size',
      'href',
      'src',
      'alt',
      'title',
      'role',
      'tabIndex',
      'dir',
      'orientation',
      'collapsible',
      'loop',
      'open',
      'defaultOpen',
      'onOpenChange',
      'onValueChange',
      'onCheckedChange',
      'modal',
      'forceMount',
      'side',
      'sideOffset',
      'align',
      'alignOffset',
      'avoidCollisions',
      'collisionPadding',
      'sticky',
      'hideWhenDetached',
      'delayDuration',
      'skipDelayDuration',
      'min',
      'max',
      'step',
      'onClick',
      'onChange',
      'onSubmit',
      'onBlur',
      'onFocus',
      'asChild',
    ]);

    const includeNodeModules = !!opts?.includeNodeModules;
    const sourcePath = this.getDeclarationSourcePath(loc);
    for (const sym of symbols) {
      try {
        const name = sym.getName();
        if (!name) continue;
        if (seen.has(name)) continue;
        seen.add(name);

        const decls = sym.getDeclarations ? sym.getDeclarations() : [];
        const decl = decls && decls.length > 0 ? decls[0] : loc;
        // Package component declarations are public component props too. Only
        // React/DOM declaration owners contribute the intrinsic attribute noise.
        // A prop like `disabled` can be declared in BOTH Button.tsx AND @types/react —
        // it's only "inherited" if ALL its declarations belong to those owners.
        let isInherited = false;
        try {
          let hasOwnDecl = false;
          for (const d of decls) {
            try {
              const p = this.getDeclarationSourcePath(d);
              const intrinsicOwner = /\/node_modules\/(?:@types\/(?:react|react-dom)\/|typescript\/lib\/lib\.dom(?:\.[\w-]+)?\.d\.[cm]?ts$)/.test(p);
              if (p && !intrinsicOwner) { hasOwnDecl = true; break; }
            } catch (error) {
              this.reportAdvancedPropParserRecoverable('advancedPropParser.type.declarationPath', error, {
                fileName: sourcePath,
                propName: name,
              });
            }
          }
          if (!hasOwnDecl && decls.length > 0) {
            if (!intrinsicAllow.has(name) && !includeNodeModules) {
              if (opts?.skippedNodeModules) opts.skippedNodeModules.count += 1;
              continue;
            }
            isInherited = true;
          }
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.inheritanceCheck', error, {
            fileName: sourcePath,
            propName: name,
          });
        }
        const propType = checker.getTypeOfSymbolAtLocation(sym, decl);

        let typeText = '';
        try {
          typeText = propType.getText(decl);
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.text', error, {
            fileName: sourcePath,
            propName: name,
          });
          typeText = 'any';
        }
        let typeLabel = this.simplifyType(typeText);

        // Optional?
        let isOptional = false;
        try {
          const flags = sym.getFlags ? sym.getFlags() : 0;
          if (flags & ts.SymbolFlags.Optional) isOptional = true;
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.optionalFlag', error, {
            fileName: sourcePath,
            propName: name,
          });
        }
        try {
          if (!isOptional && propType.isUnion && propType.isUnion()) {
            isOptional = propType.getUnionTypes().some((u) => u.isUndefined && u.isUndefined());
          }
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.optionalUnion', error, {
            fileName: sourcePath,
            propName: name,
          });
        }

        // Union literal options
        let options: Array<string | number | boolean> | undefined;
        let hasFreeformMember = false;
        try {
          if (propType.isUnion && propType.isUnion()) {
            const opts: Array<string | number | boolean> = [];
            for (const u of propType.getUnionTypes()) {
              if (u.isUndefined && u.isUndefined()) continue;
              if (u.isNull && u.isNull()) continue;
              if (u.isStringLiteral && u.isStringLiteral()) opts.push(u.getLiteralValue() as string | number);
              else if (u.isNumberLiteral && u.isNumberLiteral()) opts.push(u.getLiteralValue() as string | number);
              // NOTE: boolean literal types expose no getLiteralValue() — reading it
              // yields `undefined`, which used to stringify into garbage
              // options ['undefined', 'undefined'] for every optional boolean
              // (`compact?: boolean` expands to `true | false | undefined`).
              // Use the type text ('true'/'false') instead.
              else if (u.isBooleanLiteral && u.isBooleanLiteral()) opts.push(u.getText() === 'true');
              else {
                // Non-literal member (bare `string`, `number`, `boolean`, etc.) →
                // the union is open-ended, so literals are suggestions, not a closed set.
                hasFreeformMember = true;
              }
            }
            // These are already AST literal values. Empty and null-like strings
            // are valid members; only actual null/undefined types were skipped above.
            // A union that collapses to just true/false is a plain boolean —
            // options would only produce a bogus select control for a checkbox prop.
            const isPlainBooleanUnion = opts.length > 0 && opts.every((v) => typeof v === 'boolean');
            if (opts.length > 0 && !isPlainBooleanUnion) options = opts;
          }
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.unionOptions', error, {
            fileName: sourcePath,
            propName: name,
          });
        }

        // Enum values
        let enumValues: Record<string, string | number> | undefined;
        try {
          const symDecls = propType.getSymbol && propType.getSymbol()?.getDeclarations();
          const enumDecl = symDecls?.find((d) => Node.isEnumDeclaration(d)) as EnumDeclaration | undefined;
          if (enumDecl) {
            enumValues = {};
            enumDecl.getMembers().forEach((m) => {
              const mn = m.getName();
              const init = m.getInitializer();
              if (init) {
                const v = init.getText().replace(/['"]/g, '');
                enumValues![mn] = isNaN(Number(v)) ? v : Number(v);
              } else {
                enumValues![mn] = Object.keys(enumValues!).length;
              }
            });
            if (!options) options = Object.keys(enumValues);
          }
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.enumValues', error, {
            fileName: sourcePath,
            propName: name,
          });
        }

        // Arrays
        let isArray = false;
        let arrayItemType: string | undefined;
        try {
          if (propType.isArray && propType.isArray()) {
            isArray = true;
            const el = propType.getArrayElementType();
            if (el) arrayItemType = this.simplifyType(el.getText(decl));
            typeLabel = 'array';
          }
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.array', error, {
            fileName: sourcePath,
            propName: name,
          });
        }

        // Objects (avoid over-expanding huge shapes)
        let isObject = false;
        let objectShape: Record<string, string> | undefined;
        try {
          if (!isArray && propType.isObject && propType.isObject()) {
            const callSigs = propType.getCallSignatures ? propType.getCallSignatures() : [];
            if (!callSigs || callSigs.length === 0) {
              isObject = true;
              typeLabel = 'object';
              const objProps = propType.getProperties ? propType.getProperties() : [];
              if (objProps.length > 0 && objProps.length <= 12) {
                objectShape = {};
                objProps.forEach((op) => {
                  try {
                    const on = op.getName();
                    const od = op.getDeclarations ? op.getDeclarations()[0] : decl;
                    const ot = checker.getTypeOfSymbolAtLocation(op, od);
                    objectShape![on] = this.simplifyType(ot.getText(od));
                  } catch (error) {
                    this.reportAdvancedPropParserRecoverable('advancedPropParser.type.objectShapeProp', error, {
                      fileName: sourcePath,
                      propName: name,
                    });
                  }
                });
              }
            }
          }
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.objectShape', error, {
            fileName: sourcePath,
            propName: name,
          });
        }

        // JSDoc
        let jsdocData: { description?: string; tags: JsDocTags } | undefined;
        try {
          const jsdocText = this.readJsDocs(decl);
          if (jsdocText) jsdocData = this.extractJSDoc(jsdocText);
        } catch (error) {
          this.reportAdvancedPropParserRecoverable('advancedPropParser.type.jsDoc', error, {
            fileName: sourcePath,
            propName: name,
          });
        }

        // If the union has non-literal members (e.g. `'sm' | 'md' | string`),
        // treat the literal values as suggestions, not a closed set.
        let finalOptions = options;
        let suggestions: Array<string | number | boolean> | undefined;
        if (hasFreeformMember && options && options.length > 0) {
          suggestions = options;
          finalOptions = undefined; // not a closed enum
        }

        props.push({
          name,
          type: typeLabel,
          required: !isOptional,
          description: jsdocData?.description,
          jsdoc: jsdocData?.tags,
          options: finalOptions,
          suggestions,
          enumValues,
          isArray,
          arrayItemType,
          isObject,
          objectShape,
          defaultValue: defaultValueFrom(defaults, name),
          ...(isInherited ? { isInherited: true } : {}),
        });
      } catch (error) {
        this.reportAdvancedPropParserRecoverable('advancedPropParser.type.prop', error, {
          fileName: sourcePath,
        });
      }
    }

    return props;
  }

  private extractCvaVariants(sourceFile: SourceFile): Record<string, { options?: string[]; defaultValue?: string }> {
    const out: Record<string, { options?: string[]; defaultValue?: string }> = {};
    try {
      const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
      for (const call of calls) {
        const expr = call.getExpression();
        const exprText = expr ? expr.getText() : '';
        if (exprText !== 'cva') continue;
        const args = call.getArguments();
        if (!args || args.length < 2) continue;
        const arg1 = args[1];
        if (!Node.isObjectLiteralExpression(arg1)) continue;
        const variantsProp = arg1.getProperty('variants');
        const defaultsProp = arg1.getProperty('defaultVariants');
        const defaults: Record<string, string> = {};
        if (defaultsProp && Node.isPropertyAssignment(defaultsProp)) {
          const dv = defaultsProp.getInitializer();
          if (dv && Node.isObjectLiteralExpression(dv)) {
            dv.getProperties().forEach((p) => {
              if (!Node.isPropertyAssignment(p)) return;
              const k = p.getName().replace(/['"]/g, '');
              const v = p.getInitializer();
              if (k && v && Node.isStringLiteral(v)) defaults[k] = v.getLiteralText();
            });
          }
        }
        if (variantsProp && Node.isPropertyAssignment(variantsProp)) {
          const vinit = variantsProp.getInitializer();
          if (vinit && Node.isObjectLiteralExpression(vinit)) {
            vinit.getProperties().forEach((p) => {
              if (!Node.isPropertyAssignment(p)) return;
              const key = p.getName().replace(/['"]/g, '');
              const val = p.getInitializer();
              if (!key || !val || !Node.isObjectLiteralExpression(val)) return;
              const opts: string[] = [];
              val.getProperties().forEach((op) => {
                if (!Node.isPropertyAssignment(op)) return;
                const on = op.getName().replace(/['"]/g, '');
                if (on) opts.push(on);
              });
              if (opts.length > 0) {
                out[key] = { options: opts, defaultValue: defaults[key] };
              }
            });
          }
        }
      }
    } catch (error) {
      this.reportAdvancedPropParserRecoverable('advancedPropParser.cvaVariants', error, {
        fileName: sourceFile.getFilePath(),
      });
    }
    return out;
  }

  private applyCvaMeta(
    props: ParsedProp[],
    cvaMeta?: Record<string, { options?: string[]; defaultValue?: string }>,
    defaults?: PropDefaults
  ): ParsedProp[] {
    if (!cvaMeta || Object.keys(cvaMeta).length === 0) return props;
    const out = props.slice();
    const byName = new Map(out.map((p) => [p.name, p]));
    for (const [name, meta] of Object.entries(cvaMeta)) {
      const existing = byName.get(name);
      if (existing) {
        if ((!existing.options || existing.options.length === 0) && meta.options && meta.options.length > 0) {
          existing.options = meta.options;
        }
        if (existing.defaultValue === undefined && meta.defaultValue !== undefined) {
          existing.defaultValue = meta.defaultValue;
        }
      } else {
        out.push({
          name,
          type: 'union',
          required: false,
          options: meta.options,
          defaultValue: meta.defaultValue ?? defaultValueFrom(defaults, name),
        });
      }
    }
    return out;
  }

  /**
   * Извлечение props из interface
   */
  private extractPropsFromInterface(iface: InterfaceDeclaration, defaults?: PropDefaults): ParsedProp[] {
    const props: ParsedProp[] = [];

    iface.getProperties().forEach((prop) => {
      const nameNode = prop.getNameNode();
      const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : prop.getName();
      const typeNode = prop.getTypeNode();
      const isOptional = prop.hasQuestionToken();
      const jsdocs = prop.getJsDocs();

      let type = 'any';
      let options: Array<string | number | boolean> | undefined;
      let enumValues: Record<string, string | number> | undefined;
      let isArray = false;
      let arrayItemType: string | undefined;
      let isObject = false;
      let objectShape: Record<string, string> | undefined;

      if (typeNode) {
        const typeText = typeNode.getText();
        type = this.simplifyType(typeText);

        // Проверяем union types
        if (Node.isUnionTypeNode(typeNode)) {
          options = this.extractUnionOptions(typeNode);
        }

        // Проверяем enum
        if (this.cache.enums.has(typeText)) {
          enumValues = this.cache.enums.get(typeText);
          options = Object.keys(enumValues!);
        }

        // Проверяем type alias
        if (this.cache.aliases.has(typeText)) {
          const resolvedType = this.cache.aliases.get(typeText)!;
          type = this.simplifyType(resolvedType);
          // Если alias - это union, извлекаем опции
          if (resolvedType.includes('|')) {
            options = resolvedType.split('|').map((opt) => opt.trim().replace(/['"]/g, ''));
          }
        }

        // Проверяем массивы
        const arrayGenericMatch = !Node.isArrayTypeNode(typeNode) && typeText.match(/^Array<(.+)>$/);
        if (Node.isArrayTypeNode(typeNode) || arrayGenericMatch) {
          isArray = true;
          const elementType = Node.isArrayTypeNode(typeNode)
            ? typeNode.getElementTypeNode().getText()
            : (arrayGenericMatch ? arrayGenericMatch[1] : 'any');
          arrayItemType = this.simplifyType(elementType);
          type = 'array';

          // Если элемент массива - union, извлекаем опции
          if (elementType.includes('|')) {
            options = elementType.split('|').map((opt) => opt.trim().replace(/['"]/g, ''));
          }
        }

        // Проверяем объекты
        if (Node.isTypeLiteral(typeNode) || typeText.startsWith('{')) {
          isObject = true;
          type = 'object';
          objectShape = {};
          if (Node.isTypeLiteral(typeNode)) {
            typeNode.getProperties().forEach((objProp) => {
              const objPropName = objProp.getName();
              const objPropType = objProp.getTypeNode();
              objectShape![objPropName] = objPropType ? this.simplifyType(objPropType.getText()) : 'any';
            });
          }
        }
      }

      // Извлекаем JSDoc
      const jsdocData = this.extractJSDoc(jsdocs.map((doc) => doc.getInnerText()).join('\n'));

      props.push({
        name,
        type,
        required: !isOptional,
        description: jsdocData.description,
        jsdoc: jsdocData.tags,
        options,
        enumValues,
        isArray,
        arrayItemType,
        isObject,
        objectShape,
        defaultValue: defaultValueFrom(defaults, name),
      });
    });

    return props;
  }

  /**
   * Best-effort extraction of default values from React component parameter destructuring.
   * Supports common patterns:
   * - export const X = forwardRef(( { a = 1, b = 'x', c = true }, ref) => ...)
   * - export const X = ({ a = 1, ... }: Props) => ...
   * - const X: React.FC<Props> = (props) => { const { a = 1 } = props; ... }
   */
  private extractReactDefaults(sourceFile: SourceFile, exportName?: string | null): PropDefaults {
    const out: PropDefaults = {};

    const parseLiteral = (n: Node | undefined): unknown => {
      try {
        if (!n) return undefined;
        if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralText();
        if (Node.isNumericLiteral(n)) return Number(n.getText());
        if (n.getKind() === SyntaxKind.TrueKeyword) return true;
        if (n.getKind() === SyntaxKind.FalseKeyword) return false;
        if (n.getKind() === SyntaxKind.NullKeyword) return null;
        if (Node.isPrefixUnaryExpression(n)) {
          const op = n.getOperatorToken();
          const operand = n.getOperand();
          if (op === SyntaxKind.MinusToken && Node.isNumericLiteral(operand)) return -Number(operand.getText());
        }
        return undefined;
      } catch (error) {
        this.reportAdvancedPropParserRecoverable('advancedPropParser.react.defaultLiteral', error, {
          fileName: sourceFile.getFilePath(),
        });
        return undefined;
      }
    };

    const extractFromBindingPattern = (bp: BindingPatternLike) => {
      this.invokeAdvancedPropParserRecoverable('advancedPropParser.react.defaultBindingPattern', () => {
        const els = bp.getElements ? bp.getElements() : [];
        for (const el of els) {
          const name = String(el.getName ? el.getName() : '').trim();
          if (!name) continue;
          const init = el.getInitializer ? el.getInitializer() : null;
          const dv = parseLiteral(init || undefined);
          if (dv !== undefined) out[name] = dv;
        }
      }, { fileName: sourceFile.getFilePath() });
    };

    const tryExtractFromFn = (fn: FunctionLike) => {
      try {
        const p0 = fn.getParameters ? fn.getParameters()[0] : null;
        if (!p0) return false;
        const nameNode = p0.getNameNode ? p0.getNameNode() : null;
        if (nameNode && Node.isObjectBindingPattern(nameNode)) {
          extractFromBindingPattern(nameNode);
          return Object.keys(out).length > 0;
        }
        // Pattern: (props) => { const { a = 1 } = props; ... }
        const paramName = p0.getName ? String(p0.getName() || '') : '';
        if (paramName && fn.getBody) {
          const body = fn.getBody();
          const decls = body ? body.getDescendantsOfKind(SyntaxKind.VariableDeclaration) : [];
          for (const d of decls) {
            const init = d.getInitializer ? d.getInitializer() : null;
            if (!init) continue;
            if (String(init.getText ? init.getText() : '') !== paramName) continue;
            const nm = d.getNameNode ? d.getNameNode() : null;
            if (nm && Node.isObjectBindingPattern(nm)) {
              extractFromBindingPattern(nm);
              return Object.keys(out).length > 0;
            }
          }
        }
      } catch (error) {
        this.reportAdvancedPropParserRecoverable('advancedPropParser.react.defaultFunction', error, {
          fileName: sourceFile.getFilePath(),
        });
      }
      return false;
    };

    if (exportName) {
      let selected = this.resolveReactComponentNode(sourceFile, exportName);
      if (selected && Node.isVariableDeclaration(selected)) selected = selected.getInitializer() || selected;
      if (selected && Node.isCallExpression(selected)) {
        selected = selected.getDescendants().find(node => Node.isArrowFunction(node) || Node.isFunctionExpression(node)) || selected;
      }
      if (selected && (Node.isFunctionDeclaration(selected) || Node.isArrowFunction(selected) || Node.isFunctionExpression(selected))) tryExtractFromFn(selected);
      return out;
    }
    const decls = sourceFile.getVariableDeclarations();
    for (const vd of decls) {
      const init = vd.getInitializer();
      if (!init) continue;

      // forwardRef((...) => ...)
      if (Node.isCallExpression(init)) {
        const exprText = String(init.getExpression().getText() || '');
        if (exprText.includes('forwardRef')) {
          const a0 = init.getArguments()[0];
          if (a0 && (Node.isArrowFunction(a0) || Node.isFunctionExpression(a0))) {
            if (tryExtractFromFn(a0)) break;
          }
        }
      }

      // direct arrow/function
      if (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) {
        if (tryExtractFromFn(init)) break;
      }
    }

    return out;
  }

  /**
   * Извлечение props из type alias
   */
  private extractPropsFromTypeAlias(alias: TypeAliasDeclaration): ParsedProp[] {
    const typeNode = alias.getTypeNode();
    if (!typeNode) return [];

    // Если это type literal ({ foo: string; bar: number })
    if (Node.isTypeLiteral(typeNode)) {
      const props: ParsedProp[] = [];
      typeNode.getProperties().forEach((prop) => {
        const nameNode = prop.getNameNode();
        const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : prop.getName();
        const propTypeNode = prop.getTypeNode();
        const isOptional = prop.hasQuestionToken();

        let type = 'any';
        let options: Array<string | number | boolean> | undefined;

        if (propTypeNode) {
          type = this.simplifyType(propTypeNode.getText());
          if (Node.isUnionTypeNode(propTypeNode)) {
            options = this.extractUnionOptions(propTypeNode);
          }
        }

        props.push({
          name,
          type,
          required: !isOptional,
          options,
        });
      });
      return props;
    }

    return [];
  }

  /**
   * Извлечение опций из union type
   */
  private extractUnionOptions(unionNode: Node): Array<string | number | boolean> {
    if (!Node.isUnionTypeNode(unionNode)) return [];
    const options: Array<string | number | boolean> = [];
    for (const member of unionNode.getTypeNodes()) {
      if (member.getKind() === ts.SyntaxKind.BooleanKeyword) options.push(true, false);
      else if (Node.isLiteralTypeNode(member)) {
        const literal = member.getLiteral();
        if (Node.isStringLiteral(literal)) options.push(literal.getLiteralText());
        else if (Node.isNumericLiteral(literal)) options.push(Number(literal.getLiteralText()));
        else if (literal.getKind() === ts.SyntaxKind.TrueKeyword) options.push(true);
        else if (literal.getKind() === ts.SyntaxKind.FalseKeyword) options.push(false);
      }
    }
    return options.every(value => typeof value === 'boolean') ? [] : [...new Set(options)];
  }

  /**
   * Парсинг Vue SFC props
   */
  private parseVueProps(sourceFile: SourceFile): ParsedProp[] {
    const content = sourceFile.getFullText();

    // Ищем defineProps<...>() или withDefaults(defineProps<...>(), {...})
    const definePropsRegex = /defineProps<\{([^}]+)\}>\(\)/;
    const withDefaultsRegex = /withDefaults\(defineProps<\{([^}]+)\}>\(\),\s*\{([^}]+)\}\)/;

    let match = withDefaultsRegex.exec(content);
    if (match) {
      const [, propsText, defaultsText] = match;
      return this.parseVuePropsText(propsText, defaultsText);
    }

    match = definePropsRegex.exec(content);
    if (match) {
      const [, propsText] = match;
      return this.parseVuePropsText(propsText);
    }

    if (/defineProps\s*<\s*\{\s*\}\s*>\s*\(\s*\)/.test(content)) return [];
    if (/defineProps\s*\(\s*\{\s*\}\s*\)/.test(content)) return [];

    const named = /defineProps\s*<\s*([A-Za-z_$][\w$]*)\s*>\s*\(\s*\)/.exec(content);
    if (named) {
      const propsText = this.resolveLocalPropsText(content, named[1]);
      if (propsText !== undefined) {
        const defaults = /withDefaults\s*\(\s*defineProps\s*<\s*[A-Za-z_$][\w$]*\s*>\s*\(\s*\)\s*,\s*\{([^}]*)\}/.exec(content)?.[1];
        return this.parseVuePropsText(propsText, defaults);
      }
      this.reportAdvancedPropParserRecoverable('advancedPropParser.vue.unresolvedPropsType',
        new Error(`Cannot resolve local Vue props type ${named[1]}`), { fileName: sourceFile.getFilePath(), typeName: named[1] });
      throw new PropParseFailure('parse-exception', `Cannot determine Vue props from ${named[1]}`);
    }

    if (/defineProps\s*(?:<|\()/.test(content) && !/defineProps\s*\(\s*\)/.test(content)) {
      this.reportAdvancedPropParserRecoverable('advancedPropParser.vue.unsupportedPropsSyntax',
        new Error('Unsupported Vue defineProps syntax'), { fileName: sourceFile.getFilePath() });
      throw new PropParseFailure('parse-exception', 'Cannot determine Vue props from unsupported defineProps syntax');
    }

    this.debugAdvancedPropParser('[AdvancedPropParser] no Vue defineProps found');
    return [];
  }

  private resolveLocalPropsText(content: string, typeName: string): string | undefined {
    const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\binterface\\s+${escaped}\\s*\\{([^{}]*)\\}`).exec(content)?.[1]
      ?? new RegExp(`\\btype\\s+${escaped}\\s*=\\s*\\{([^{}]*)\\}(?!\\s*&)`).exec(content)?.[1];
  }

  /**
   * Парсинг текста Vue props
   */
  private parseVuePropsText(propsText: string, defaultsText?: string): ParsedProp[] {
    const props: ParsedProp[] = [];
    const lines = propsText.split(/[;\n]/).map((l) => l.trim()).filter(Boolean);

    const defaults: Record<string, string> = {};
    if (defaultsText) {
      const defaultLines = defaultsText.split(/[,\n]/).map((l) => l.trim()).filter(Boolean);
      defaultLines.forEach((line) => {
        const [key, value] = line.split(':').map((s) => s.trim());
        if (key && value) {
          defaults[key] = value;
        }
      });
    }

    lines.forEach((line) => {
      const match = /^(\w+)(\??)\s*:\s*(.+)$/.exec(line);
      if (!match) return;

      const [, name, opt, rawType] = match;
      const type = this.simplifyType(rawType);
      const required = opt !== '?';

      let options: Array<string | number | boolean> | undefined;
      if (rawType.includes('|')) {
        options = rawType.split('|').map((o) => o.trim().replace(/['"]/g, ''));
      }

      props.push({
        name,
        type,
        required,
        options,
        defaultValue: defaults[name],
      });
    });

    return props;
  }

  /**
   * Парсинг Svelte props
   */
  private parseSvelteProps(sourceFile: SourceFile): ParsedProp[] {
    const content = sourceFile.getFullText();
    const props: ParsedProp[] = [];

    // Ищем export let name: type = default
    const exportLetRegex = /export\s+let\s+(\w+)(\??)\s*:\s*([^=;]+)(?:\s*=\s*([^;]+))?/g;
    let match;

    while ((match = exportLetRegex.exec(content)) !== null) {
      const [, name, opt, rawType, defaultValue] = match;
      const type = this.simplifyType(rawType.trim());
      const required = opt !== '?';

      let options: Array<string | number | boolean> | undefined;
      if (rawType.includes('|')) {
        options = rawType.split('|').map((o) => o.trim().replace(/['"]/g, ''));
      }

      props.push({
        name,
        type,
        required,
        options,
        defaultValue: defaultValue?.trim(),
      });
    }

    if (/\$props\s*\(\s*\)/.test(content)) {
      if (/(?:let|const)\s*\{\s*\}\s*=\s*\$props\s*\(\s*\)/.test(content)) return props;
      const binding = '(?:\\{[^}]*\\}|[A-Za-z_$][\\w$]*)';
      const inline = new RegExp(`(?:let|const)\\s+${binding}\\s*:\\s*\\{([^{}]*)\\}\\s*=\\s*\\$props\\s*\\(\\s*\\)`).exec(content);
      if (inline) return [...props, ...this.parseVuePropsText(inline[1])];
      const named = new RegExp(`(?:let|const)\\s+${binding}\\s*:\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*\\$props\\s*\\(\\s*\\)`).exec(content);
      if (named) {
        const propsText = this.resolveLocalPropsText(content, named[1]);
        if (propsText !== undefined) return [...props, ...this.parseVuePropsText(propsText)];
      }
      this.reportAdvancedPropParserRecoverable('advancedPropParser.svelte.unresolvedPropsType',
        new Error('Cannot resolve typed Svelte $props() declaration'), { fileName: sourceFile.getFilePath() });
      if (props.length === 0) throw new PropParseFailure('parse-exception', 'Cannot determine Svelte props from $props()');
    }

    return props;
  }

  /**
   * Упрощение TypeScript типа до базового
   */
  private simplifyType(type: string): string {
    const trimmed = type.trim();

    // Удаляем | undefined
    const withoutUndefined = trimmed.replace(/\s*\|\s*undefined\s*/g, '');

    // A union that happens to end in [] is still a union. Ignore separators
    // inside generic arguments, tuples, object shapes, functions and literals.
    let depth = 0;
    let quote = '';
    for (let index = 0; index < withoutUndefined.length; index++) {
      const char = withoutUndefined[index];
      if (quote) {
        if (char === '\\') index++;
        else if (char === quote) quote = '';
      } else if (char === "'" || char === '"' || char === '`') quote = char;
      else if ('<([{'.includes(char)) depth++;
      else if ('>)]}'.includes(char) && withoutUndefined[index - 1] !== '=') depth--;
      else if (char === '|' && depth === 0) return 'union';
    }

    // Массивы
    if (withoutUndefined.endsWith('[]') || withoutUndefined.startsWith('Array<')) {
      return 'array';
    }

    // TE-004: Record<K,V> gets its own simplified type for richer enrichment.
    if (withoutUndefined.startsWith('Record<')) {
      return 'record';
    }

    // Объекты
    if (withoutUndefined.startsWith('{')) {
      return 'object';
    }

    // Функции — only classify if arrow/parens are at top-level (not inside generics)
    if (withoutUndefined.startsWith('Function')) {
      return 'function';
    }
    {
      let depth = 0;
      let isTopLevelFn = false;
      for (let i = 0; i < withoutUndefined.length - 1; i++) {
        const ch = withoutUndefined[i];
        if (ch === '<' || ch === '(') depth++;
        else if (ch === '>' || ch === ')') depth--;
        if (depth === 0 && ch === '=' && withoutUndefined[i + 1] === '>') { isTopLevelFn = true; break; }
        if (depth === 0 && ch === '(' && withoutUndefined[i + 1] === ')') { isTopLevelFn = true; break; }
      }
      if (isTopLevelFn) return 'function';
    }

    // Union types (оставляем как есть для дальнейшей обработки)
    if (withoutUndefined.includes('|')) {
      return 'union';
    }

    // Базовые типы
    const lowerType = withoutUndefined.toLowerCase();
    if (lowerType === 'string') return 'string';
    if (lowerType === 'number') return 'number';
    if (lowerType === 'boolean') return 'boolean';
    if (lowerType === 'any' || lowerType === 'unknown') return 'any';

    // Если не распознали - возвращаем как есть
    return withoutUndefined;
  }

  /**
   * Извлечение JSDoc тегов
   */
  private extractJSDoc(jsdocText: string): { description?: string; tags: JsDocTags } {
    const tags: JsDocTags = {};
    let description = '';

    const lines = jsdocText.split('\n').map((l) => l.trim());

    lines.forEach((line) => {
      // @control
      if (line.startsWith('@control')) {
        tags.control = line.replace('@control', '').trim();
      }
      // @min
      else if (line.startsWith('@min')) {
        tags.min = parseFloat(line.replace('@min', '').trim());
      }
      // @max
      else if (line.startsWith('@max')) {
        tags.max = parseFloat(line.replace('@max', '').trim());
      }
      // @step
      else if (line.startsWith('@step')) {
        tags.step = parseFloat(line.replace('@step', '').trim());
      }
      // @autocomplete
      else if (line.startsWith('@autocomplete')) {
        tags.autocomplete = line.replace('@autocomplete', '').trim();
      }
      // @multiline
      else if (line.includes('@multiline')) {
        tags.multiline = true;
      }
      // @example
      else if (line.startsWith('@example')) {
        tags.example = line.replace('@example', '').trim();
      }
      // Description
      else if (!line.startsWith('@') && line.length > 0) {
        description += line + ' ';
      }
    });

    return {
      description: description.trim() || undefined,
      tags: Object.keys(tags).length > 0 ? tags : undefined,
    };
  }

  /**
   * Очистка per-parse ресурсов.
   * Task 3.2: Project is intentionally KEPT alive for reuse across parses.
   * Only the type cache (per-file) is cleared.
   */
  private cleanup(): void {
    // DO NOT null-out this.project — it is reused in the next parse.
    this.cache = {
      aliases: new Map(),
      enums: new Map(),
      interfaces: new Map(),
    };
  }

private reportAdvancedPropParserRecoverable(
  reason: string,
  error: unknown,
  meta: AdvancedPropParserRecoverableMeta = {},
): void {
  const message = advancedPropParserErrorMessage(error);
  const key = `${reason}:${String(meta.fileName || '')}:${String(meta.propName || '')}:${message}`;
  const active = this.activeResultDiagnostics;
  if (active && !active.keys.has(key)) {
    active.keys.add(key);
    active.items.push({ reason, message, details: { ...meta } });
  }
  if (this.recoverableKeys.has(key)) return;
  if (this.recoverableKeys.size > 100) this.recoverableKeys.clear();
  this.recoverableKeys.add(key);
  try { this.options.onDiagnostic?.({ reason, message, details: meta }); } catch { /* Host observers do not affect analysis. */ }
}

private runAdvancedPropParserRecoverable<T>(
  reason: string,
  action: () => T,
  fallback: T,
  meta?: AdvancedPropParserRecoverableMeta,
): T {
  try {
    return action();
  } catch (error) {
    this.reportAdvancedPropParserRecoverable(reason, error, meta);
    return fallback;
  }
}

private invokeAdvancedPropParserRecoverable(
  reason: string,
  action: () => void,
  meta?: AdvancedPropParserRecoverableMeta,
): boolean {
  try {
    action();
    return true;
  } catch (error) {
    this.reportAdvancedPropParserRecoverable(reason, error, meta);
    return false;
  }
}

private getDeclarationSourcePath(declaration: unknown): string {
  const record = declaration && typeof declaration === 'object'
    ? declaration as { getSourceFile?: () => SourceFile }
    : null;
  return this.runAdvancedPropParserRecoverable(
    'advancedPropParser.declarationSourcePath',
    () => record?.getSourceFile?.().getFilePath?.() || '',
    '',
  );
}

private readJsDocs(declaration: unknown): string {
  const record = declaration && typeof declaration === 'object'
    ? declaration as { getJsDocs?: () => Array<{ getInnerText?: () => string }> }
    : null;
  return this.runAdvancedPropParserRecoverable('advancedPropParser.readJsDocs', () => {
    const docs = record?.getJsDocs?.() || [];
    return docs.map((doc) => doc.getInnerText?.() || '').join('\n');
  }, '');
}

private debugAdvancedPropParser(...args: unknown[]): void {
  try { this.options.onDebug?.('engine.advancedPropParser.debug', {
    args: args.map((arg) => arg instanceof Error ? arg.message : String(arg)).slice(0, 6),
  }); } catch { /* Host observers do not affect analysis. */ }
}
}
