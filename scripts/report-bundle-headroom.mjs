import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const projectRoot = process.cwd()
const chunksDir = path.join(projectRoot, ".next", "static", "chunks")
const routeStatsPath = path.join(
  projectRoot,
  ".next",
  "diagnostics",
  "route-bundle-stats.json"
)

function readPositiveBytesEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number; got "${raw}".`)
  }
  return parsed
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got "${raw}".`)
  }
  return parsed
}

function formatBytes(value) {
  return `${(value / 1024 / 1024).toFixed(2)} MiB`
}

function collectJavaScriptFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath)
    }
  }

  return files
}

function getFileSizes() {
  if (!existsSync(chunksDir)) {
    throw new Error("Missing .next/static/chunks. Run `pnpm build` first.")
  }

  return collectJavaScriptFiles(chunksDir)
    .map((filePath) => ({
      path: path.relative(projectRoot, filePath),
      size: statSync(filePath).size,
    }))
    .toSorted((a, b) => b.size - a.size)
}

function readRouteStats() {
  if (!existsSync(routeStatsPath)) {
    return []
  }

  const parsed = JSON.parse(readFileSync(routeStatsPath, "utf8"))
  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed
    .flatMap((entry) => {
      if (
        typeof entry?.route !== "string" ||
        typeof entry?.firstLoadUncompressedJsBytes !== "number"
      ) {
        return []
      }

      return [
        {
          route: entry.route,
          firstLoadUncompressedJsBytes: entry.firstLoadUncompressedJsBytes,
          firstLoadUncompressedJs: formatBytes(
            entry.firstLoadUncompressedJsBytes
          ),
          chunkCount: Array.isArray(entry.firstLoadChunkPaths)
            ? entry.firstLoadChunkPaths.length
            : 0,
        },
      ]
    })
    .toSorted(
      (a, b) => b.firstLoadUncompressedJsBytes - a.firstLoadUncompressedJsBytes
    )
}

const maxTotalBytes = readPositiveBytesEnv(
  "BUNDLE_MAX_STATIC_CHUNKS_BYTES",
  14 * 1024 * 1024
)
const maxChunkBytes = readPositiveBytesEnv(
  "BUNDLE_MAX_STATIC_CHUNK_BYTES",
  1024 * 1024
)
const topCount = readPositiveIntegerEnv("BUNDLE_REPORT_TOP_N", 12)
const fileSizes = getFileSizes()
const totalBytes = fileSizes.reduce((total, file) => total + file.size, 0)
const largestChunk = fileSizes[0] ?? null

console.log(
  JSON.stringify(
    {
      budgets: {
        maxChunkBytes,
        maxChunk: formatBytes(maxChunkBytes),
        maxTotalBytes,
        maxTotal: formatBytes(maxTotalBytes),
      },
      staticChunks: {
        count: fileSizes.length,
        totalBytes,
        total: formatBytes(totalBytes),
        totalHeadroomBytes: maxTotalBytes - totalBytes,
        totalHeadroom: formatBytes(maxTotalBytes - totalBytes),
        largestChunk: largestChunk
          ? {
              ...largestChunk,
              sizeFormatted: formatBytes(largestChunk.size),
              headroomBytes: maxChunkBytes - largestChunk.size,
              headroom: formatBytes(maxChunkBytes - largestChunk.size),
            }
          : null,
        topChunks: fileSizes.slice(0, topCount).map((file) => ({
          ...file,
          sizeFormatted: formatBytes(file.size),
        })),
      },
      routes: readRouteStats().slice(0, topCount),
    },
    null,
    2
  )
)
