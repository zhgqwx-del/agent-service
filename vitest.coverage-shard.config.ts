import { defineConfig } from "vitest/config";
import canonical from "./vitest.config.js";

// Collection is NOT a coverage gate. Each blob contains the native Istanbul map;
// only merge-main-coverage runs the unchanged canonical coverage thresholds.
export default defineConfig({
  ...canonical,
  // The collector's closed profile environment must not be repopulated by Vite env files.
  envDir: false,
  test: {
    ...canonical.test,
    coverage: { ...canonical.test?.coverage, thresholds: undefined, reporter: [] },
  },
});
