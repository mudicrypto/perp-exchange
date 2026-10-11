import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
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
