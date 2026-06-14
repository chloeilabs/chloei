import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"

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
  buildPrivateBlobAttachmentPathname,
  isPrivateBlobConfigured,
  uploadPrivateBlob,
} from "@/lib/server/private-blob-storage"
import {
  createRouteObservation,
  observeRouteResponse,
} from "@/lib/server/route-observability"
import {
  AGENT_ATTACHMENT_MAX_FILE_BYTES,
  getAgentAttachmentKind,
  normalizeAgentAttachmentMimeType,
} from "@/lib/shared"

export const runtime = "nodejs"

const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const requestId = resolveRequestIdFromHeaders(request.headers)
  const logger = createLogger(`uploads:${requestId}`)
  const observation = createRouteObservation({
    logger,
    method: "POST",
    requestId,
    route: "/api/uploads",
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
          "UPLOAD_UNAUTHORIZED",
          401
        ),
        {
          errorCode: "UPLOAD_UNAUTHORIZED",
          outcome: "unauthorized",
        }
      )
    }

    if (!isPrivateBlobConfigured()) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Private Blob storage is not configured.",
          "UPLOAD_BLOB_UNCONFIGURED",
          503
        ),
        {
          errorCode: "UPLOAD_BLOB_UNCONFIGURED",
          outcome: "unavailable",
        }
      )
    }

    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Missing file upload.",
          "UPLOAD_FILE_MISSING",
          400
        ),
        {
          errorCode: "UPLOAD_FILE_MISSING",
          outcome: "invalid_request",
        }
      )
    }

    const mediaType = normalizeAgentAttachmentMimeType(file.type)
    if (
      !mediaType ||
      file.size <= 0 ||
      file.size > AGENT_ATTACHMENT_MAX_FILE_BYTES
    ) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Unsupported or oversized upload.",
          "UPLOAD_FILE_INVALID",
          400
        ),
        {
          errorCode: "UPLOAD_FILE_INVALID",
          outcome: "invalid_request",
        }
      )
    }

    const attachmentIdValue = formData.get("attachmentId")
    const requestedAttachmentId =
      typeof attachmentIdValue === "string" ? attachmentIdValue.trim() : ""
    if (
      requestedAttachmentId.length > 0 &&
      !ATTACHMENT_ID_PATTERN.test(requestedAttachmentId)
    ) {
      return observeRouteResponse(
        observation,
        createErrorResponse(
          requestId,
          "Invalid attachment id.",
          "UPLOAD_ATTACHMENT_ID_INVALID",
          400
        ),
        {
          errorCode: "UPLOAD_ATTACHMENT_ID_INVALID",
          outcome: "invalid_request",
        }
      )
    }

    const attachmentId =
      requestedAttachmentId.length > 0 ? requestedAttachmentId : randomUUID()
    const pathname = buildPrivateBlobAttachmentPathname({
      userId: session.user.id,
      filename: file.name || "attachment",
      attachmentId,
    })
    const fileBuffer = Buffer.from(await file.arrayBuffer())
    const uploaded = await uploadPrivateBlob({
      pathname,
      body: fileBuffer,
      contentType: mediaType,
      signal: request.signal,
    })
    const downloadUrl = `/api/uploads/${uploaded.pathname
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`

    return observeRouteResponse(
      observation,
      Response.json(
        {
          attachment: {
            id: attachmentId,
            kind: getAgentAttachmentKind(mediaType),
            filename: file.name || "attachment",
            mediaType,
            sizeBytes: uploaded.sizeBytes,
            ...(getAgentAttachmentKind(mediaType) === "image"
              ? { detail: "auto" }
              : {}),
            blobPathname: uploaded.pathname,
            sha256: uploaded.sha256,
            downloadUrl,
          },
        },
        {
          headers: createApiHeaders({ requestId }),
        }
      ),
      {
        outcome: "success",
      }
    )
  } catch (error) {
    logger.error("Upload failed.", {
      error,
      errorCode: "UPLOAD_FAILED",
      requestId,
    })
    return observeRouteResponse(
      observation,
      createErrorResponse(requestId, "Upload failed.", "UPLOAD_FAILED", 500),
      {
        errorCode: "UPLOAD_FAILED",
        outcome: "error",
      }
    )
  }
}
