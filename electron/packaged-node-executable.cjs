"use strict"

const fs = require("node:fs")
const path = require("node:path")

function getPackagedNodeExecutable({
  appName,
  execPath = process.execPath,
  existsSync = fs.existsSync,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (platform !== "darwin" || !appName || !resourcesPath) {
    return execPath
  }

  const helperName = `${appName} Helper`
  const helperPath = path.resolve(
    resourcesPath,
    "..",
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName
  )

  return existsSync(helperPath) ? helperPath : execPath
}

module.exports = {
  getPackagedNodeExecutable,
}
