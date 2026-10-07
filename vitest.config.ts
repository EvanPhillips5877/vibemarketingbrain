import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./tests/global-setup.ts",
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1, // one shared test database: run files serially
    testTimeout: 20000,
  },
});
