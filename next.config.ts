import type { NextConfig } from 'next';

const config: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  async rewrites() {
    const apiOrigin = process.env.RESTORE_API_URL || 'http://127.0.0.1:8000';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default config;
