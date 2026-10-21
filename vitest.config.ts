import { defineConfig } from "vitest/config";

export default defineConfig({
  // Integration resources are explicit; never let Vite load a developer's ambient .env files.
  envDir: false,
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Cluster tests spawn real processes, and the MySQL/Redis conformance suite shares one database;
    // running files in parallel would have them fight over ports and rows.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["**/*.d.ts", "packages/testkit/**"],
      reporter: ["text", "json-summary", "html"],
      // Current full-verify baseline: 78.84 / 74.75 / 85.17 / 81.65 with every source file counted,
      // not only those a test happens to import. The lower floor catches a material regression without
      // failing on small instrumentation changes; raise it deliberately as coverage stabilizes.
      thresholds: { statements: 72, branches: 61, functions: 68, lines: 76 },
    },
  },
});
