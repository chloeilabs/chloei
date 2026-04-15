"use client"

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import {
  LEGACY_THREADS_STORAGE_KEYS,
  LEGACY_THREADS_STORAGE_MIGRATION_KEYS,
  normalizeThread,
  sortThreadsNewestFirst,
  type Thread,
  THREADS_STORAGE_KEY,
  THREADS_STORAGE_MIGRATION_KEY,
} from "@/lib/shared"

const THREAD_SYNC_DEBOUNCE_MS = 800
const THREAD_SYNC_RETRY_MS = 3_000
const THREAD_SYNC_ERROR_TOAST_ID = "thread-sync-error"
const THREAD_DELETE_ERROR_TOAST_ID = "thread-delete-error"
const EMPTY_ASYNC_FLUSH = () => Promise.resolve()

interface SaveThreadOptions {
  immediate?: boolean
}

interface ThreadsContextValue {
  threads: Thread[]
  currentThreadId: string | null
  setCurrentThreadId: (id: string | null) => void
  saveThread: (thread: Thread, options?: SaveThreadOptions) => void
  renameThread: (id: string, title: string) => void
  toggleThreadPinned: (id: string) => void
  deleteThread: (id: string) => void
}

const ThreadsContext = createContext<ThreadsContextValue | undefined>(undefined)

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function mergeThreads(existingThreads: Thread[], incomingThreads: Thread[]) {
  const merged = new Map<string, Thread>()

  const upsertThread = (thread: Thread) => {
    const normalizedThread = normalizeThread(thread)
    const existingThread = merged.get(normalizedThread.id)

    if (!existingThread) {
      merged.set(normalizedThread.id, normalizedThread)
      return
    }

    const existingUpdatedAt = Date.parse(existingThread.updatedAt)
    const incomingUpdatedAt = Date.parse(normalizedThread.updatedAt)

    if (
      Number.isFinite(incomingUpdatedAt) &&
      (!Number.isFinite(existingUpdatedAt) ||
        incomingUpdatedAt >= existingUpdatedAt)
    ) {
      merged.set(normalizedThread.id, normalizedThread)
    }
  }

  existingThreads.forEach(upsertThread)
  incomingThreads.forEach(upsertThread)

  return sortThreadsNewestFirst(Array.from(merged.values()))
}

function parseLegacyThreads(value: string | null): Thread[] {
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value) as unknown

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .filter((candidate): candidate is Thread => {
        if (typeof candidate !== "object" || candidate === null) {
          return false
        }

        const thread = candidate as Partial<Thread>

        return (
          typeof thread.id === "string" &&
          typeof thread.title === "string" &&
          Array.isArray(thread.messages) &&
          typeof thread.createdAt === "string" &&
          typeof thread.updatedAt === "string"
        )
      })
      .map(normalizeThread)
  } catch {
    return []
  }
}

function getErrorMessage(response: Response, fallbackMessage: string) {
  return response
    .json()
    .then((payload: unknown) => {
      if (
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "string"
      ) {
        return payload.error
      }

      return fallbackMessage
    })
    .catch(() => fallbackMessage)
}

export function ThreadsProvider({
  children,
  initialThreads = [],
}: {
  children: ReactNode
  initialThreads?: Thread[]
}) {
  const [threads, setThreads] = useState<Thread[]>(() =>
    sortThreadsNewestFirst(initialThreads.map(normalizeThread))
  )
  const [currentThreadId, setCurrentThreadIdState] = useState<string | null>(
    null
  )
  const pendingSyncsRef = useRef(new Map<string, Thread>())
  const pendingImmediatePersistIdsRef = useRef(new Set<string>())
  const flushTimeoutRef = useRef<number | null>(null)
  const flushQueuedThreadsRef = useRef<() => Promise<void>>(EMPTY_ASYNC_FLUSH)
  const inFlightControllersRef = useRef(new Map<string, AbortController>())

  const clearScheduledFlush = useCallback(() => {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current)
      flushTimeoutRef.current = null
    }
  }, [])

  const setCurrentThreadId = useCallback((id: string | null) => {
    setCurrentThreadIdState(id)
  }, [])

  const persistThread = useCallback(async (thread: Thread) => {
    const controller = new AbortController()
    inFlightControllersRef.current.set(thread.id, controller)

    try {
      const response = await fetch("/api/threads", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(thread),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            "Failed to save conversation history."
          )
        )
      }

      const payload: unknown = await response.json()

      if (typeof payload !== "object" || payload === null) {
        throw new Error("Invalid thread response.")
      }

      return normalizeThread(payload as Thread)
    } finally {
      const activeController = inFlightControllersRef.current.get(thread.id)

      if (activeController === controller) {
        inFlightControllersRef.current.delete(thread.id)
      }
    }
  }, [])

  const scheduleFlush = useCallback(
    (delayMs = THREAD_SYNC_DEBOUNCE_MS) => {
      clearScheduledFlush()

      flushTimeoutRef.current = window.setTimeout(() => {
        void flushQueuedThreadsRef.current()
      }, delayMs)
    },
    [clearScheduledFlush]
  )

  const handlePersistFailure = useCallback(
    (thread: Thread, error: unknown) => {
      if (isAbortError(error)) {
        return
      }

      console.error("Failed to sync thread:", error)
      pendingSyncsRef.current.set(thread.id, thread)
      toast.error(
        "Failed to sync conversation history. Recent changes may not appear on other devices yet.",
        {
          id: THREAD_SYNC_ERROR_TOAST_ID,
        }
      )
      scheduleFlush(THREAD_SYNC_RETRY_MS)
    },
    [scheduleFlush]
  )

  const persistThreadImmediately = useCallback(
    async (thread: Thread) => {
      try {
        const persistedThread = await persistThread(thread)

        setThreads((prev) => mergeThreads(prev, [persistedThread]))
        toast.dismiss(THREAD_SYNC_ERROR_TOAST_ID)
      } catch (error) {
        handlePersistFailure(thread, error)
      }
    },
    [handlePersistFailure, persistThread]
  )

  const updateThread = useCallback(
    (id: string, updater: (thread: Thread) => Thread) => {
      pendingImmediatePersistIdsRef.current.add(id)

      setThreads((prev) => {
        const existingThread = prev.find((thread) => thread.id === id)

        if (!existingThread) {
          pendingImmediatePersistIdsRef.current.delete(id)
          return prev
        }

        const nextThread = normalizeThread({
          ...updater(existingThread),
          updatedAt: new Date().toISOString(),
        })

        return mergeThreads(prev, [nextThread])
      })
    },
    []
  )

  const flushQueuedThreads = useCallback(async () => {
    clearScheduledFlush()

    const queuedThreads = Array.from(pendingSyncsRef.current.values())

    if (queuedThreads.length === 0) {
      return
    }

    pendingSyncsRef.current = new Map()

    const results = await Promise.allSettled(
      queuedThreads.map((thread) => persistThread(thread))
    )

    const failedThreads: Thread[] = []

    results.forEach((result, index) => {
      const thread = queuedThreads[index]

      if (!thread) {
        return
      }

      if (result.status === "fulfilled") {
        setThreads((prev) => mergeThreads(prev, [result.value]))
        return
      }

      if (!isAbortError(result.reason)) {
        console.error("Failed to sync thread:", result.reason)
        pendingSyncsRef.current.set(thread.id, thread)
        failedThreads.push(thread)
      }
    })

    if (failedThreads.length > 0) {
      toast.error(
        "Failed to sync conversation history. Recent changes may not appear on other devices yet.",
        {
          id: THREAD_SYNC_ERROR_TOAST_ID,
        }
      )
      scheduleFlush(THREAD_SYNC_RETRY_MS)
      return
    }

    toast.dismiss(THREAD_SYNC_ERROR_TOAST_ID)
  }, [clearScheduledFlush, persistThread, scheduleFlush])

  useEffect(() => {
    flushQueuedThreadsRef.current = flushQueuedThreads
  }, [flushQueuedThreads])

  useEffect(() => {
    const pendingImmediatePersistIds = pendingImmediatePersistIdsRef.current

    if (pendingImmediatePersistIds.size === 0) {
      return
    }

    const threadsToPersist = threads.filter((thread) =>
      pendingImmediatePersistIds.has(thread.id)
    )

    pendingImmediatePersistIds.clear()

    threadsToPersist.forEach((thread) => {
      pendingSyncsRef.current.delete(thread.id)
      void persistThreadImmediately(thread)
    })
  }, [threads, persistThreadImmediately])

  const saveThread = useCallback(
    (thread: Thread, options?: SaveThreadOptions) => {
      const normalizedThread = normalizeThread(thread)

      setThreads((prev) => mergeThreads(prev, [normalizedThread]))

      if (options?.immediate) {
        pendingSyncsRef.current.delete(normalizedThread.id)
        void persistThreadImmediately(normalizedThread)
        return
      }

      pendingSyncsRef.current.set(normalizedThread.id, normalizedThread)
      scheduleFlush()
    },
    [persistThreadImmediately, scheduleFlush]
  )

  const renameThread = useCallback(
    (id: string, title: string) => {
      updateThread(id, (thread) => ({
        ...thread,
        title,
      }))
    },
    [updateThread]
  )

  const toggleThreadPinned = useCallback(
    (id: string) => {
      updateThread(id, (thread) => ({
        ...thread,
        isPinned: !(thread.isPinned ?? false),
      }))
    },
    [updateThread]
  )

  const deleteThread = useCallback(
    (id: string) => {
      const deletedThread = threads.find((thread) => thread.id === id)
      const remainingThreads = threads.filter((thread) => thread.id !== id)

      pendingSyncsRef.current.delete(id)
      inFlightControllersRef.current.get(id)?.abort()
      inFlightControllersRef.current.delete(id)

      if (pendingSyncsRef.current.size === 0) {
        clearScheduledFlush()
      }

      setThreads(remainingThreads)

      if (currentThreadId === id) {
        setCurrentThreadIdState(null)
      }

      void (async () => {
        try {
          const response = await fetch("/api/threads", {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ id }),
          })

          if (!response.ok) {
            throw new Error(
              await getErrorMessage(
                response,
                "Failed to delete conversation history."
              )
            )
          }

          toast.dismiss(THREAD_DELETE_ERROR_TOAST_ID)
        } catch (error) {
          if (isAbortError(error)) {
            return
          }

          console.error("Failed to delete thread:", error)

          if (deletedThread) {
            setThreads((prev) => mergeThreads(prev, [deletedThread]))
          }

          toast.error("Failed to delete conversation history.", {
            id: THREAD_DELETE_ERROR_TOAST_ID,
          })
        }
      })()
    },
    [clearScheduledFlush, currentThreadId, threads]
  )

  useEffect(() => {
    const legacyThreadStorageValue =
      localStorage.getItem(THREADS_STORAGE_KEY) ??
      LEGACY_THREADS_STORAGE_KEYS.reduce<string | null>((value, key) => {
        return value ?? localStorage.getItem(key)
      }, null)

    if (
      legacyThreadStorageValue !== null &&
      localStorage.getItem(THREADS_STORAGE_KEY) === null
    ) {
      localStorage.setItem(THREADS_STORAGE_KEY, legacyThreadStorageValue)
    }

    const legacyMigrationValue =
      localStorage.getItem(THREADS_STORAGE_MIGRATION_KEY) ??
      LEGACY_THREADS_STORAGE_MIGRATION_KEYS.reduce<string | null>(
        (value, key) => {
          return value ?? localStorage.getItem(key)
        },
        null
      )

    if (
      legacyMigrationValue !== null &&
      localStorage.getItem(THREADS_STORAGE_MIGRATION_KEY) === null
    ) {
      localStorage.setItem(THREADS_STORAGE_MIGRATION_KEY, legacyMigrationValue)
    }

    const localThreads = parseLegacyThreads(
      localStorage.getItem(THREADS_STORAGE_KEY)
    )

    LEGACY_THREADS_STORAGE_KEYS.forEach((key) => {
      localStorage.removeItem(key)
    })
    localStorage.removeItem(THREADS_STORAGE_KEY)
    LEGACY_THREADS_STORAGE_MIGRATION_KEYS.forEach((key) => {
      localStorage.removeItem(key)
    })
    localStorage.setItem(THREADS_STORAGE_MIGRATION_KEY, "1")

    if (localThreads.length === 0) {
      return
    }

    let threadsToPersist: Thread[] = []

    setThreads((prev) => {
      const serverThreadsById = new Map(
        prev.map((thread) => [thread.id, thread])
      )

      threadsToPersist = localThreads.filter((thread) => {
        const serverThread = serverThreadsById.get(thread.id)

        if (!serverThread) {
          return true
        }

        const localUpdatedAt = Date.parse(thread.updatedAt)
        const serverUpdatedAt = Date.parse(serverThread.updatedAt)

        return (
          Number.isFinite(localUpdatedAt) &&
          (!Number.isFinite(serverUpdatedAt) ||
            localUpdatedAt > serverUpdatedAt)
        )
      })

      return mergeThreads(prev, localThreads)
    })

    if (threadsToPersist.length === 0) {
      return
    }

    threadsToPersist.forEach((thread) => {
      pendingSyncsRef.current.set(thread.id, normalizeThread(thread))
    })

    scheduleFlush(0)
  }, [scheduleFlush])

  useEffect(() => {
    const controllers = inFlightControllersRef.current

    return () => {
      clearScheduledFlush()

      for (const controller of controllers.values()) {
        controller.abort()
      }

      controllers.clear()
    }
  }, [clearScheduledFlush])

  return (
    <ThreadsContext.Provider
      value={{
        threads,
        currentThreadId,
        setCurrentThreadId,
        saveThread,
        renameThread,
        toggleThreadPinned,
        deleteThread,
      }}
    >
      {children}
    </ThreadsContext.Provider>
  )
}

export function useThreads() {
  const context = useContext(ThreadsContext)

  if (!context) {
    throw new Error("useThreads must be used within a ThreadsProvider")
  }

  return context
}
