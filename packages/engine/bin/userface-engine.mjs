#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(root, 'dist/esm/cli.js');

if (!existsSync(cliPath)) {
  console.error('userface-engine is not built yet. Run "pnpm --dir packages/engine build" first.');
  process.exit(1);
}

await import(pathToFileURL(cliPath).href);
