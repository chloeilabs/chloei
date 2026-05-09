import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

const DEFAULT_AGENT_ARTIFACT_ROOT = path.join(
  tmpdir(),
  "chloei-agent-artifacts"
)
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
const MAX_ARTIFACT_PATH_CHARS = 500

const configuredAgentArtifactRoot = process.env.AGENT_ARTIFACT_ROOT?.trim()
export const AGENT_ARTIFACT_ROOT =
  configuredAgentArtifactRoot && configuredAgentArtifactRoot.length > 0
    ? configuredAgentArtifactRoot
    : DEFAULT_AGENT_ARTIFACT_ROOT

function getArtifactUserKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex")
}

export function normalizeAgentArtifactId(value: string): string | null {
  const normalized = value.trim()
  return ARTIFACT_ID_PATTERN.test(normalized) ? normalized : null
}

export function normalizeAgentArtifactPath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/")
  if (
    !normalized ||
    normalized.length > MAX_ARTIFACT_PATH_CHARS ||
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return null
  }

  const segments = normalized.split("/")
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\0")
    )
  ) {
    return null
  }

  return segments.join("/")
}

export function getAgentArtifactRunRoot(params: {
  artifactId: string
  userId: string
}): string {
  return path.join(
    AGENT_ARTIFACT_ROOT,
    getArtifactUserKey(params.userId),
    params.artifactId
  )
}

export function getAgentArtifactWorkspaceRoot(params: {
  artifactId: string
  userId: string
}): string {
  return path.join(getAgentArtifactRunRoot(params), "workspace")
}

export function getAgentArtifactFilePath(params: {
  artifactId: string
  relativePath: string
  userId: string
}): string | null {
  const artifactId = normalizeAgentArtifactId(params.artifactId)
  const relativePath = normalizeAgentArtifactPath(params.relativePath)
  if (!artifactId || !relativePath) {
    return null
  }

  const workspaceRoot = getAgentArtifactWorkspaceRoot({
    artifactId,
    userId: params.userId,
  })
  const filePath = path.resolve(workspaceRoot, relativePath)
  const normalizedRoot = path.resolve(workspaceRoot)
  if (
    filePath !== normalizedRoot &&
    filePath.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    return filePath
  }

  return null
}

export function buildAgentArtifactDownloadUrl(
  artifactId: string,
  relativePath: string
): string | null {
  const normalizedArtifactId = normalizeAgentArtifactId(artifactId)
  const normalizedPath = normalizeAgentArtifactPath(relativePath)
  if (!normalizedArtifactId || !normalizedPath) {
    return null
  }

  const encodedPath = normalizedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")

  return `/api/agent/artifacts/${encodeURIComponent(normalizedArtifactId)}/${encodedPath}`
}

export function buildAgentArtifactBaseUrl(artifactId: string): string | null {
  const placeholderPath = "__artifact_base__"
  const placeholderUrl = buildAgentArtifactDownloadUrl(
    artifactId,
    placeholderPath
  )
  if (!placeholderUrl) {
    return null
  }

  const placeholderSuffix = `/${placeholderPath}`
  return placeholderUrl.endsWith(placeholderSuffix)
    ? placeholderUrl.slice(0, -placeholderSuffix.length)
    : null
}
