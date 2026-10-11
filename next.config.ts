import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * The browser may only talk to this origin and the venue's public websocket
 * endpoints. REST venue access goes through our own /api routes.
 */
const connectSources = [
  "'self'",
  "wss://api.hyperliquid.xyz",
  "wss://api.hyperliquid-testnet.xyz",
  ...(isDev ? ["ws:"] : []),
];

/*
 * 'unsafe-inline' for scripts is required by the static shell that Cache
 * Components / Partial Prerendering emit; nonce-based CSP is incompatible
 * with PPR (see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 * Tracked as an open risk in docs/SECURITY.md. Mitigations: no raw HTML
 * rendering anywhere, strict connect-src, object-src 'none', no framing.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src ${connectSources.join(" ")}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          // Ignored by browsers over plain HTTP; effective once served over TLS.
          ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
        ],
      },
    ];
  },
};

export default nextConfig;
