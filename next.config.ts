import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@paypal/agent-toolkit"],
};

export default nextConfig;
