import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { redirectToSignIn } from "@/lib/auth-client"
import { isAbortError } from "@/lib/cast"
import {
  createHttpError,
  createHttpErrorFromResponse,
  formatHttpErrorDescription,
  getHttpErrorMessage,
} from "@/lib/http-error"
import { createLogger } from "@/lib/logger"
import { createRequestHeaders, getRequestIdFromHeaders } from "@/lib/request-id"
import {
  type AgentRequestAttachment,
  type AgentRunMode,
  AvailableModels,
  type Message as AgentMessage,
  type ModelType,
  sortThreadsNewestFirst,
  type Thread,
} from "@/lib/shared"

import {
  getResponseErrorMessage,
  parseStreamEventLine,
  readResponseStreamLines,
} from "./agent-stream-events"
import {
  type AgentStreamAccumulator,
  appendRawStreamText,
  applyAgentStreamEvent,
  createAgentStreamAccumulator,
  finalizeAgentStreamAccumulator,
  hasAgentStreamOutput,
} from "./agent-stream-state"
import {
  appendUserMessage,
  CLIENT_MESSAGE_MAX_CHARS,
  createClientMessageId,
  EMPTY_ASSISTANT_RESPONSE_FALLBACK,
  toRequestMessages,
} from "./home-agent-utils"

const THREAD_SYNC_DEBOUNCE_MS = 800
const THREAD_SYNC_RETRY_MS = 3_000
const THREAD_SYNC_ERROR_TOAST_ID = "thread-sync-error"
const THREAD_DELETE_ERROR_TOAST_ID = "thread-delete-error"
const EMPTY_THREAD_FLUSH = () => Promise.resolve()
const logger = createLogger("threads-client")

interface AgentSessionState {
  messages: AgentMessage[]
  isSubmitting: boolean
  isStreaming: boolean
}

interface EditMessageParams {
  messageId: string
  newContent: string
  newModel: ModelType
  newRunMode: AgentRunMode
}

interface QueuedSubmission {
  message: string
  model: ModelType
  runMode: AgentRunMode
  attachments: AgentRequestAttachment[]
}

interface SaveThreadOptions {
  immediate?: boolean
}

const INITIAL_STATE: AgentSessionState = {
  messages: [],
  isSubmitting: false,
  isStreaming: false,
}

type AttachmentPayloadsByThread = Map<
  string,
  Map<string, AgentRequestAttachment[]>
>

function getThreadAttachmentPayloads(
  payloadsByThread: AttachmentPayloadsByThread,
  threadId: string
) {
  let payloads = payloadsByThread.get(threadId)

  if (!payloads) {
    payloads = new Map<string, AgentRequestAttachment[]>()
    payloadsByThread.set(threadId, payloads)
  }

  return payloads
}

function pruneThreadAttachmentPayloads(
  payloadsByThread: AttachmentPayloadsByThread,
  threadId: string,
  messages: readonly AgentMessage[]
) {
  const payloads = payloadsByThread.get(threadId)
  if (!payloads) {
    return
  }

  const messageIds = new Set(
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.id)
  )

  for (const messageId of payloads.keys()) {
    if (!messageIds.has(messageId)) {
      payloads.delete(messageId)
    }
  }

  if (payloads.size === 0) {
    payloadsByThread.delete(threadId)
  }
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

function getClientTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone.trim()
    return timeZone || undefined
  } catch {
    return undefined
  }
}

function createAgentRequestHeaders(): HeadersInit {
  const timeZone = getClientTimeZone()

  return createRequestHeaders({
    "Content-Type": "application/json",
    ...(timeZone ? { "X-User-Timezone": timeZone } : {}),
  })
}

function hasVisibleStructuredOutput(current: AgentStreamAccumulator): boolean {
  return Boolean(
    current.reasoning.trim() ||
    current.toolInvocations.length > 0 ||
    current.activityTimeline.length > 0 ||
    current.sources.length > 0
  )
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

export function useAgentSession({
  currentThreadId,
  setCurrentThreadId: baseSetCurrentThreadId,
  saveThread,
  threads,
  deleteThread,
}: ReturnType<typeof useThreadStore>) {
  const [state, setState] = useState(INITIAL_STATE)
  const [queuedSubmission, setQueuedSubmission] =
    useState<QueuedSubmission | null>(null)
  const submitLockRef = useRef(false)
  const messagesRef = useRef<AgentMessage[]>([])
  const attachmentPayloadsRef = useRef<AttachmentPayloadsByThread>(new Map())
  const abortControllerRef = useRef<AbortController | null>(null)
  const currentThreadIdRef = useRef(currentThreadId)

  const setCurrentThreadId = useCallback(
    (id: string | null) => {
      const previousThreadId = currentThreadIdRef.current
      if (previousThreadId && previousThreadId !== id) {
        attachmentPayloadsRef.current.delete(previousThreadId)
      }

      currentThreadIdRef.current = id
      baseSetCurrentThreadId(id)
    },
    [baseSetCurrentThreadId]
  )

  useEffect(() => {
    if (currentThreadId !== currentThreadIdRef.current) {
      const previousThreadId = currentThreadIdRef.current
      if (previousThreadId && previousThreadId !== currentThreadId) {
        attachmentPayloadsRef.current.delete(previousThreadId)
      }

      currentThreadIdRef.current = currentThreadId
    }
  }, [currentThreadId])

  const ensureCurrentThreadId = useCallback(() => {
    let activeThreadId = currentThreadIdRef.current
    if (!activeThreadId) {
      activeThreadId = crypto.randomUUID()
      setCurrentThreadId(activeThreadId)
    }

    return activeThreadId
  }, [setCurrentThreadId])

  const streamingState = state.isSubmitting || state.isStreaming
  const activeThread = currentThreadId
    ? threads.find((thread) => thread.id === currentThreadId)
    : undefined

  useEffect(() => {
    if (submitLockRef.current) {
      return
    }

    if (currentThreadId) {
      if (!activeThread) {
        return
      }

      setState({
        messages: activeThread.messages,
        isSubmitting: false,
        isStreaming: false,
      })
      messagesRef.current = activeThread.messages
      pruneThreadAttachmentPayloads(
        attachmentPayloadsRef.current,
        currentThreadId,
        activeThread.messages
      )
      return
    }

    setState(INITIAL_STATE)
    messagesRef.current = []
    attachmentPayloadsRef.current.clear()
  }, [activeThread, currentThreadId])

  useEffect(() => {
    messagesRef.current = state.messages
  }, [state.messages])

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      submitLockRef.current = false
    }
  }, [])

  const createThreadSnapshot = useCallback(
    (threadId: string, messages: AgentMessage[], model?: ModelType): Thread => {
      const existingThread = threads.find((thread) => thread.id === threadId)

      return {
        id: threadId,
        messages,
        ...(model
          ? { model }
          : existingThread?.model
            ? { model: existingThread.model }
            : {}),
        createdAt:
          existingThread?.createdAt ??
          messages[0]?.createdAt ??
          new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    },
    [threads]
  )

  const resetConversation = useCallback(() => {
    if (submitLockRef.current && currentThreadIdRef.current) {
      if (messagesRef.current.length <= 2) {
        deleteThread(currentThreadIdRef.current)
      }
    }

    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setQueuedSubmission(null)
    setState(INITIAL_STATE)
    messagesRef.current = []
    attachmentPayloadsRef.current.clear()
    currentThreadIdRef.current = null
    submitLockRef.current = false
    setCurrentThreadId(null)
  }, [deleteThread, setCurrentThreadId])

  const clearQueuedSubmission = useCallback(() => {
    setQueuedSubmission(null)
  }, [])

  const handleStopStream = useCallback(() => {
    if (!submitLockRef.current) {
      return
    }

    abortControllerRef.current?.abort()
  }, [])

  const streamAgentRequest = useCallback(
    async (params: {
      endpoint: string
      body: Record<string, unknown>
      baseMessages: AgentMessage[]
      model: ModelType
      runMode: AgentRunMode
      threadId: string
      errorTitle: string
    }) => {
      if (submitLockRef.current) {
        return false
      }

      const abortController = new AbortController()
      abortControllerRef.current = abortController
      submitLockRef.current = true
      messagesRef.current = params.baseMessages

      setState({
        messages: params.baseMessages,
        isSubmitting: true,
        isStreaming: false,
      })

      saveThread(
        createThreadSnapshot(
          params.threadId,
          params.baseMessages,
          params.model
        ),
        {
          immediate: true,
        }
      )

      const assistantId = createClientMessageId()
      const assistantCreatedAt = new Date().toISOString()
      let accumulator = createAgentStreamAccumulator()

      const upsertAssistantMessage = (
        nextAccumulator: AgentStreamAccumulator,
        streamFlags: Pick<AgentSessionState, "isSubmitting" | "isStreaming">
      ) => {
        if (params.threadId !== currentThreadIdRef.current) {
          return
        }

        const assistantMessage: AgentMessage = {
          id: assistantId,
          role: "assistant",
          content: nextAccumulator.content,
          llmModel: params.model,
          createdAt: assistantCreatedAt,
          metadata: {
            isStreaming: streamFlags.isStreaming,
            runMode: params.runMode,
            parts: [{ type: "text", text: nextAccumulator.content }],
            ...(nextAccumulator.agentStatus
              ? { agentStatus: nextAccumulator.agentStatus }
              : {}),
            ...(nextAccumulator.reasoning.trim().length > 0
              ? { reasoning: nextAccumulator.reasoning }
              : {}),
            ...(nextAccumulator.toolInvocations.length > 0
              ? { toolInvocations: nextAccumulator.toolInvocations }
              : {}),
            ...(nextAccumulator.activityTimeline.length > 0
              ? { activityTimeline: nextAccumulator.activityTimeline }
              : {}),
            ...(nextAccumulator.sources.length > 0
              ? { sources: nextAccumulator.sources }
              : {}),
          },
        }

        const currentMessages = messagesRef.current
        const existingIndex = currentMessages.findIndex(
          (message) => message.id === assistantId
        )

        const updatedMessages =
          existingIndex === -1
            ? [...currentMessages, assistantMessage]
            : currentMessages.map((message) =>
                message.id === assistantId ? assistantMessage : message
              )

        messagesRef.current = updatedMessages

        saveThread(
          createThreadSnapshot(params.threadId, updatedMessages, params.model),
          {
            immediate: !streamFlags.isStreaming,
          }
        )

        setState({
          messages: updatedMessages,
          isSubmitting: streamFlags.isSubmitting,
          isStreaming: streamFlags.isStreaming,
        })
      }

      const processLine = (line: string, appendNewline: boolean) => {
        const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line
        const parsedEvent = parseStreamEventLine(normalizedLine)

        accumulator = parsedEvent
          ? applyAgentStreamEvent(accumulator, parsedEvent)
          : appendRawStreamText(
              accumulator,
              appendNewline ? `${normalizedLine}\n` : normalizedLine
            )

        upsertAssistantMessage(accumulator, {
          isSubmitting: false,
          isStreaming: true,
        })
      }

      try {
        const response = await fetch(params.endpoint, {
          method: "POST",
          headers: createAgentRequestHeaders(),
          signal: abortController.signal,
          body: JSON.stringify(params.body),
        })

        if (response.status === 401) {
          setState({
            messages: params.baseMessages,
            isSubmitting: false,
            isStreaming: false,
          })
          redirectToSignIn()
          return true
        }

        if (!response.ok) {
          throw await createHttpErrorFromResponse(response)
        }

        if (!response.body) {
          throw createHttpError({
            message: await getResponseErrorMessage(response),
            requestId: getRequestIdFromHeaders(response.headers),
            status: response.status,
          })
        }

        try {
          await readResponseStreamLines(response.body, processLine)
        } catch (streamError) {
          if (isAbortError(streamError)) {
            throw streamError
          }

          accumulator = finalizeAgentStreamAccumulator(accumulator, "error")

          if (hasAgentStreamOutput(accumulator)) {
            upsertAssistantMessage(accumulator, {
              isSubmitting: false,
              isStreaming: false,
            })
            return true
          }

          throw new Error("Sorry, the response was interrupted.")
        }

        accumulator = finalizeAgentStreamAccumulator(accumulator, "success")

        if (
          !accumulator.content.trim() &&
          !hasVisibleStructuredOutput(accumulator)
        ) {
          accumulator = {
            ...accumulator,
            content: EMPTY_ASSISTANT_RESPONSE_FALLBACK,
          }
        }

        upsertAssistantMessage(accumulator, {
          isSubmitting: false,
          isStreaming: false,
        })
        return true
      } catch (error) {
        if (isAbortError(error)) {
          accumulator = finalizeAgentStreamAccumulator(accumulator, "error")

          if (hasAgentStreamOutput(accumulator)) {
            upsertAssistantMessage(accumulator, {
              isSubmitting: false,
              isStreaming: false,
            })
            return true
          }

          if (params.threadId === currentThreadIdRef.current) {
            setState((prev) => ({
              ...prev,
              isSubmitting: false,
              isStreaming: false,
            }))
          }
          return true
        }

        if (params.threadId !== currentThreadIdRef.current) {
          return true
        }

        const errorMessage = getHttpErrorMessage(error)
        toast.error(params.errorTitle, {
          description: formatHttpErrorDescription(error),
        })

        const fallback = `Sorry, I hit an error: ${errorMessage}`
        const assistantMessage: AgentMessage = {
          id: createClientMessageId(),
          role: "assistant",
          content: fallback,
          llmModel: params.model,
          createdAt: new Date().toISOString(),
          metadata: {
            isStreaming: false,
            runMode: params.runMode,
            parts: [{ type: "text", text: fallback }],
            agentStatus: "failed",
          },
        }

        const updatedMessages = [...messagesRef.current, assistantMessage]
        messagesRef.current = updatedMessages

        saveThread(
          createThreadSnapshot(params.threadId, updatedMessages, params.model),
          {
            immediate: true,
          }
        )

        setState({
          messages: updatedMessages,
          isSubmitting: false,
          isStreaming: false,
        })

        return true
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null
          submitLockRef.current = false
        }
      }
    },
    [createThreadSnapshot, saveThread]
  )

  const runAgentRequest = useCallback(
    async (
      nextMessages: AgentMessage[],
      model: ModelType,
      runMode: AgentRunMode = "chat",
      threadId?: string
    ) => {
      const activeThreadId = threadId ?? ensureCurrentThreadId()

      pruneThreadAttachmentPayloads(
        attachmentPayloadsRef.current,
        activeThreadId,
        nextMessages
      )

      const requestMessages = toRequestMessages(nextMessages, {
        attachmentsByMessageId:
          attachmentPayloadsRef.current.get(activeThreadId),
      })
      const hasAttachments = requestMessages.some(
        (message) => (message.attachments?.length ?? 0) > 0
      )
      const effectiveModel =
        runMode === "research" || hasAttachments
          ? AvailableModels.OPENAI_GPT_5_5
          : model

      return streamAgentRequest({
        endpoint: "/api/agent",
        threadId: activeThreadId,
        baseMessages: nextMessages,
        model: effectiveModel,
        runMode,
        errorTitle: "Failed to send message",
        body: {
          model: effectiveModel,
          runMode,
          threadId: activeThreadId,
          messages: requestMessages,
        },
      })
    },
    [ensureCurrentThreadId, streamAgentRequest]
  )

  const handleSubmit = useCallback(
    async (
      message: string,
      model: ModelType,
      runMode: AgentRunMode = "chat",
      attachments: AgentRequestAttachment[] = []
    ) => {
      const trimmedMessage = message.trim()
      if (!trimmedMessage) {
        return
      }

      if (trimmedMessage.length > CLIENT_MESSAGE_MAX_CHARS) {
        toast.error("Message too long", {
          description: `Please keep messages under ${String(CLIENT_MESSAGE_MAX_CHARS)} characters.`,
        })
        return
      }

      const activeThreadId = ensureCurrentThreadId()
      const nextMessages = appendUserMessage(
        messagesRef.current,
        trimmedMessage,
        model,
        runMode,
        attachments
      )

      const userMessage = nextMessages[nextMessages.length - 1]
      if (userMessage?.role === "user" && attachments.length > 0) {
        getThreadAttachmentPayloads(
          attachmentPayloadsRef.current,
          activeThreadId
        ).set(userMessage.id, attachments)
      }

      await runAgentRequest(nextMessages, model, runMode, activeThreadId)
    },
    [ensureCurrentThreadId, runAgentRequest]
  )

  const handleEditMessage = useCallback(
    ({ messageId, newContent, newModel, newRunMode }: EditMessageParams) => {
      const trimmedContent = newContent.trim()
      const currentMessages = messagesRef.current

      const messageIndex = currentMessages.findIndex(
        (message) => message.id === messageId && message.role === "user"
      )

      if (messageIndex === -1) {
        throw new Error("Message not found")
      }

      if (!trimmedContent) {
        throw new Error("Message cannot be empty")
      }

      if (trimmedContent.length > CLIENT_MESSAGE_MAX_CHARS) {
        throw new Error(
          `Message must be ${String(CLIENT_MESSAGE_MAX_CHARS)} characters or fewer.`
        )
      }

      const nextMessages = currentMessages.slice(0, messageIndex + 1)
      const targetMessage = nextMessages[messageIndex]

      if (targetMessage?.role !== "user") {
        throw new Error("Message not editable")
      }

      nextMessages[messageIndex] = {
        ...targetMessage,
        content: trimmedContent,
        llmModel: newModel,
        metadata: {
          ...targetMessage.metadata,
          selectedModel: newModel,
          runMode: newRunMode,
        },
      }

      if (submitLockRef.current) {
        throw new Error("Please wait for the current response to finish.")
      }

      const activeThreadId = currentThreadIdRef.current
      if (activeThreadId) {
        pruneThreadAttachmentPayloads(
          attachmentPayloadsRef.current,
          activeThreadId,
          nextMessages
        )

        saveThread(
          createThreadSnapshot(activeThreadId, nextMessages, newModel),
          {
            immediate: true,
          }
        )
      }

      void runAgentRequest(
        nextMessages,
        newModel,
        newRunMode,
        activeThreadId ?? undefined
      )
    },
    [createThreadSnapshot, runAgentRequest, saveThread]
  )

  const handlePromptSubmit = useCallback(
    (
      message: string,
      model: ModelType,
      queue: boolean,
      runMode: AgentRunMode = "chat",
      attachments: AgentRequestAttachment[] = []
    ) => {
      const trimmedMessage = message.trim()
      if (!trimmedMessage) {
        return
      }

      if (queue && submitLockRef.current) {
        setQueuedSubmission({
          message: trimmedMessage,
          model,
          runMode,
          attachments,
        })
        return
      }

      void handleSubmit(trimmedMessage, model, runMode, attachments)
    },
    [handleSubmit]
  )

  useEffect(() => {
    if (streamingState || submitLockRef.current || !queuedSubmission) {
      return
    }

    setQueuedSubmission(null)
    void handleSubmit(
      queuedSubmission.message,
      queuedSubmission.model,
      queuedSubmission.runMode,
      queuedSubmission.attachments
    )
  }, [streamingState, queuedSubmission, handleSubmit])

  return {
    state,
    queuedSubmission,
    streamingState,
    resetConversation,
    clearQueuedSubmission,
    handleStopStream,
    handlePromptSubmit,
    handleEditMessage,
  }
}
