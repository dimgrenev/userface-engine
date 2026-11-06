import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { defineConfig } from '../index';

it('accepts optional typed generated roots and rejects non-string delivery roots in an actual consumer program', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const configPath = path.join(root, 'tsconfig.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root);
  const fixture = path.join(root, 'src/__tests__/generated-delivery.consumer.ts');
  const text = [
    'import { defineConfig, type UserfaceConfig } from "../index";',
    'const config: UserfaceConfig = { generated: { deliveryRoots: { editor: "public/editor", other: "generated/other" } } };',
    'defineConfig(config); defineConfig({});',
    '// @ts-expect-error delivery roots are paths, not numeric configuration',
    'defineConfig({ generated: { deliveryRoots: { editor: 42 } } });',
  ].join('\n');
  const host = ts.createCompilerHost(config.options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host), source = host.getSourceFile.bind(host);
  host.readFile = file => file === fixture ? text : read(file);
  host.fileExists = file => file === fixture || exists(file);
  host.getSourceFile = (file, version, onError, fresh) => file === fixture
    ? ts.createSourceFile(file, text, version, true) : source(file, version, onError, fresh);
  const program = ts.createProgram([fixture], { ...config.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.file?.fileName === fixture);
  expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
});

it('preserves defineConfig identity and absence compatibility', () => {
  const config = { generated: { deliveryRoots: { editor: 'public/editor' } } };
  expect(defineConfig(config)).toBe(config);
  const empty = {};
  expect(defineConfig(empty)).toBe(empty);
});
