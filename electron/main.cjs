"use strict"

const { spawn } = require("node:child_process")
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const path = require("node:path")
const { setTimeout: delay } = require("node:timers/promises")

const { app, BrowserWindow, dialog, shell, session } = require("electron")

const APP_NAME = "Chloei"
const SERVER_HOST = "127.0.0.1"
const SERVER_START_TIMEOUT_MS = 120_000
const SERVER_POLL_INTERVAL_MS = 250

let mainWindow = null
let serverProcess = null
let serverOrigin = null
let serverStartupError = null
let isQuitting = false

app.setName(APP_NAME)
app.setAppUserModelId("ai.chloei.desktop")

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
  process.exit(0)
}

function getAppRoot() {
  return path.resolve(__dirname, "..")
}

function getDesktopNextDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "next")
  }

  return path.resolve(
    process.env.CHLOEI_DESKTOP_STANDALONE_DIR ||
      path.join(getAppRoot(), ".next", "standalone")
  )
}

function getLogFilePath() {
  return path.join(app.getPath("userData"), "logs", "main.log")
}

function log(message, error) {
  const details =
    error instanceof Error
      ? `${message}\n${error.stack || error.message}`
      : error
        ? `${message}\n${String(error)}`
        : message
  const line = `[${new Date().toISOString()}] ${details}\n`

  if (!app.isPackaged) {
    console.warn(line.trimEnd())
  }

  try {
    const logFilePath = getLogFilePath()
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    fs.appendFileSync(logFilePath, line)
  } catch {
    // Logging must never prevent app startup or shutdown.
  }
}

function parseDesktopEnvFile() {
  const envFilePath = path.join(app.getPath("userData"), "desktop.env")

  if (!fs.existsSync(envFilePath)) {
    return {}
  }

  const values = {}
  const rawFile = fs.readFileSync(envFilePath, "utf8")

  for (const rawLine of rawFile.split(/\r?\n/u)) {
    const line = rawLine.trim()

    if (!line || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")

    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const rawValue = line.slice(separatorIndex + 1).trim()
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue

    if (/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
      values[key] = value
    }
  }

  return values
}

function mergeTrustedOrigins(existingValue, origin) {
  const origins = new Set([origin])

  for (const rawOrigin of String(existingValue || "").split(",")) {
    const trimmedOrigin = rawOrigin.trim()

    if (trimmedOrigin) {
      origins.add(trimmedOrigin)
    }
  }

  return [...origins].join(",")
}

function createServerEnv(origin, port, mode) {
  const desktopEnv = parseDesktopEnvFile()
  const mergedEnv = {
    ...process.env,
    ...desktopEnv,
  }

  return {
    ...mergedEnv,
    BETTER_AUTH_COOKIE_DOMAIN: "",
    BETTER_AUTH_TRUSTED_ORIGINS: mergeTrustedOrigins(
      mergedEnv.BETTER_AUTH_TRUSTED_ORIGINS,
      origin
    ),
    BETTER_AUTH_URL: origin,
    CHLOEI_DESKTOP: "1",
    HOSTNAME: SERVER_HOST,
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_ENV: mode,
    PORT: String(port),
  }
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()

    server.once("error", reject)
    server.listen(0, SERVER_HOST, () => {
      const address = server.address()

      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port)
          return
        }

        reject(new Error("Unable to resolve an available local port."))
      })
    })
  })
}

function waitForHttpServer(origin) {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    async function poll() {
      if (serverProcess && serverProcess.exitCode !== null) {
        reject(
          new Error(
            `Next.js server exited with code ${serverProcess.exitCode}.`
          )
        )
        return
      }

      if (serverStartupError) {
        reject(serverStartupError)
        return
      }

      try {
        await requestServer(origin)
        resolve()
        return
      } catch {
        if (Date.now() - startedAt >= SERVER_START_TIMEOUT_MS) {
          reject(new Error(`Timed out waiting for ${origin}.`))
          return
        }

        await delay(SERVER_POLL_INTERVAL_MS)
        poll()
      }
    }

    poll()
  })
}

function requestServer(origin) {
  return new Promise((resolve, reject) => {
    const url = new URL("/", origin)
    const client = url.protocol === "https:" ? https : http
    const request = client.request(
      {
        hostname: url.hostname,
        method: "GET",
        path: url.pathname,
        port: url.port,
        timeout: 2_000,
      },
      (response) => {
        response.resume()
        resolve()
      }
    )

    request.once("error", reject)
    request.once("timeout", () => {
      request.destroy(new Error("Timed out connecting to local server."))
    })
    request.end()
  })
}

function pipeServerLogs(childProcess) {
  childProcess.stdout?.on("data", (chunk) => {
    log(`[next] ${chunk.toString().trimEnd()}`)
  })
  childProcess.stderr?.on("data", (chunk) => {
    log(`[next] ${chunk.toString().trimEnd()}`)
  })
}

async function startNextServer() {
  const configuredServerUrl = process.env.CHLOEI_DESKTOP_SERVER_URL?.trim()

  if (configuredServerUrl) {
    const origin = new URL(configuredServerUrl).origin
    await waitForHttpServer(origin)
    return origin
  }

  const port = await getAvailablePort()
  const origin = `http://${SERVER_HOST}:${port}`
  const env = createServerEnv(
    origin,
    port,
    app.isPackaged ? "production" : "development"
  )
  serverStartupError = null

  if (app.isPackaged) {
    const standaloneDir = getDesktopNextDir()
    const serverPath = path.join(standaloneDir, "server.js")

    if (!fs.existsSync(serverPath)) {
      throw new Error(`Missing packaged Next.js server at ${serverPath}.`)
    }

    serverProcess = spawn(process.execPath, [serverPath], {
      cwd: standaloneDir,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
  } else {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

    serverProcess = spawn(
      pnpmCommand,
      [
        "exec",
        "next",
        "dev",
        "--hostname",
        SERVER_HOST,
        "--port",
        String(port),
      ],
      {
        cwd: getAppRoot(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    )
  }

  serverProcess.once("exit", (code, signal) => {
    log(
      `Next.js server exited with code ${code ?? "null"} and signal ${signal ?? "null"}.`
    )

    if (!isQuitting) {
      dialog.showErrorBox(
        "Chloei server stopped",
        "The local Chloei server stopped unexpectedly. Restart the app to try again."
      )
      app.quit()
    }
  })
  serverProcess.once("error", (error) => {
    serverStartupError = error
    log("Failed to start Next.js server process.", error)
  })

  pipeServerLogs(serverProcess)
  await waitForHttpServer(origin)
  return origin
}

function isAllowedAppUrl(rawUrl) {
  if (!serverOrigin) {
    return false
  }

  try {
    return new URL(rawUrl).origin === serverOrigin
  } catch {
    return false
  }
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)

    if (["https:", "http:", "mailto:"].includes(url.protocol)) {
      void shell.openExternal(url.toString())
    }
  } catch (error) {
    log(`Blocked malformed external URL: ${rawUrl}`, error)
  }
}

function getWindowIconPath() {
  const pngIconPath = path.join(
    getAppRoot(),
    "electron",
    "build-resources",
    "icon.png"
  )
  const icoIconPath = path.join(
    getAppRoot(),
    "electron",
    "build-resources",
    "icon.ico"
  )

  if (process.platform === "win32" && fs.existsSync(icoIconPath)) {
    return icoIconPath
  }

  if (fs.existsSync(pngIconPath)) {
    return pngIconPath
  }

  return undefined
}

function createMainWindow(origin) {
  serverOrigin = origin

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false)
    }
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  const windowIconPath = getWindowIconPath()

  mainWindow = new BrowserWindow({
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    backgroundColor: "#050505",
    height: 900,
    minHeight: 700,
    minWidth: 1024,
    show: false,
    title: APP_NAME,
    webPreferences: {
      additionalArguments: [`--chloei-desktop-version=${app.getVersion()}`],
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      webSecurity: true,
    },
    width: 1280,
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedAppUrl(url)) {
      openExternalUrl(url)
    }

    return { action: "deny" }
  })

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppUrl(url)) {
      return
    }

    event.preventDefault()
    openExternalUrl(url)
  })

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      log(`Failed to load ${validatedURL}: ${errorCode} ${errorDescription}`)
    }
  )

  mainWindow.on("closed", () => {
    mainWindow = null
  })

  void mainWindow.loadURL(origin)
}

function focusMainWindow() {
  if (!mainWindow) {
    return
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }

  mainWindow.focus()
}

function stopNextServer() {
  if (!serverProcess || serverProcess.killed) {
    return
  }

  const childProcess = serverProcess
  serverProcess = null

  if (process.platform === "win32" && childProcess.pid) {
    spawn("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return
  }

  childProcess.kill("SIGTERM")

  setTimeout(() => {
    if (childProcess.exitCode === null) {
      childProcess.kill("SIGKILL")
    }
  }, 5_000).unref()
}

function getAutoUpdateChannel() {
  if (process.env.CHLOEI_DESKTOP_UPDATE_CHANNEL?.trim()) {
    return process.env.CHLOEI_DESKTOP_UPDATE_CHANNEL.trim()
  }

  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "latest-mac-arm64" : "latest-mac-x64"
  }

  if (process.platform === "win32") {
    return "latest-win-x64"
  }

  return "latest"
}

function configureAutoUpdates() {
  if (!app.isPackaged || process.env.CHLOEI_DESKTOP_AUTO_UPDATE === "0") {
    return
  }

  try {
    const { autoUpdater } = require("electron-updater")

    autoUpdater.channel = getAutoUpdateChannel()
    autoUpdater.on("error", (error) => {
      log("Auto-update check failed.", error)
    })
    autoUpdater.on("update-downloaded", () => {
      log("Desktop update downloaded and ready to install.")
    })

    setTimeout(() => {
      void autoUpdater.checkForUpdatesAndNotify()
    }, 10_000).unref()
  } catch (error) {
    log("Unable to initialize auto-updates.", error)
  }
}

app.on("second-instance", () => {
  focusMainWindow()
})

app.on("before-quit", () => {
  isQuitting = true
  stopNextServer()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("activate", () => {
  if (mainWindow) {
    focusMainWindow()
  } else if (serverOrigin) {
    createMainWindow(serverOrigin)
  }
})

process.on("uncaughtException", (error) => {
  log("Uncaught exception in Electron main process.", error)
  app.quit()
})

process.on("unhandledRejection", (error) => {
  log("Unhandled rejection in Electron main process.", error)
})

app.whenReady().then(async () => {
  try {
    const origin = await startNextServer()
    createMainWindow(origin)
    configureAutoUpdates()
  } catch (error) {
    log("Failed to start Chloei desktop.", error)
    dialog.showErrorBox(
      "Unable to start Chloei",
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  }
})
