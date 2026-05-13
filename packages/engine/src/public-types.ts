export type UfErrorCode = `UF${number}${number}${number}`;

export type UfErrorOwner = 'renderer' | 'component' | 'compat' | 'engine';
export type UfErrorPhase =
  | 'engine_init'
  | 'engine_analyze'
  | 'engine_render'
  | 'iframe_load'
  | 'iframe_render'
  | 'iframe_update_props'
  | 'host_compile'
  | 'unknown';

export type UfErrorPayload = {
  code: UfErrorCode;
  phase: UfErrorPhase | string;
  owner: UfErrorOwner | string;
  message: string;
  details?: any;
};

export type EngineEntryPathOptions = {
  entryPath: string;
};

export type EngineAnalyzeFile = { name: string; content: string };

export type EngineRenderMode = 'live' | 'ssr';

export type EngineRenderData = {
  componentCode: string;
  componentName: string;
  styles?: string;
  props?: any;
  files?: any;
  diagnostics?: any;
};

export type EngineRenderResult = {
  type: string;
  data: EngineRenderData;
};

export type EngineDiagnostics = {
  entryPath?: string;
  specId?: string;
  filesHash?: string;
  stylesHash?: string;
  codeHash?: string;
};

// State matrix types (re-exported for convenience)
export type { StateEntry, GenerateStatesOptions } from './stateMatrix';
