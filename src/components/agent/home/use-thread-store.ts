import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { isAbortError } from "@/lib/cast"
import {
  createHttpErrorFromResponse,
  formatHttpErrorDescription,
} from "@/lib/http-error"
import { createLogger } from "@/lib/logger"
import { createRequestHeaders } from "@/lib/request-id"
import { sortThreadsNewestFirst, type Thread } from "@/lib/shared"

const THREAD_SYNC_DEBOUNCE_MS = 800
const THREAD_SYNC_RETRY_MS = 3_000
const THREAD_SYNC_ERROR_TOAST_ID = "thread-sync-error"
const THREAD_DELETE_ERROR_TOAST_ID = "thread-delete-error"
const EMPTY_THREAD_FLUSH = () => Promise.resolve()
const logger = createLogger("threads-client")

interface SaveThreadOptions {
  immediate?: boolean
}

function mergeThreads(existingThreads: Thread[], incomingThreads: Thread[]) {
  const merged = new Map<string, Thread>()

  const upsertThread = (thread: Thread) => {
    const existingThread = merged.get(thread.id)

    if (!existingThread) {
      merged.set(thread.id, thread)
      return
    }

    const existingUpdatedAt = Date.parse(existingThread.updatedAt)
    const incomingUpdatedAt = Date.parse(thread.updatedAt)

    if (
      Number.isFinite(incomingUpdatedAt) &&
      (!Number.isFinite(existingUpdatedAt) ||
        incomingUpdatedAt >= existingUpdatedAt)
    ) {
      merged.set(thread.id, thread)
    }
  }

  existingThreads.forEach(upsertThread)
  incomingThreads.forEach(upsertThread)

  return sortThreadsNewestFirst(Array.from(merged.values()))
}

export function useThreadStore(initialThreads: Thread[] = []) {
  const [threads, setThreads] = useState<Thread[]>(() =>
    sortThreadsNewestFirst(initialThreads)
  )
  const [currentThreadId, setCurrentThreadIdState] = useState<string | null>(
    null
  )
  const pendingSyncsRef = useRef(new Map<string, Thread>())
  const flushTimeoutRef = useRef<number | null>(null)
  const flushQueuedThreadsRef = useRef<() => Promise<void>>(EMPTY_THREAD_FLUSH)
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
        headers: createRequestHeaders({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(thread),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw await createHttpErrorFromResponse(
          response,
          "Failed to save conversation history."
        )
      }

      const payload: unknown = await response.json()

      if (typeof payload !== "object" || payload === null) {
        throw new Error("Invalid thread response.")
      }

      return payload as Thread
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

      logger.error("Failed to sync thread.", {
        error,
        threadId: thread.id,
      })
      pendingSyncsRef.current.set(thread.id, thread)
      toast.error(
        "Failed to sync conversation history. Recent changes may not appear on other devices yet.",
        {
          description: formatHttpErrorDescription(
            error,
            "Failed to save conversation history."
          ),
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
        const syncError: unknown = result.reason

        logger.error("Failed to sync thread.", {
          error: syncError,
          threadId: thread.id,
        })
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

  const saveThread = useCallback(
    (thread: Thread, options?: SaveThreadOptions) => {
      setThreads((prev) => mergeThreads(prev, [thread]))

      if (options?.immediate) {
        pendingSyncsRef.current.delete(thread.id)
        void persistThreadImmediately(thread)
        return
      }

      pendingSyncsRef.current.set(thread.id, thread)
      scheduleFlush()
    },
    [persistThreadImmediately, scheduleFlush]
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
            headers: createRequestHeaders({
              "Content-Type": "application/json",
            }),
            body: JSON.stringify({ id }),
          })

          if (!response.ok) {
            throw await createHttpErrorFromResponse(
              response,
              "Failed to delete conversation history."
            )
          }

          toast.dismiss(THREAD_DELETE_ERROR_TOAST_ID)
        } catch (error) {
          if (isAbortError(error)) {
            return
          }

          logger.error("Failed to delete thread.", {
            error,
            threadId: id,
          })

          if (deletedThread) {
            setThreads((prev) => mergeThreads(prev, [deletedThread]))
          }

          toast.error("Failed to delete conversation history.", {
            description: formatHttpErrorDescription(
              error,
              "Failed to delete conversation history."
            ),
            id: THREAD_DELETE_ERROR_TOAST_ID,
          })
        }
      })()
    },
    [clearScheduledFlush, currentThreadId, threads]
  )

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

  return {
    threads,
    currentThreadId,
    setCurrentThreadId,
    saveThread,
    deleteThread,
  }
}
