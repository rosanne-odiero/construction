import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// The browser only ever calls same-origin /api/*; Next.js forwards it to the API (ARCHITECTURE D-16),
// so auth cookies stay first-party. Rewrites are fixed at build time: set API_INTERNAL_URL then.
const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // Browser tests must not contend with an already-running developer server.
  distDir: process.env.PLAYWRIGHT_TEST === "1" ? ".next-e2e" : ".next",
  // Cache Components is off for the D0 prototype: the locale cookie is read on every request.
  // Revisit in D1.2 when real data fetching lands.
  // Keeps the dev-only Next.js badge clear of the sidebar footer links.
  devIndicators: { position: "bottom-right" },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withNextIntl(nextConfig);
