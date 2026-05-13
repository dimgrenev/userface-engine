import { createRequire } from 'node:module';

function resolveRequire(): NodeRequire {
  try {
    // Use local CommonJS require when available (CJS build/runtime).
    return Function('return typeof require !== "undefined" ? require : null')() as NodeRequire;
  } catch {
    // Fall through to createRequire below.
  }
  return createRequire(`${process.cwd()}/package.json`);
}

const runtimeRequire = resolveRequire();

export interface TarExtractModule {
  x(options: {
    file: string;
    cwd: string;
    strip?: number;
  }): Promise<void>;
}

export interface KeytarModule {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

function loadOptionalModule<T>(specifier: string, installHint: string): T {
  try {
    return runtimeRequire(specifier) as T;
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? ` Original error: ${error.message}` : '';
    throw new Error(
      `Optional dependency "${specifier}" is required for this engine workflow.${installHint}${detail}`
    );
  }
}

export function loadTarModule(): TarExtractModule {
  return loadOptionalModule<TarExtractModule>(
    'tar',
    ' Install "@userface/engine" with its production dependencies before using download/extract features.'
  );
}

export function loadKeytarModule(): KeytarModule {
  return loadOptionalModule<KeytarModule>(
    'keytar',
    ' Install platform keychain support before using secure token storage.'
  );
}
