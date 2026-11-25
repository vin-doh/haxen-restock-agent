import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The agent's own modules use explicit .ts import paths (they also run directly on Node).
  typescript: { ignoreBuildErrors: false },
  poweredByHeader: false,
};

export default nextConfig;
