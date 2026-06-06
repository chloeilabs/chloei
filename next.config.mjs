import { withSentryConfig } from "@sentry/nextjs"

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
  "12mb"
)

function buildContentSecurityPolicy() {
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "font-src 'self' data:",
    "img-src 'self' blob: data: https://www.google.com https://t0.gstatic.com https://t1.gstatic.com https://t2.gstatic.com https://t3.gstatic.com",
    "media-src 'self' blob: data:",
    "connect-src 'self' https://va.vercel-scripts.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
    "script-src 'self' 'unsafe-inline' https://va.vercel-scripts.com",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
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
  // yahoo-finance2 (used lazily by the finance_data Yahoo provider) ships Deno
  // shims and a large schema tree; bundling it balloons the server build, so
  // require it at runtime from node_modules instead.
  serverExternalPackages: ["@napi-rs/canvas", "yahoo-finance2"],
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

export default withSentryConfig(nextConfig, {
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  disableLogger: true,
})
