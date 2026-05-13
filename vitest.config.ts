import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/engine/src/__tests__/**/*.test.ts',
      'packages/engine/src/storybook/__tests__/**/*.test.ts',
      'packages/userface/__tests__/**/*.test.ts',
    ],
  },
});
