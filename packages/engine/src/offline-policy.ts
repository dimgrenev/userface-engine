import { createRequire } from 'node:module';

type RestoreFn = () => void;

const runtimeRequire = createRequire(`${process.cwd()}/package.json`);

function offlineError(label: string): Error {
  return new Error(`${label} is running with offline policy; network access is blocked.`);
}

export function installOfflineExecutionPolicy(label = 'userface offline command'): RestoreFn {
  const restores: RestoreFn[] = [];
  const originalFetch = globalThis.fetch;

  if (originalFetch) {
    globalThis.fetch = (() => Promise.reject(offlineError(label))) as typeof fetch;
    restores.push(() => {
      globalThis.fetch = originalFetch;
    });
  }

  const http = runtimeRequire('node:http') as typeof import('node:http');
  const https = runtimeRequire('node:https') as typeof import('node:https');
  const net = runtimeRequire('node:net') as typeof import('node:net');
  const tls = runtimeRequire('node:tls') as typeof import('node:tls');

  const httpRequest = http.request;
  const httpGet = http.get;
  const httpsRequest = https.request;
  const httpsGet = https.get;
  const netConnect = net.connect;
  const netCreateConnection = net.createConnection;
  const tlsConnect = tls.connect;

  http.request = (() => {
    throw offlineError(label);
  }) as typeof http.request;
  http.get = (() => {
    throw offlineError(label);
  }) as typeof http.get;
  https.request = (() => {
    throw offlineError(label);
  }) as typeof https.request;
  https.get = (() => {
    throw offlineError(label);
  }) as typeof https.get;
  net.connect = (() => {
    throw offlineError(label);
  }) as typeof net.connect;
  net.createConnection = (() => {
    throw offlineError(label);
  }) as typeof net.createConnection;
  tls.connect = (() => {
    throw offlineError(label);
  }) as typeof tls.connect;

  restores.push(() => {
    http.request = httpRequest;
    http.get = httpGet;
    https.request = httpsRequest;
    https.get = httpsGet;
    net.connect = netConnect;
    net.createConnection = netCreateConnection;
    tls.connect = tlsConnect;
  });

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

export async function withOfflineExecutionPolicy<T>(
  enabled: boolean,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!enabled) return run();
  const restore = installOfflineExecutionPolicy(label);
  try {
    return await run();
  } finally {
    restore();
  }
}
