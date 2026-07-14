/** @type {import('next').NextConfig} */
const nextConfig = {
  // These ship native/binary payloads (a Chromium build, in @sparticuz's case).
  // They must stay external so Next doesn't try to trace or bundle their guts.
  serverExternalPackages: ["playwright", "playwright-core", "@sparticuz/chromium"],
};

export default nextConfig;
