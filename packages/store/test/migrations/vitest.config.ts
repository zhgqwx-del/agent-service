import { defineConfig } from "vitest/config";

// Deliberately separate from the normal Vitest include (*.test.ts). The migration suite needs a
// destructive, real-MySQL fixture and must only run through the explicit test:migrations gate.
export default defineConfig({
  test: {
    include: ["packages/store/test/migrations/**/*.migration.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
