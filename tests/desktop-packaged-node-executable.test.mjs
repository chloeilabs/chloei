import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import test from "node:test"

const require = createRequire(import.meta.url)
const {
  getPackagedNodeExecutable,
} = require("../electron/packaged-node-executable.cjs")

test("packaged macOS server uses hidden Electron helper executable", () => {
  const resourcesPath = "/Applications/Chloei.app/Contents/Resources"
  const expectedHelperPath = path.resolve(
    resourcesPath,
    "..",
    "Frameworks",
    "Chloei Helper.app",
    "Contents",
    "MacOS",
    "Chloei Helper"
  )

  assert.equal(
    getPackagedNodeExecutable({
      appName: "Chloei",
      execPath: "/Applications/Chloei.app/Contents/MacOS/Chloei",
      existsSync: (filePath) => filePath === expectedHelperPath,
      platform: "darwin",
      resourcesPath,
    }),
    expectedHelperPath
  )
})

test("packaged macOS server falls back when helper executable is unavailable", () => {
  const execPath = "/Applications/Chloei.app/Contents/MacOS/Chloei"

  assert.equal(
    getPackagedNodeExecutable({
      appName: "Chloei",
      execPath,
      existsSync: () => false,
      platform: "darwin",
      resourcesPath: "/Applications/Chloei.app/Contents/Resources",
    }),
    execPath
  )
})

test("packaged server uses current executable outside macOS app bundles", () => {
  assert.equal(
    getPackagedNodeExecutable({
      appName: "Chloei",
      execPath: "/opt/chloei/chloei",
      existsSync: () => true,
      platform: "linux",
      resourcesPath: "/opt/chloei/resources",
    }),
    "/opt/chloei/chloei"
  )
})
