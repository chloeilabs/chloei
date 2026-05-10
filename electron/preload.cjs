"use strict"

const { contextBridge } = require("electron")

const versionArgPrefix = "--chloei-desktop-version="
const versionArg = process.argv.find((arg) => arg.startsWith(versionArgPrefix))
const version = versionArg
  ? versionArg.slice(versionArgPrefix.length)
  : "unknown"

contextBridge.exposeInMainWorld(
  "chloeiDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    version,
  })
)
