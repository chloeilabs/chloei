import { toNextJsHandler } from "better-auth/next-js"

import { createAuthUnavailableResponse, getAuthOrNull } from "@/lib/server/auth"

export const runtime = "nodejs"

type AuthMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

async function handleAuthRequest(method: AuthMethod, request: Request) {
  const auth = getAuthOrNull()

  if (!auth) {
    return createAuthUnavailableResponse()
  }

  const authHandler = toNextJsHandler(auth)
  return authHandler[method](request)
}

export async function GET(request: Request) {
  return handleAuthRequest("GET", request)
}

export async function POST(request: Request) {
  return handleAuthRequest("POST", request)
}

export async function PATCH(request: Request) {
  return handleAuthRequest("PATCH", request)
}

export async function PUT(request: Request) {
  return handleAuthRequest("PUT", request)
}

export async function DELETE(request: Request) {
  return handleAuthRequest("DELETE", request)
}
