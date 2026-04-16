import { sql } from "kysely"
import { headers } from "next/headers"

import { createLogger } from "@/lib/logger"
import type { AuthViewer } from "@/lib/shared"

import { getAuthOrNull } from "./auth"
import { getAuthDatabase } from "./postgres"

const logger = createLogger("auth-session")

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
  const auth = getAuthOrNull()

  if (!auth) {
    return null
  }

  return auth.api.getSession({
    headers: requestHeaders,
  })
}

async function getCurrentSession(): Promise<AuthSession> {
  const auth = getAuthOrNull()

  if (!auth) {
    return null
  }

  return auth.api.getSession({
    headers: new Headers(await headers()),
  })
}

export async function getCurrentViewer(): Promise<AuthViewer | null> {
  return toViewer(await getCurrentSession())
}

export async function getViewerById(userId: string): Promise<AuthViewer | null> {
  try {
    const database = getAuthDatabase()
    const result = await sql<{
      email: string | null
      id: string
      name: string | null
    }>`
      SELECT id, name, email
      FROM "user"
      WHERE id = ${userId}
      LIMIT 1
    `.execute(database)

    const row = result.rows[0]
    if (!row) {
      return null
    }

    return {
      id: row.id,
      name: row.name ?? "",
      email: row.email ?? "",
    }
  } catch (error) {
    logger.warn(`Failed to resolve viewer ${userId}.`, error)
    return null
  }
}
