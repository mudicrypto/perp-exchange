import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** `VITEST_LIVE=1` runs only the live contract tests (network required). */
const live = process.env.VITEST_LIVE === "1";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition; tests run server modules directly.
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: live ? ["src/**/*.live.test.ts"] : ["src/**/*.test.{ts,tsx}"],
    // Live contract tests need network access; run them with `npm run test:live`.
    exclude: live ? ["node_modules/**"] : ["src/**/*.live.test.ts", "node_modules/**"],
    restoreMocks: true,
  },
});
