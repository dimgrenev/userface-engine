export type EngineScriptItem = {
  src: string;
  global?: string;
  optional?: boolean;
};

export type EnsureEngineScriptsOptions = {
  debug?: boolean;
  timeoutMs?: number;
  scripts?: EngineScriptItem[];
  /** Load optional framework globals such as Vue/Svelte during engine bootstrap. */
  includeOptionalFrameworks?: boolean;
};

export declare function getEngineLoaderState(): {
  state: 'idle' | 'loading' | 'ready' | 'error';
  error: Error | null;
};

export declare function ensureEngineScriptsLoaded(options?: EnsureEngineScriptsOptions): Promise<void>;
