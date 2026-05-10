import { access, cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const rootDir = path.resolve(import.meta.dirname, "..")
const nextDir = path.join(rootDir, ".next")
const standaloneDir = path.join(rootDir, ".next", "standalone")
const serverPath = path.join(standaloneDir, "server.js")

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyIfExists(sourcePath, destinationPath) {
  if (!(await exists(sourcePath))) {
    return
  }

  await mkdir(path.dirname(destinationPath), { recursive: true })
  await cp(sourcePath, destinationPath, {
    force: true,
    recursive: true,
  })
}

if (!(await exists(serverPath))) {
  console.error(
    "Missing .next/standalone/server.js. Run `pnpm build` before starting the production server."
  )
  process.exit(1)
}

await copyIfExists(
  path.join(nextDir, "static"),
  path.join(standaloneDir, ".next", "static")
)
await copyIfExists(
  path.join(rootDir, "public"),
  path.join(standaloneDir, "public")
)

process.env.HOSTNAME ??= "0.0.0.0"
process.env.PORT ??= "3000"
process.env.NODE_ENV ??= "production"

process.chdir(standaloneDir)
await import(pathToFileURL(serverPath).href)
