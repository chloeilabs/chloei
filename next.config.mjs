import { withSentryConfig } from "@sentry/nextjs"

const isProduction =
  process.env.VERCEL_ENV === "production" ||
  process.env.NODE_ENV === "production"
const isDesktopBuild = process.env.CHLOEI_DESKTOP_BUILD === "1"

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
const generatedOutputFileTracingExcludes = [
  "./desktop-build/**/*",
  "./dist/**/*",
  "./test-results/**/*",
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  ...(isDesktopBuild
    ? {
        output: "standalone",
        outputFileTracingExcludes: {
          "**": generatedOutputFileTracingExcludes,
          "/api/agent": [
            ...generatedOutputFileTracingExcludes,
            "./CLAUDE.md",
            "./README.md",
            "./app-migrate.mjs",
            "./auth.ts",
            "./components.json",
            "./eslint.config.mjs",
            "./evals/**/*",
            "./next.config.mjs",
            "./tests/**/*",
          ],
        },
      }
    : {}),
  serverExternalPackages: ["@napi-rs/canvas"],
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
