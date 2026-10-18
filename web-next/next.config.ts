import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The FastAPI engine runs separately on :8766; the browser only ever talks to this origin.
  async rewrites() {
    return [{ source: "/api/:path*", destination: "http://127.0.0.1:8766/api/:path*" }];
  },
};

export default nextConfig;
