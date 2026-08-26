import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "10.10.10.44",
    "10.10.10.44:3000",
    "10.10.10.44:3001",
    "localhost",
    "localhost:3000",
  ],
  // Include Thai fonts used when generating the LINE rich-menu PNG.
  outputFileTracingIncludes: {
    "/api/line/rich-menu": ["./assets/fonts/**/*", "./assets/line-rich-menu.png"],
  },
  // The LINE in-app webview caches HTML aggressively, which left users on old
  // page code (e.g. the removed auto-link). Tell it never to cache the HTML of
  // these interactive pages so the latest build is always fetched. Hashed
  // /_next/static chunks stay long-cached as usual.
  async headers() {
    return [
      {
        source: "/:path(line-link|account|consents|settings|setup)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
      {
        source: "/:path(home.html|system-functions.html|test-plan.html)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // Canonical landing page
      { source: "/system-functions.html", destination: "/home.html", permanent: true },
      { source: "/functions.html", destination: "/home.html", permanent: true },
      { source: "/functions-th.html", destination: "/home.html", permanent: true },
    ];
  },
  async rewrites() {
    return [
      // Live home page — fetch latest HTML from GitHub (no redeploy for copy tweaks)
      { source: "/home.html", destination: "/home-html" },
    ];
  },
};

export default nextConfig;
