import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Match the package build: TS sources are authoritative when legacy JS
  // siblings exist. Node consumers are verified separately against dist.
  resolve: { extensions: ['.mts', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'] },
  test: {
    environment: 'node',
    include: [
      'packages/engine/src/__tests__/**/*.test.ts',
      'packages/engine/src/storybook/__tests__/**/*.test.ts',
      'packages/userface/__tests__/**/*.test.ts',
    ],
  },
});
