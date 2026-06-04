import { defineConfig } from 'vitest/config';

// We run logic tests in jsdom so localStorage / matchMedia exist for the
// theme + presets modules. csv.js doesn't need a DOM but inheriting one
// from the same config is harmless.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/__tests__/**/*.test.{js,jsx}'],
    globals: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
