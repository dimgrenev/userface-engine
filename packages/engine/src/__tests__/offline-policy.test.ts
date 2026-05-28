import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { installOfflineExecutionPolicy, withOfflineExecutionPolicy } from '../offline-policy';

let restorePolicy: (() => void) | null = null;

afterEach(() => {
  restorePolicy?.();
  restorePolicy = null;
});

describe('offline execution policy', () => {
  it('blocks fetch, http and raw sockets while installed', async () => {
    restorePolicy = installOfflineExecutionPolicy('test offline policy');

    await expect(fetch('https://example.com')).rejects.toThrow('network access is blocked');
    expect(() => http.get('http://example.com')).toThrow('network access is blocked');
    expect(() => net.connect(443, 'example.com')).toThrow('network access is blocked');
  });

  it('restores network primitives after the guarded callback exits', async () => {
    const originalFetch = globalThis.fetch;
    const originalHttpGet = http.get;

    await withOfflineExecutionPolicy(true, 'test offline policy', async () => {
      expect(globalThis.fetch).not.toBe(originalFetch);
      expect(http.get).not.toBe(originalHttpGet);
    });

    expect(globalThis.fetch).toBe(originalFetch);
    expect(http.get).toBe(originalHttpGet);
  });
});
