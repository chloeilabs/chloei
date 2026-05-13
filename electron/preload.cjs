"use strict"

const { contextBridge, ipcRenderer } = require("electron")

const versionArgPrefix = "--chloei-desktop-version="
const versionArg = process.argv.find((arg) => arg.startsWith(versionArgPrefix))
const version = versionArg
  ? versionArg.slice(versionArgPrefix.length)
  : "unknown"
const updateStateChannel = "chloei:update:state"

function subscribeToUpdateState(listener) {
  if (typeof listener !== "function") {
    return () => {}
  }

  const handleStateChange = (_event, state) => {
    listener(state)
  }

  ipcRenderer.on(updateStateChannel, handleStateChange)

  return () => {
    ipcRenderer.removeListener(updateStateChannel, handleStateChange)
  }
}

contextBridge.exposeInMainWorld(
  "chloeiDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    updates: Object.freeze({
      check: () => ipcRenderer.invoke("chloei:update:check"),
      getState: () => ipcRenderer.invoke("chloei:update:get-state"),
      install: () => ipcRenderer.invoke("chloei:update:install"),
      onStateChange: subscribeToUpdateState,
    }),
    version,
  })
)
