const isProduction =
  process.env.VERCEL_ENV === "production" ||
  process.env.NODE_ENV === "production"

function parseSizeLimitFromEnv(value, fallback) {
  if (!value) {
    return fallback
  }

  const normalized = value.trim().toLowerCase()
  if (/^\d+[kmgpt]b$/.test(normalized)) {
    return normalized
  }

  return fallback
}

const serverActionsBodySizeLimit = parseSizeLimitFromEnv(
  process.env.NEXT_SERVER_ACTIONS_BODY_SIZE_LIMIT,
  "1mb"
)
const proxyClientMaxBodySize = parseSizeLimitFromEnv(
  process.env.NEXT_PROXY_CLIENT_MAX_BODY_SIZE,
  "1mb"
)

const securityHeaders = [
  { key: "X-DNS-Prefetch-Control", value: "on" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
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
