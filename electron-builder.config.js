"use strict"

const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

const shouldSignMac =
  process.env.CHLOEI_DESKTOP_SIGN === "1" ||
  Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
const desktopUpdateChannel = process.env.CHLOEI_DESKTOP_UPDATE_CHANNEL?.trim()

function getAppBundlePath(context) {
  return path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
}

function getResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(getAppBundlePath(context), "Contents", "Resources")
  }

  return path.join(context.appOutDir, "resources")
}

function stripMacExtendedAttributes(appPath) {
  const result = spawnSync("xattr", ["-cr", appPath], {
    encoding: "utf8",
  })

  if (result.status !== 0) {
    throw new Error(
      `Failed to strip macOS extended attributes from ${appPath}: ${
        result.stderr || result.stdout || "xattr exited without output"
      }`
    )
  }
}

function copyDesktopNextBundle(context) {
  const sourceDir = path.join(
    context.packager.info.projectDir,
    "desktop-build",
    "next"
  )
  const destinationDir = path.join(getResourcesDir(context), "next")

  if (!fs.existsSync(path.join(sourceDir, "server.js"))) {
    throw new Error(
      `Missing prepared desktop Next.js bundle at ${sourceDir}. Run pnpm desktop:build first.`
    )
  }

  fs.rmSync(destinationDir, { force: true, recursive: true })
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    verbatimSymlinks: true,
  })

  if (context.electronPlatformName === "darwin") {
    stripMacExtendedAttributes(getAppBundlePath(context))
  }
}

/** @type {import("electron-builder").Configuration} */
module.exports = {
  afterPack: copyDesktopNextBundle,
  appId: "ai.chloei.desktop",
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  asar: true,
  buildVersion: process.env.BUILD_NUMBER || undefined,
  directories: {
    buildResources: "electron/build-resources",
    output: "dist/desktop",
  },
  disableDefaultIgnoredFiles: true,
  extraMetadata: {
    main: "electron/main.cjs",
  },
  files: ["electron/**/*", "package.json"],
  generateUpdatesFilesForAllChannels: true,
  mac: {
    category: "public.app-category.productivity",
    entitlements: "electron/build-resources/entitlements.mac.plist",
    entitlementsInherit: "electron/build-resources/entitlements.mac.plist",
    gatekeeperAssess: false,
    hardenedRuntime: true,
    icon: "electron/build-resources/icon.icns",
    identity: shouldSignMac ? undefined : null,
    target: ["dmg", "zip"],
  },
  npmRebuild: false,
  nsis: {
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    oneClick: false,
    perMachine: false,
  },
  productName: "Chloei",
  protocols: [
    {
      name: "Chloei",
      schemes: ["chloei"],
    },
  ],
  publish: [
    {
      ...(desktopUpdateChannel ? { channel: desktopUpdateChannel } : {}),
      owner: "chloeilabs",
      provider: "github",
      releaseType: "draft",
      repo: "chloei",
    },
  ],
  win: {
    cscKeyPassword: process.env.WIN_CERT_PASSWORD || undefined,
    cscLink: process.env.WIN_CERT_FILE || undefined,
    icon: "electron/build-resources/icon.ico",
    legalTrademarks: "Chloei",
    target: ["nsis"],
  },
}
