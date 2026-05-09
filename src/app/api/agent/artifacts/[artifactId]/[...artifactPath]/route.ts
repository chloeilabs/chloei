import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  getAgentArtifactFilePath,
  normalizeAgentArtifactId,
  normalizeAgentArtifactPath,
} from "@/lib/server/agent-artifacts"
import {
  createApiErrorResponse,
  createApiHeaders,
} from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

interface ArtifactRouteContext {
  params: Promise<{
    artifactId: string
    artifactPath: string[]
  }>
}

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

function createErrorResponse(
  requestId: string,
  error: string,
  errorCode: string,
  status: number
) {
  return createApiErrorResponse({
    requestId,
    error,
    errorCode,
    status,
  })
}

function getContentType(relativePath: string): string {
  return (
    CONTENT_TYPES_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ??
    "application/octet-stream"
  )
}

function getDownloadFilename(relativePath: string): string {
  return path.basename(relativePath).replace(/["\r\n]/g, "_") || "artifact"
}

export async function GET(request: NextRequest, context: ArtifactRouteContext) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`agent-artifact:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/agent/artifacts/[artifactId]/[...artifactPath]",
  })

  try {
    if (!isAuthConfigured()) {
      return observeRouteResponse(
        observation,
        createAuthUnavailableResponse(createApiHeaders({ requestId })),
        {
          errorCode: "AUTH_UNAVAILABLE",
          outcome: "auth_unavailable",
        }
      )
    }

    const session = await getRequestSession(request.headers)
    if (!session) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Unauthorized.",
          "AGENT_ARTIFACT_UNAUTHORIZED",
          401
        ),
        {
          errorCode: "AGENT_ARTIFACT_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const params = await context.params
    const artifactId = normalizeAgentArtifactId(params.artifactId)
    const relativePath = normalizeAgentArtifactPath(
      params.artifactPath.join("/")
    )
    if (!artifactId || !relativePath) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid artifact path.",
          "AGENT_ARTIFACT_INVALID_PATH",
          400
        ),
        {
          errorCode: "AGENT_ARTIFACT_INVALID_PATH",
          outcome: "invalid_request",
        }
      )
    }

    const artifactPath = getAgentArtifactFilePath({
      artifactId,
      relativePath,
      userId: session.user.id,
    })
    if (!artifactPath) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid artifact path.",
          "AGENT_ARTIFACT_INVALID_PATH",
          400
        ),
        {
          errorCode: "AGENT_ARTIFACT_INVALID_PATH",
          outcome: "invalid_request",
        }
      )
    }

    const artifactStats = await stat(artifactPath).catch(() => null)
    if (!artifactStats?.isFile()) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Artifact not found.",
          "AGENT_ARTIFACT_NOT_FOUND",
          404
        ),
        {
          errorCode: "AGENT_ARTIFACT_NOT_FOUND",
          outcome: "not_found",
        }
      )
    }

    const artifact = await readFile(artifactPath)
    const headers = createApiHeaders({ requestId })
    headers.set("Content-Type", getContentType(relativePath))
    headers.set("Content-Length", String(artifactStats.size))
    headers.set(
      "Content-Disposition",
      `attachment; filename="${getDownloadFilename(relativePath)}"`
    )

    return observeRouteResponse(
      observation,
      new Response(artifact, {
        headers,
      }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    logger.error("Artifact download failed.", {
      error,
      errorCode: "AGENT_ARTIFACT_DOWNLOAD_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Failed to download artifact.",
        "AGENT_ARTIFACT_DOWNLOAD_FAILED",
        500
      ),
      {
        errorCode: "AGENT_ARTIFACT_DOWNLOAD_FAILED",
        outcome: "error",
      }
    )
  }
}
