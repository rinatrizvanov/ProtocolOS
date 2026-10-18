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
  // The FastAPI engine runs as a separate process; the browser only ever talks to this origin.
  async rewrites() {
    const api = process.env.TRIALLENS_API_URL ?? "http://127.0.0.1:8765";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
};

export default nextConfig;
