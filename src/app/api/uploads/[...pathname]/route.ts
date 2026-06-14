import { type NextRequest } from "next/server"

import { createLogger } from "@/lib/logger"
import { resolveRequestIdFromHeaders } from "@/lib/request-id"
import {
  createApiHeaders,
  createErrorResponse,
} from "@/lib/server/api-response"
import {
  createAuthUnavailableResponse,
  isAuthConfigured,
} from "@/lib/server/auth"
import { getRequestSession } from "@/lib/server/auth-session"
import {
  normalizeBlobPathname,
  readPrivateBlob,
} from "@/lib/server/private-blob-storage"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"

export const runtime = "nodejs"

interface UploadDownloadRouteContext {
  params: Promise<{
    pathname: string[]
  }>
}

function getDownloadFilename(pathname: string): string {
  const filename = pathname
    .split("/")
    .at(-1)
    ?.replace(/["\r\n]/g, "_")
  return filename ?? "attachment"
}

export async function GET(
  request: NextRequest,
  context: UploadDownloadRouteContext
) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`upload-download:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "GET",
    requestId,
    route: "/api/uploads/[...pathname]",
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
          "UPLOAD_DOWNLOAD_UNAUTHORIZED",
          401
        ),
        {
          errorCode: "UPLOAD_DOWNLOAD_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    const params = await context.params
    const pathname = normalizeBlobPathname(params.pathname.join("/"))
    if (!pathname) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid upload path.",
          "UPLOAD_DOWNLOAD_INVALID_PATH",
          400
        ),
        {
          errorCode: "UPLOAD_DOWNLOAD_INVALID_PATH",
          outcome: "invalid_request",
        }
      )
    }

    const blob = await readPrivateBlob({
      pathname,
      userId: session.user.id,
      signal: request.signal,
    })
    if (!blob) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Upload not found.",
          "UPLOAD_DOWNLOAD_NOT_FOUND",
          404
        ),
        {
          errorCode: "UPLOAD_DOWNLOAD_NOT_FOUND",
          outcome: "not_found",
        }
      )
    }

    const headers = createApiHeaders({ requestId })
    headers.set("Cache-Control", "private, no-store")
    headers.set("Content-Length", String(blob.sizeBytes))
    headers.set("Content-Type", blob.contentType)
    headers.set(
      "Content-Disposition",
      `attachment; filename="${getDownloadFilename(pathname)}"`
    )

    return observeRouteResponse(
      observation,
      new Response(new Uint8Array(blob.buffer), { headers }),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    logger.error("Upload download failed.", {
      error,
      errorCode: "UPLOAD_DOWNLOAD_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(
        requestId,
        "Download failed.",
        "UPLOAD_DOWNLOAD_FAILED",
        500
      ),
      {
        errorCode: "UPLOAD_DOWNLOAD_FAILED",
        outcome: "error",
      }
    )
  }
}
