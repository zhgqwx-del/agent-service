import { defineConfig } from "vitest/config";

export default defineConfig({
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
      // A floor just below the measured numbers (74.4 / 63.5 / 70.7 / 78.7 with every source file
      // counted, not only those a test happens to import). It catches a regression without failing on
      // noise. Raise these as coverage improves; never lower them to turn a red build green.
      thresholds: { statements: 72, branches: 61, functions: 68, lines: 76 },
    },
  },
});
