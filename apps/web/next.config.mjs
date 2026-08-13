/** @type {import('next').NextConfig} */
const nextConfig = {
  // @docuflow/shared ships raw TS — let Next compile it.
  transpilePackages: ['@docuflow/shared'],
};

export default nextConfig;
