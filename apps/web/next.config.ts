import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOTE: cacheComponents (Cache Components / PPR) is disabled intentionally.
  // This app is fully dynamic — every page uses sessionStorage, Socket.IO, and
  // client-side state. Enabling cacheComponents causes 503 errors on any route
  // that accesses runtime-only APIs (useParams, useRouter, sessionStorage).
  // cacheComponents: false is the default; omitting it here is equivalent.

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  // Allow YouTube IFrame to be embedded from our domain
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
