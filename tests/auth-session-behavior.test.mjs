import assert from "node:assert/strict"
import test from "node:test"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

// auth-session pulls its auth provider from "./auth" and request headers from
// "next/headers"; stub both so the session-resolution logic can be exercised
// without Better Auth or the Next.js request scope. The real e2e-test-mode is
// used as-is and driven through env + cookies.
setTestModuleStubs({
  "./auth": toProjectFileUrl("tests/stubs/auth.mjs"),
  "next/headers": toProjectFileUrl("tests/stubs/next-headers.mjs"),
})

const { getCurrentViewer, getRequestSession } = await import(
  toProjectFileUrl("src/lib/server/auth-session.ts")
)

function authProviderReturning(session, capture) {
  return {
    getAuthOrNull: () => ({
      api: {
        getSession: async ({ headers }) => {
          capture?.(headers)
          return session
        },
      },
    }),
  }
}

test("getRequestSession returns the mock viewer for e2e-authenticated requests", async () => {
  resetTestMocks()
  const savedMockAuth = process.env.E2E_MOCK_AUTH
  const savedVercelEnv = process.env.VERCEL_ENV
  process.env.E2E_MOCK_AUTH = "1"
  delete process.env.VERCEL_ENV
  try {
    const session = await getRequestSession(
      new Headers({ cookie: "chloei_e2e_auth=1" })
    )
    assert.deepEqual(session, {
      user: { id: "e2e-user", name: "E2E User", email: "e2e@example.com" },
    })
  } finally {
    if (savedMockAuth === undefined) {
      delete process.env.E2E_MOCK_AUTH
    } else {
      process.env.E2E_MOCK_AUTH = savedMockAuth
    }
    if (savedVercelEnv === undefined) {
      delete process.env.VERCEL_ENV
    } else {
      process.env.VERCEL_ENV = savedVercelEnv
    }
  }
})

test("getRequestSession returns null when auth is not configured", async () => {
  resetTestMocks()
  delete process.env.E2E_MOCK_AUTH
  setTestMocks({ auth: { getAuthOrNull: () => null } })

  assert.equal(await getRequestSession(new Headers()), null)
})

test("getRequestSession delegates to the configured auth provider", async () => {
  resetTestMocks()
  delete process.env.E2E_MOCK_AUTH
  const expectedSession = {
    user: { id: "u1", name: "Real User", email: "real@example.com" },
  }
  let receivedHeaders
  setTestMocks({
    auth: authProviderReturning(expectedSession, (headers) => {
      receivedHeaders = headers
    }),
  })

  const requestHeaders = new Headers({ "x-test": "1" })
  const session = await getRequestSession(requestHeaders)

  assert.equal(session, expectedSession)
  assert.equal(receivedHeaders, requestHeaders)
})

test("getCurrentViewer maps the resolved session user to a viewer", async () => {
  resetTestMocks()
  delete process.env.E2E_MOCK_AUTH
  setTestMocks({
    nextHeaders: new Headers(),
    auth: authProviderReturning({
      user: { id: "u2", name: "Grace", email: "grace@example.com" },
    }),
  })

  assert.deepEqual(await getCurrentViewer(), {
    id: "u2",
    name: "Grace",
    email: "grace@example.com",
  })
})

test("getCurrentViewer returns null when there is no session", async () => {
  resetTestMocks()
  delete process.env.E2E_MOCK_AUTH
  setTestMocks({
    nextHeaders: new Headers(),
    auth: { getAuthOrNull: () => null },
  })

  assert.equal(await getCurrentViewer(), null)
})
