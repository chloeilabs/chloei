import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const rootDir = path.resolve(import.meta.dirname, "..")
const resourcesDir = path.join(rootDir, "electron", "build-resources")
const svgPath = path.join(resourcesDir, "icon.svg")
const pngPath = path.join(resourcesDir, "icon.png")
const icnsPath = path.join(resourcesDir, "icon.icns")
const icoPath = path.join(resourcesDir, "icon.ico")

const iconsetSizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
]

const icoSizes = [16, 32, 48, 64, 128, 256]
const logoPixels = [
  [0, 5],
  [1, 1],
  [1, 5],
  [1, 9],
  [2, 2],
  [2, 5],
  [2, 8],
  [3, 3],
  [3, 5],
  [3, 7],
  [5, 0],
  [5, 1],
  [5, 2],
  [5, 3],
  [5, 7],
  [5, 8],
  [5, 9],
  [5, 10],
  [7, 3],
  [7, 5],
  [7, 7],
  [8, 2],
  [8, 5],
  [8, 8],
  [9, 1],
  [9, 5],
  [9, 9],
  [10, 5],
]

function run(command, args) {
  const commandDisplay = [command, ...args].join(" ")
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  })

  if (result.error || result.status !== 0) {
    const details =
      result.error?.code === "ETIMEDOUT"
        ? `${commandDisplay} timed out after 60000ms`
        : result.error?.message ||
          result.stderr ||
          result.stdout ||
          (result.signal
            ? `terminated with signal ${result.signal}`
            : "no output")

    throw new Error(`${commandDisplay} failed:\n${details}`)
  }
}

function createIconSvg() {
  const cellSize = 64
  const offset = (1024 - 11 * cellSize) / 2
  const pixels = logoPixels
    .map(
      ([x, y]) =>
        `    <rect x="${String(offset + x * cellSize)}" y="${String(
          offset + y * cellSize
        )}" width="${String(cellSize)}" height="${String(cellSize)}"/>`
    )
    .join("\n")

  return `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1024" height="1024" rx="224" fill="#0c0a09"/>
  <g fill="#ffffff">
${pixels}
  </g>
</svg>
`
}

async function renderPng(sourceSvgPath, outputPath, size) {
  run("magick", [
    "-background",
    "none",
    sourceSvgPath,
    "-resize",
    `${String(size)}x${String(size)}`,
    "-strip",
    "PNG32:" + outputPath,
  ])
}

await mkdir(resourcesDir, { recursive: true })
await writeFile(svgPath, createIconSvg())
await renderPng(svgPath, pngPath, 1024)

const tmpDir = await mkdtemp(path.join(tmpdir(), "chloei-desktop-icons-"))
const iconsetDir = path.join(tmpDir, "icon.iconset")

try {
  await mkdir(iconsetDir)

  for (const [filename, size] of iconsetSizes) {
    await renderPng(svgPath, path.join(iconsetDir, filename), size)
  }

  if (process.platform !== "darwin") {
    throw new Error(
      "ICNS generation requires macOS (iconutil). Run this script on macOS."
    )
  }

  await rm(icnsPath, { force: true })
  run("iconutil", ["-c", "icns", iconsetDir, "-o", icnsPath])

  const icoInputs = []
  for (const size of icoSizes) {
    const outputPath = path.join(tmpDir, `icon-${String(size)}.png`)
    await renderPng(svgPath, outputPath, size)
    icoInputs.push(outputPath)
  }

  await rm(icoPath, { force: true })
  run("magick", [...icoInputs, icoPath])
} finally {
  await rm(tmpDir, { force: true, recursive: true })
}

console.log(`Generated desktop icons in ${resourcesDir}`)
