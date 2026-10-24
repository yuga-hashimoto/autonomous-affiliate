import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    env: {
      NODE_ENV: "test",
    },
  },
});
