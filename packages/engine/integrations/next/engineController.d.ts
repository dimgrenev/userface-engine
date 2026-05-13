export interface UserfaceRenderResult {
  type?: string;
  data?: unknown;
  error?: string | null;
}

export interface UserfaceEngine {
  ready?: boolean;
  analyzeComponent?: (
    files: Array<{ name: string; content: string }>,
    options?: { entryPath?: string },
  ) => Promise<unknown>;
  renderFromSpec?: (
    name: string,
    props: Record<string, unknown>,
    mode?: 'ssr' | 'live',
  ) => Promise<UserfaceRenderResult>;
  getComponentSpec?: (name: string) => unknown;
}

export declare function ensureEngineReady(options?: { debug?: boolean }): Promise<UserfaceEngine>;

export declare function analyzeComponentWithEngine(
  engine: UserfaceEngine,
  files: Array<{ name: string; content: string; type?: string }>,
  options: { entryPath: string },
): Promise<unknown>;

export declare function renderComponentWithEngine(
  engine: UserfaceEngine,
  specName: string,
  props: Record<string, unknown>,
  mode?: 'live' | 'ssr',
): Promise<UserfaceRenderResult>;

export declare function resetCachedEngine(): void;
