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
import { getRequestIdFromHeaders } from "@/lib/request-id"
import {
  type AgentRequestAttachment,
  type AgentRunMode,
  type FollowUpQuestion,
  isModelType,
  type Message as AgentMessage,
  type ModelType,
  type Thread,
} from "@/lib/shared"

import {
  loadThreadAttachmentPayloads,
  persistMessageAttachments,
  pruneThreadAttachmentsToMessages,
} from "./agent-attachment-store"
import {
  type AttachmentPayloadsByThread,
  createAssistantMessageFromAccumulator,
  getThreadAttachmentPayloads,
  hasVisibleStructuredOutput,
  pruneThreadAttachmentPayloads,
  upsertAgentMessage,
} from "./agent-session-state"
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
  shouldRequestFollowUpQuestions,
  shouldStartParallelFollowUpQuestions,
} from "./follow-up-questions"
import {
  appendUserMessage,
  CLIENT_MESSAGE_MAX_CHARS,
  createAgentRequestHeaders,
  createClientMessageId,
  EMPTY_ASSISTANT_RESPONSE_FALLBACK,
  toRequestMessages,
} from "./home-agent-utils"
import { useFollowUpQuestions } from "./use-follow-up-questions"
import type { useThreadStore } from "./use-thread-store"

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

const INITIAL_STATE: AgentSessionState = {
  messages: [],
  isSubmitting: false,
  isStreaming: false,
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

  useEffect(() => {
    if (!currentThreadId) {
      return
    }

    if (attachmentPayloadsRef.current.has(currentThreadId)) {
      return
    }

    const hydration = { cancelled: false }
    void (async () => {
      const stored = await loadThreadAttachmentPayloads(currentThreadId)
      if (hydration.cancelled || stored.size === 0) {
        return
      }

      const existing = attachmentPayloadsRef.current.get(currentThreadId)
      if (!existing) {
        attachmentPayloadsRef.current.set(currentThreadId, stored)
        return
      }

      for (const [messageId, attachments] of stored) {
        if (!existing.has(messageId)) {
          existing.set(messageId, attachments)
        }
      }
    })()

    return () => {
      hydration.cancelled = true
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
        messagesRef.current = []
        const clearStateTimeout = window.setTimeout(() => {
          setState(INITIAL_STATE)
        }, 0)

        return () => {
          window.clearTimeout(clearStateTimeout)
        }
      }

      // eslint-disable-next-line react-hooks/set-state-in-effect -- selected thread changes must hydrate local session state before user input resumes
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
      void pruneThreadAttachmentsToMessages(
        currentThreadId,
        new Set(
          activeThread.messages
            .filter((message) => message.role === "user")
            .map((message) => message.id)
        )
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

  const commitMessages = useCallback((nextMessages: AgentMessage[]) => {
    setState((prev) => ({ ...prev, messages: nextMessages }))
  }, [])

  const {
    requestFollowUpQuestions,
    clearAllFollowUpBackfillRetries,
    requestedFollowUpMessageIdsRef,
    parallelFollowUpMessageIdsRef,
    pendingFollowUpQuestionsRef,
  } = useFollowUpQuestions({
    currentThreadId,
    currentThreadIdRef,
    messagesRef,
    messages: state.messages,
    streamingState,
    commitMessages,
    saveThread,
    createThreadSnapshot,
  })

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
    requestedFollowUpMessageIdsRef.current.clear()
    parallelFollowUpMessageIdsRef.current.clear()
    pendingFollowUpQuestionsRef.current.clear()
    clearAllFollowUpBackfillRetries()
    currentThreadIdRef.current = null
    submitLockRef.current = false
    setCurrentThreadId(null)
  }, [
    clearAllFollowUpBackfillRetries,
    deleteThread,
    parallelFollowUpMessageIdsRef,
    pendingFollowUpQuestionsRef,
    requestedFollowUpMessageIdsRef,
    setCurrentThreadId,
  ])

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
      let effectiveModel = params.model
      let accumulator = createAgentStreamAccumulator()

      const upsertAssistantMessage = (
        nextAccumulator: AgentStreamAccumulator,
        streamFlags: Pick<AgentSessionState, "isSubmitting" | "isStreaming">,
        options?: {
          followUpQuestions?: FollowUpQuestion[]
          followUpQuestionsPending?: boolean
        }
      ) => {
        if (params.threadId !== currentThreadIdRef.current) {
          return
        }

        const assistantMessage = createAssistantMessageFromAccumulator({
          id: assistantId,
          createdAt: assistantCreatedAt,
          accumulator: nextAccumulator,
          model: effectiveModel,
          runMode: params.runMode,
          isStreaming: streamFlags.isStreaming,
        })
        let assistantMessageWithFollowUpState = assistantMessage
        if (options?.followUpQuestions?.length) {
          assistantMessageWithFollowUpState = {
            ...assistantMessageWithFollowUpState,
            metadata: {
              ...assistantMessageWithFollowUpState.metadata,
              followUpQuestions: options.followUpQuestions,
            },
          }
        }
        if (options?.followUpQuestionsPending) {
          assistantMessageWithFollowUpState = {
            ...assistantMessageWithFollowUpState,
            metadata: {
              ...assistantMessageWithFollowUpState.metadata,
              followUpQuestionsPending: true,
            },
          }
        }
        const updatedMessages = upsertAgentMessage(
          messagesRef.current,
          assistantMessageWithFollowUpState
        )

        messagesRef.current = updatedMessages

        saveThread(
          createThreadSnapshot(
            params.threadId,
            updatedMessages,
            effectiveModel
          ),
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

      const startParallelFollowUpQuestions = () => {
        if (
          params.threadId !== currentThreadIdRef.current ||
          parallelFollowUpMessageIdsRef.current.has(assistantId) ||
          !shouldStartParallelFollowUpQuestions(accumulator)
        ) {
          return
        }

        parallelFollowUpMessageIdsRef.current.add(assistantId)
        requestFollowUpQuestions({
          assistantMessageId: assistantId,
          messages: messagesRef.current,
          model: effectiveModel,
          requestKind: "parallel",
          runMode: params.runMode,
          threadId: params.threadId,
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
        startParallelFollowUpQuestions()
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

        const responseEffectiveModel = response.headers.get(
          "x-agent-effective-model"
        )
        if (isModelType(responseEffectiveModel)) {
          effectiveModel = responseEffectiveModel
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

        const canRequestFollowUpQuestions =
          params.threadId === currentThreadIdRef.current &&
          shouldRequestFollowUpQuestions(accumulator)
        const parallelFollowUpQuestions =
          pendingFollowUpQuestionsRef.current.get(assistantId) ?? []
        const hasParallelFollowUpQuestions =
          parallelFollowUpQuestions.length > 0
        const shouldRequestFinalFollowUpQuestions =
          canRequestFollowUpQuestions &&
          !hasParallelFollowUpQuestions &&
          !requestedFollowUpMessageIdsRef.current.has(assistantId)
        const shouldShowPendingFollowUpQuestions =
          canRequestFollowUpQuestions &&
          !hasParallelFollowUpQuestions &&
          (shouldRequestFinalFollowUpQuestions ||
            parallelFollowUpMessageIdsRef.current.has(assistantId))
        upsertAssistantMessage(
          accumulator,
          {
            isSubmitting: false,
            isStreaming: false,
          },
          {
            followUpQuestions: hasParallelFollowUpQuestions
              ? parallelFollowUpQuestions
              : undefined,
            followUpQuestionsPending: shouldShowPendingFollowUpQuestions,
          }
        )
        pendingFollowUpQuestionsRef.current.delete(assistantId)
        if (hasParallelFollowUpQuestions || !canRequestFollowUpQuestions) {
          parallelFollowUpMessageIdsRef.current.delete(assistantId)
        }
        if (shouldRequestFinalFollowUpQuestions) {
          requestFollowUpQuestions({
            assistantMessageId: assistantId,
            messages: messagesRef.current,
            model: effectiveModel,
            requestKind: "final",
            runMode: params.runMode,
            threadId: params.threadId,
          })
        }
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
          llmModel: effectiveModel,
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
          createThreadSnapshot(
            params.threadId,
            updatedMessages,
            effectiveModel
          ),
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
    [
      createThreadSnapshot,
      parallelFollowUpMessageIdsRef,
      pendingFollowUpQuestionsRef,
      requestFollowUpQuestions,
      requestedFollowUpMessageIdsRef,
      saveThread,
    ]
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

      return streamAgentRequest({
        endpoint: "/api/agent",
        threadId: activeThreadId,
        baseMessages: nextMessages,
        model,
        runMode,
        errorTitle: "Failed to send message",
        body: {
          model,
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
        void persistMessageAttachments(
          activeThreadId,
          userMessage.id,
          attachments
        )
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
        void pruneThreadAttachmentsToMessages(
          activeThreadId,
          new Set(
            nextMessages
              .filter((message) => message.role === "user")
              .map((message) => message.id)
          )
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
      runMode: AgentRunMode = "chat",
      attachments: AgentRequestAttachment[] = []
    ) => {
      const trimmedMessage = message.trim()
      if (!trimmedMessage) {
        return
      }

      if (submitLockRef.current) {
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
