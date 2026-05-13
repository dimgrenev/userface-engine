export type EngineScriptItem = {
  src: string;
  global?: string;
  optional?: boolean;
};

export type EnsureEngineScriptsOptions = {
  debug?: boolean;
  timeoutMs?: number;
  scripts?: EngineScriptItem[];
};

export declare function getEngineLoaderState(): {
  state: 'idle' | 'loading' | 'ready' | 'error';
  error: Error | null;
};

export declare function ensureEngineScriptsLoaded(options?: EnsureEngineScriptsOptions): Promise<void>;
