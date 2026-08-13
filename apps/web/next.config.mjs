/** @type {import('next').NextConfig} */
const nextConfig = {
  // @ingestio/shared ships raw TS — let Next compile it.
  transpilePackages: ['@ingestio/shared'],
};

export default nextConfig;
