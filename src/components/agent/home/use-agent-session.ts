import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { redirectToSignIn } from "@/lib/auth-client"
import { isAbortError } from "@/lib/cast"
import {
  deriveThreadTitle,
  type Message as AgentMessage,
  type ModelType,
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
  createClientMessageId,
  EMPTY_ASSISTANT_RESPONSE_FALLBACK,
  toRequestMessages,
} from "./home-agent-utils"
import { useThreads } from "./threads-context"

const CLIENT_MESSAGE_MAX_CHARS = 16_000

interface AgentSessionState {
  messages: AgentMessage[]
  isSubmitting: boolean
  isStreaming: boolean
}

interface EditMessageParams {
  messageId: string
  newContent: string
  newModel: ModelType
}

interface QueuedSubmission {
  message: string
  model: ModelType
}

const INITIAL_STATE: AgentSessionState = {
  messages: [],
  isSubmitting: false,
  isStreaming: false,
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

  return {
    "Content-Type": "application/json",
    ...(timeZone ? { "X-User-Timezone": timeZone } : {}),
  }
}

function hasVisibleStructuredOutput(current: AgentStreamAccumulator): boolean {
  return Boolean(
    current.reasoning.trim() ||
      current.toolInvocations.length > 0 ||
      current.activityTimeline.length > 0 ||
      current.sources.length > 0
  )
}

export function useAgentSession() {
  const {
    currentThreadId,
    setCurrentThreadId: baseSetCurrentThreadId,
    saveThread,
    threads,
    deleteThread,
  } = useThreads()

  const [state, setState] = useState(INITIAL_STATE)
  const [queuedSubmission, setQueuedSubmission] =
    useState<QueuedSubmission | null>(null)
  const submitLockRef = useRef(false)
  const messagesRef = useRef<AgentMessage[]>([])
  const abortControllerRef = useRef<AbortController | null>(null)
  const currentThreadIdRef = useRef(currentThreadId)

  const setCurrentThreadId = useCallback(
    (id: string | null) => {
      currentThreadIdRef.current = id
      baseSetCurrentThreadId(id)
    },
    [baseSetCurrentThreadId]
  )

  useEffect(() => {
    if (currentThreadId !== currentThreadIdRef.current) {
      currentThreadIdRef.current = currentThreadId
    }
  }, [currentThreadId])

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
      return
    }

    setState(INITIAL_STATE)
    messagesRef.current = []
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
      const nextDerivedTitle = deriveThreadTitle(messages)
      const previousDerivedTitle = existingThread
        ? deriveThreadTitle(existingThread.messages)
        : nextDerivedTitle
      const existingTitle = existingThread?.title.trim() ?? ""
      const hasCustomTitle =
        existingTitle !== "" && existingTitle !== previousDerivedTitle

      return {
        id: threadId,
        title: hasCustomTitle ? existingTitle : nextDerivedTitle,
        messages,
        ...(model
          ? { model }
          : existingThread?.model
            ? { model: existingThread.model }
            : {}),
        isPinned: existingThread?.isPinned ?? false,
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
        createThreadSnapshot(params.threadId, params.baseMessages, params.model),
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

        if (!response.ok || !response.body) {
          throw new Error(await getResponseErrorMessage(response))
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

        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred"
        toast.error(params.errorTitle, { description: errorMessage })

        const fallback = `Sorry, I hit an error: ${errorMessage}`
        const assistantMessage: AgentMessage = {
          id: createClientMessageId(),
          role: "assistant",
          content: fallback,
          llmModel: params.model,
          createdAt: new Date().toISOString(),
          metadata: {
            isStreaming: false,
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
    async (nextMessages: AgentMessage[], model: ModelType) => {
      let activeThreadId = currentThreadIdRef.current
      if (!activeThreadId) {
        activeThreadId = crypto.randomUUID()
        setCurrentThreadId(activeThreadId)
      }

      return streamAgentRequest({
        endpoint: "/api/agent",
        threadId: activeThreadId,
        baseMessages: nextMessages,
        model,
        errorTitle: "Failed to send message",
        body: {
          model,
          threadId: activeThreadId,
          messages: toRequestMessages(nextMessages),
        },
      })
    },
    [setCurrentThreadId, streamAgentRequest]
  )

  const handleSubmit = useCallback(
    async (message: string, model: ModelType) => {
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

      const nextMessages = appendUserMessage(
        messagesRef.current,
        trimmedMessage,
        model
      )

      await runAgentRequest(nextMessages, model)
    },
    [runAgentRequest]
  )

  const handleEditMessage = useCallback(
    ({ messageId, newContent, newModel }: EditMessageParams) => {
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
        },
      }

      if (submitLockRef.current) {
        throw new Error("Please wait for the current response to finish.")
      }

      if (currentThreadIdRef.current) {
        saveThread(
          createThreadSnapshot(currentThreadIdRef.current, nextMessages, newModel),
          {
            immediate: true,
          }
        )
      }

      void runAgentRequest(nextMessages, newModel)
    },
    [createThreadSnapshot, runAgentRequest, saveThread]
  )

  const handlePromptSubmit = useCallback(
    (message: string, model: ModelType, queue: boolean) => {
      const trimmedMessage = message.trim()
      if (!trimmedMessage) {
        return
      }

      if (queue && submitLockRef.current) {
        setQueuedSubmission({
          message: trimmedMessage,
          model,
        })
        return
      }

      void handleSubmit(trimmedMessage, model)
    },
    [handleSubmit]
  )

  useEffect(() => {
    if (streamingState || submitLockRef.current || !queuedSubmission) {
      return
    }

    setQueuedSubmission(null)
    void handleSubmit(queuedSubmission.message, queuedSubmission.model)
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
