import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
        source: "/:path(line-link|account|consents|settings)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
      {
        source: "/:path(homehtml|system-functions.html)",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // Old landing URL → new short path
      { source: "/system-functions.html", destination: "/homehtml", permanent: true },
      { source: "/functions.html", destination: "/homehtml", permanent: true },
      { source: "/functions-th.html", destination: "/homehtml", permanent: true },
    ];
  },
  async rewrites() {
    return [
      // Clean URL without .html — serves public/system-functions.html
      { source: "/homehtml", destination: "/system-functions.html" },
    ];
  },
};

export default nextConfig;
