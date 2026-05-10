import { spawnSync } from "node:child_process"
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const rootDir = path.resolve(import.meta.dirname, "..")
const nextDir = path.join(rootDir, ".next")
const standaloneDir = path.join(nextDir, "standalone")
const staticDir = path.join(nextDir, "static")
const publicDir = path.join(rootDir, "public")
const desktopBuildDir = path.join(rootDir, "desktop-build")
const desktopNextDir = path.join(desktopBuildDir, "next")
const standaloneServerPath = path.join(standaloneDir, "server.js")

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function stripMacExtendedAttributes(directoryPath) {
  if (process.platform !== "darwin") {
    return
  }

  const result = spawnSync("xattr", ["-cr", directoryPath], {
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(
      `Failed to strip macOS extended attributes from ${directoryPath}: ${
        result.stderr || result.stdout || "xattr exited without output"
      }`
    )
  }
}

if (!(await exists(standaloneServerPath))) {
  throw new Error(
    "Missing .next/standalone/server.js. Run `pnpm build` before preparing the desktop bundle."
  )
}

await rm(desktopNextDir, { force: true, recursive: true })
await mkdir(desktopBuildDir, { recursive: true })
await cp(standaloneDir, desktopNextDir, {
  recursive: true,
  verbatimSymlinks: true,
})

if (await exists(staticDir)) {
  await mkdir(path.join(desktopNextDir, ".next"), { recursive: true })
  await cp(staticDir, path.join(desktopNextDir, ".next", "static"), {
    recursive: true,
  })
}

if (await exists(publicDir)) {
  await cp(publicDir, path.join(desktopNextDir, "public"), { recursive: true })
}

stripMacExtendedAttributes(desktopNextDir)

await writeFile(
  path.join(desktopBuildDir, "manifest.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      nextServer: "next/server.js",
    },
    null,
    2
  )}\n`
)

console.log(`Prepared desktop Next.js bundle at ${desktopNextDir}`)
