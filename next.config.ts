import type { NextConfig } from "next";

// Production lives on food.trialscope.space: Clerk's production keys only work on trialscope.space and its
// subdomains, so sign-in can't succeed on the vercel.app aliases. Send visitors to the real domain instead.
const OLD_HOSTS = ["food-finder-lake.vercel.app", "food-finder-jgerson.vercel.app"];
const SITE = "https://food.trialscope.space";

const securityHeaders = [
  // Nobody may embed the app in a frame (clickjacking).
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    return OLD_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: `${SITE}/:path*`,
      permanent: false,
    }));
  },
};

export default nextConfig;
