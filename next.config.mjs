const isProduction =
  process.env.VERCEL_ENV === "production" ||
  process.env.NODE_ENV === "production"

const serverActionsBodySizeLimit = "1mb"
const proxyClientMaxBodySize = "12mb"

function buildContentSecurityPolicy() {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "font-src 'self' data:",
    "img-src 'self' data: https://www.google.com https://t0.gstatic.com https://t1.gstatic.com https://t2.gstatic.com https://t3.gstatic.com",
    "media-src 'self' data:",
    "connect-src 'self' https://va.vercel-scripts.com",
    "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ]

  return directives.join("; ")
}

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        {
          key: "Content-Security-Policy",
          value: buildContentSecurityPolicy(),
        },
      ]
    : []),
]
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      bodySizeLimit: serverActionsBodySizeLimit,
    },
    proxyClientMaxBodySize,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "www.google.com",
        pathname: "/s2/favicons",
      },
      {
        protocol: "https",
        hostname: "t0.gstatic.com",
        pathname: "/faviconV2",
      },
      {
        protocol: "https",
        hostname: "t1.gstatic.com",
        pathname: "/faviconV2",
      },
      {
        protocol: "https",
        hostname: "t2.gstatic.com",
        pathname: "/faviconV2",
      },
      {
        protocol: "https",
        hostname: "t3.gstatic.com",
        pathname: "/faviconV2",
      },
    ],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
