import { headers } from "next/headers"

import type { AuthViewer } from "@/lib/shared"

import { getAuthOrNull } from "./auth"
import { E2E_MOCK_VIEWER, isE2eAuthenticatedRequest } from "./e2e-test-mode"

interface AuthSessionUser {
  id: string
  name: string
  email: string
}

interface AuthSessionValue {
  user: AuthSessionUser
}

type AuthSession = AuthSessionValue | null

function toViewer(session: AuthSession): AuthViewer | null {
  if (!session) {
    return null
  }

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
  }
}

export async function getRequestSession(
  requestHeaders: Headers
): Promise<AuthSession> {
  if (isE2eAuthenticatedRequest(requestHeaders)) {
    return {
      user: E2E_MOCK_VIEWER,
    }
  }

  const auth = getAuthOrNull()

  if (!auth) {
    return null
  }

  return auth.api.getSession({
    headers: requestHeaders,
  })
}

async function getCurrentSession(): Promise<AuthSession> {
  const requestHeaders = new Headers(await headers())

  if (isE2eAuthenticatedRequest(requestHeaders)) {
    return {
      user: E2E_MOCK_VIEWER,
    }
  }

  const auth = getAuthOrNull()

  if (!auth) {
    return null
  }

  return auth.api.getSession({
    headers: requestHeaders,
  })
}

export async function getCurrentViewer(): Promise<AuthViewer | null> {
  return toViewer(await getCurrentSession())
}
