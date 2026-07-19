import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // An empty test/ directory is a valid state and must not fail `pnpm check`.
    passWithNoTests: true,
    // Isolates AGENT_HOME_PATH so no test can write the real agent home.
    setupFiles: ["./test/setup.ts"],
  },
});
