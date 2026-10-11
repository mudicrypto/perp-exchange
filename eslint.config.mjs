import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The venue prototype (src/venue) stays disconnected: nothing in the app may import it.
const VENUE_ISOLATION = { regex: "^(@/venue|(\\.\\./)+venue)(/|$)", message: "The local venue prototype must not be wired into the app, server or adapters." };

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/venue/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [VENUE_ISOLATION] }] },
  },
  {
    // Architecture boundary: the domain core stays venue- and framework-agnostic.
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/adapters/*", "@/features/*", "@/app/*", "@/server/*", "@/config/*"], message: "core must not depend on outer layers." },
            { group: ["react", "react-dom", "next", "next/*"], message: "core must not depend on React or Next.js." },
            VENUE_ISOLATION,
          ],
        },
      ],
    },
  },
  {
    // The UI consumes domain types only; venue wire formats stay inside their adapter.
    files: ["src/features/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/adapters/*/wire-schemas", "@/adapters/*/mappers"], message: "Use domain types, not venue wire formats." },
            VENUE_ISOLATION,
          ],
        },
      ],
    },
  },
  {
    // The AI analyst is read-only: it may not reach any code that can submit, cancel or modify orders.
    files: ["src/server/analyst/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/core/trading", "@/core/trading/*", "@/core/ports/execution"], message: "The analyst must not import execution code." },
            { group: ["@/adapters/*/*-adapter", "@/adapters/http/*", "@/server/rfq/rfq-service", "@/features/*"], message: "The analyst must not import execution or client code." },
            VENUE_ISOLATION,
          ],
        },
      ],
    },
  },
  {
    // The venue prototype is standalone and local-only: no app code, no network, no file system.
    // Node runs its CLIs with type stripping, so imports are relative with `.ts` and types use `import type`.
    files: ["src/venue/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^@/", message: "The venue prototype is standalone: use relative imports." },
            { group: ["react", "react-dom", "next", "next/*", "server-only", "ws", "undici", "@anthropic-ai/*"], message: "The venue prototype is framework-free and offline." },
            {
              regex: "^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads|fs|fs/promises)$",
              message: "The venue prototype is local-only: no network, subprocesses or file system.",
            },
          ],
        },
      ],
      "no-restricted-globals": ["error", "fetch", "WebSocket", "XMLHttpRequest", "EventSource"],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Venue tests may read repository files (documentation and isolation checks), but still no network.
    files: ["src/venue/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: "^@/", message: "The venue prototype is standalone: use relative imports." },
            { regex: "^(node:)?(http|https|http2|net|tls|dgram|dns|child_process|cluster|worker_threads)$", message: "Venue tests are offline." },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    "coverage/**",
  ]),
]);

export default eslintConfig;
