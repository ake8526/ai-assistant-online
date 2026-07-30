import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    ];
  },
};

export default nextConfig;
