import type { NextConfig } from "next";

// Static export for S3 + CloudFront. CAFF has no server code: everything goes
// through supabase-js in the browser, protected by Supabase Auth and RLS.
// Dynamic [id] routes are prerendered once as "_" and a CloudFront Function
// serves that page for every real id (see infra/caff-site.yaml).
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
