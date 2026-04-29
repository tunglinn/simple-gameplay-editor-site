import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Run in Node.js — no DOM needed for pure utility tests.
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
  },
});
