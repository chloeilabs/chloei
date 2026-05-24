"use client"

import { useCallback, useSyncExternalStore } from "react"

import { RUN_MODE_STORAGE_KEY, RUN_MODE_UPDATED_EVENT } from "@/lib/constants"
import type { AgentRunMode } from "@/lib/shared"

import {
  parseStoredRunMode,
  resolvePersistedRunMode,
  serializeStoredRunMode,
} from "./persistent-run-mode-utils"

type RunModeUpdater =
  | AgentRunMode
  | ((currentRunMode: AgentRunMode) => AgentRunMode)

let memoryRunMode: AgentRunMode | null = null

function readStoredRunMode(fallbackRunMode: AgentRunMode): AgentRunMode {
  if (typeof window === "undefined") {
    return fallbackRunMode
  }

  let storedValue: string | null = null
  try {
    storedValue = window.localStorage.getItem(RUN_MODE_STORAGE_KEY)
  } catch {
    return resolvePersistedRunMode({
      storedRunMode: memoryRunMode,
      fallbackRunMode,
    })
  }

  return resolvePersistedRunMode({
    storedRunMode: parseStoredRunMode(storedValue) ?? memoryRunMode,
    fallbackRunMode,
  })
}

function writeStoredRunMode(runMode: AgentRunMode) {
  if (typeof window === "undefined") {
    return
  }

  memoryRunMode = runMode

  try {
    window.localStorage.setItem(
      RUN_MODE_STORAGE_KEY,
      JSON.stringify(serializeStoredRunMode(runMode))
    )
  } catch {
    // Keep the in-memory mode so restricted storage environments still update.
  }

  try {
    window.dispatchEvent(new CustomEvent(RUN_MODE_UPDATED_EVENT))
  } catch {
    // Storage events are best-effort; callers still have the in-memory value.
  }
}

function subscribeToRunMode(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key && event.key !== RUN_MODE_STORAGE_KEY) {
      return
    }

    onStoreChange()
  }

  window.addEventListener("storage", handleStorage)
  window.addEventListener(RUN_MODE_UPDATED_EVENT, onStoreChange)

  return () => {
    window.removeEventListener("storage", handleStorage)
    window.removeEventListener(RUN_MODE_UPDATED_EVENT, onStoreChange)
  }
}

export function usePersistentRunMode(initialRunMode: AgentRunMode = "chat") {
  const getSnapshot = useCallback(
    () => readStoredRunMode(initialRunMode),
    [initialRunMode]
  )
  const getServerSnapshot = useCallback(() => initialRunMode, [initialRunMode])
  const runMode = useSyncExternalStore(
    subscribeToRunMode,
    getSnapshot,
    getServerSnapshot
  )

  const setRunMode = useCallback(
    (nextRunMode: RunModeUpdater) => {
      const currentRunMode = readStoredRunMode(initialRunMode)
      const resolvedRunMode =
        typeof nextRunMode === "function"
          ? nextRunMode(currentRunMode)
          : nextRunMode

      writeStoredRunMode(resolvedRunMode)
    },
    [initialRunMode]
  )

  return {
    runMode,
    setRunMode,
  }
}
