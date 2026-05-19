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
import { createRequestHeaders, getRequestIdFromHeaders } from "@/lib/request-id"
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
  attachFollowUpQuestionsToMessage,
  type AttachmentPayloadsByThread,
  createAssistantMessageFromAccumulator,
  getThreadAttachmentPayloads,
  hasVisibleStructuredOutput,
  pruneThreadAttachmentPayloads,
  setFollowUpQuestionsPendingForMessage,
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
  appendUserMessage,
  CLIENT_MESSAGE_MAX_CHARS,
  createClientMessageId,
  EMPTY_ASSISTANT_RESPONSE_FALLBACK,
  toRequestMessages,
} from "./home-agent-utils"
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

interface FollowUpQuestionRequestTarget {
  assistantMessageId: string
  messages: AgentMessage[]
  model: ModelType
  runMode: AgentRunMode
}

type FollowUpQuestionRequestKind = "backfill" | "final" | "parallel"

interface FollowUpQuestionRequestParams {
  assistantMessageId: string
  requestKind: FollowUpQuestionRequestKind
  messages: AgentMessage[]
  model: ModelType
  runMode: AgentRunMode
  threadId: string
}

const INITIAL_STATE: AgentSessionState = {
  messages: [],
  isSubmitting: false,
  isStreaming: false,
}

const FOLLOW_UP_BACKFILL_RETRY_DELAY_MS = 1500
const FOLLOW_UP_BACKFILL_MAX_RETRIES = 2
const PARALLEL_FOLLOW_UP_MIN_CHARS = 80

// Older local threads may still contain canned suggestion ids from an earlier
// implementation. Treat those as absent so only generated follow-ups render.
const LEGACY_CANNED_FOLLOW_UP_ID_PREFIX = "fallback-follow-up"

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

function isFollowUpQuestion(value: unknown): value is FollowUpQuestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const question = value as Record<string, unknown>
  return (
    typeof question.id === "string" &&
    question.id.trim().length > 0 &&
    typeof question.text === "string" &&
    question.text.trim().length > 0
  )
}

function parseFollowUpQuestionsResponse(payload: unknown): FollowUpQuestion[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return []
  }

  const questions = (payload as Record<string, unknown>).followUpQuestions
  if (!Array.isArray(questions)) {
    return []
  }

  return questions
    .filter(isFollowUpQuestion)
    .slice(0, 3)
    .map((question) => ({
      id: question.id.trim(),
      text: question.text.trim(),
    }))
}

function shouldRequestFollowUpQuestions(
  accumulator: AgentStreamAccumulator
): boolean {
  const content = accumulator.content.trim()

  return Boolean(
    content &&
    content !== EMPTY_ASSISTANT_RESPONSE_FALLBACK &&
    accumulator.agentStatus === "completed"
  )
}

function shouldStartParallelFollowUpQuestions(
  accumulator: AgentStreamAccumulator
): boolean {
  const content = accumulator.content.trim()

  return (
    content.length >= PARALLEL_FOLLOW_UP_MIN_CHARS &&
    content !== EMPTY_ASSISTANT_RESPONSE_FALLBACK
  )
}

function hasOnlyLegacyCannedFollowUpQuestions(
  questions: readonly FollowUpQuestion[] | undefined
): boolean {
  return Boolean(
    questions?.length &&
    questions.every((question) =>
      question.id.startsWith(LEGACY_CANNED_FOLLOW_UP_ID_PREFIX)
    )
  )
}

function hasGeneratedFollowUpQuestions(
  questions: readonly FollowUpQuestion[] | undefined
): boolean {
  return Boolean(
    questions?.some(
      (question) => !question.id.startsWith(LEGACY_CANNED_FOLLOW_UP_ID_PREFIX)
    )
  )
}

function getFollowUpQuestionRequestTargets(
  messages: AgentMessage[],
  requestedMessageIds: ReadonlySet<string>
): FollowUpQuestionRequestTarget[] {
  const targets: FollowUpQuestionRequestTarget[] = []

  messages.forEach((message, index) => {
    if (message.role !== "assistant") {
      return
    }

    const content = message.content.trim()
    const model = isModelType(message.llmModel)
      ? message.llmModel
      : message.metadata?.selectedModel

    if (
      !content ||
      content === EMPTY_ASSISTANT_RESPONSE_FALLBACK ||
      message.metadata?.isStreaming === true ||
      message.metadata?.agentStatus !== "completed" ||
      hasGeneratedFollowUpQuestions(message.metadata.followUpQuestions) ||
      requestedMessageIds.has(message.id) ||
      !isModelType(model)
    ) {
      return
    }

    targets.push({
      assistantMessageId: message.id,
      messages: messages.slice(0, index + 1),
      model,
      runMode: message.metadata.runMode ?? "chat",
    })
  })

  return targets
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
  const [followUpBackfillVersion, setFollowUpBackfillVersion] = useState(0)
  const submitLockRef = useRef(false)
  const messagesRef = useRef<AgentMessage[]>([])
  const attachmentPayloadsRef = useRef<AttachmentPayloadsByThread>(new Map())
  const abortControllerRef = useRef<AbortController | null>(null)
  const currentThreadIdRef = useRef(currentThreadId)
  const requestedFollowUpMessageIdsRef = useRef<Set<string>>(new Set())
  const parallelFollowUpMessageIdsRef = useRef<Set<string>>(new Set())
  const pendingFollowUpQuestionsRef = useRef<Map<string, FollowUpQuestion[]>>(
    new Map()
  )
  const followUpBackfillRetryCountsRef = useRef<Map<string, number>>(new Map())
  const followUpBackfillRetryTimeoutsRef = useRef<Map<string, number>>(
    new Map()
  )

  const clearFollowUpBackfillRetry = useCallback(
    (assistantMessageId: string) => {
      const timeoutId =
        followUpBackfillRetryTimeoutsRef.current.get(assistantMessageId)
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
        followUpBackfillRetryTimeoutsRef.current.delete(assistantMessageId)
      }

      followUpBackfillRetryCountsRef.current.delete(assistantMessageId)
    },
    []
  )

  const clearAllFollowUpBackfillRetries = useCallback(() => {
    for (const timeoutId of followUpBackfillRetryTimeoutsRef.current.values()) {
      window.clearTimeout(timeoutId)
    }
    followUpBackfillRetryTimeoutsRef.current.clear()
    followUpBackfillRetryCountsRef.current.clear()
  }, [])

  const scheduleFollowUpBackfillRetry = useCallback(
    (params: { assistantMessageId: string; threadId: string }) => {
      if (params.threadId !== currentThreadIdRef.current) {
        return false
      }

      const retryCount =
        followUpBackfillRetryCountsRef.current.get(params.assistantMessageId) ??
        0
      if (retryCount >= FOLLOW_UP_BACKFILL_MAX_RETRIES) {
        return false
      }

      const existingTimeoutId = followUpBackfillRetryTimeoutsRef.current.get(
        params.assistantMessageId
      )
      if (existingTimeoutId !== undefined) {
        window.clearTimeout(existingTimeoutId)
      }

      followUpBackfillRetryCountsRef.current.set(
        params.assistantMessageId,
        retryCount + 1
      )
      const timeoutId = window.setTimeout(() => {
        followUpBackfillRetryTimeoutsRef.current.delete(
          params.assistantMessageId
        )
        if (params.threadId !== currentThreadIdRef.current) {
          return
        }

        setFollowUpBackfillVersion((version) => version + 1)
      }, FOLLOW_UP_BACKFILL_RETRY_DELAY_MS)
      followUpBackfillRetryTimeoutsRef.current.set(
        params.assistantMessageId,
        timeoutId
      )
      return true
    },
    []
  )

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
    const parallelFollowUpMessageIds = parallelFollowUpMessageIdsRef.current
    const pendingFollowUpQuestions = pendingFollowUpQuestionsRef.current

    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      clearAllFollowUpBackfillRetries()
      parallelFollowUpMessageIds.clear()
      pendingFollowUpQuestions.clear()
      submitLockRef.current = false
    }
  }, [clearAllFollowUpBackfillRetries])

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

  const attachFollowUpQuestionsToCompletedMessage = useCallback(
    (params: {
      assistantMessageId: string
      followUpQuestions: FollowUpQuestion[]
      model: ModelType
      replaceExisting?: boolean
      replaceLegacyCanned?: boolean
      threadId: string
    }) => {
      if (params.followUpQuestions.length === 0) {
        return false
      }

      if (params.threadId !== currentThreadIdRef.current) {
        return false
      }

      const sourceMessage = messagesRef.current.find(
        (message) =>
          message.id === params.assistantMessageId &&
          message.role === "assistant"
      )
      const existingFollowUpQuestions =
        sourceMessage?.metadata?.followUpQuestions
      const hasExistingFollowUpQuestions =
        (existingFollowUpQuestions?.length ?? 0) > 0
      const canReplaceExistingFollowUpQuestions =
        params.replaceExisting === true ||
        (params.replaceLegacyCanned === true &&
          hasOnlyLegacyCannedFollowUpQuestions(existingFollowUpQuestions))
      if (
        !sourceMessage ||
        sourceMessage.metadata?.isStreaming === true ||
        sourceMessage.metadata?.agentStatus !== "completed" ||
        (hasExistingFollowUpQuestions && !canReplaceExistingFollowUpQuestions)
      ) {
        return false
      }

      const updatedMessages = attachFollowUpQuestionsToMessage(
        messagesRef.current,
        params.assistantMessageId,
        params.followUpQuestions
      )
      if (updatedMessages === messagesRef.current) {
        return false
      }

      messagesRef.current = updatedMessages
      saveThread(
        createThreadSnapshot(params.threadId, updatedMessages, params.model),
        {
          immediate: true,
        }
      )
      setState((prev) => ({
        ...prev,
        messages: updatedMessages,
      }))

      return true
    },
    [createThreadSnapshot, saveThread]
  )

  const setFollowUpQuestionsPending = useCallback(
    (params: {
      assistantMessageId: string
      isPending: boolean
      model: ModelType
      threadId: string
    }) => {
      if (params.threadId !== currentThreadIdRef.current) {
        return false
      }

      const updatedMessages = setFollowUpQuestionsPendingForMessage(
        messagesRef.current,
        params.assistantMessageId,
        params.isPending
      )
      if (updatedMessages === messagesRef.current) {
        return false
      }

      messagesRef.current = updatedMessages
      saveThread(
        createThreadSnapshot(params.threadId, updatedMessages, params.model),
        {
          immediate: true,
        }
      )
      setState((prev) => ({
        ...prev,
        messages: updatedMessages,
      }))

      return true
    },
    [createThreadSnapshot, saveThread]
  )

  const requestFollowUpQuestions = useCallback(
    (params: FollowUpQuestionRequestParams) => {
      const isParallelRequest = params.requestKind === "parallel"
      if (!isParallelRequest) {
        requestedFollowUpMessageIdsRef.current.add(params.assistantMessageId)
      }

      const clearRequestedFollowUpQuestion = () => {
        if (!isParallelRequest) {
          requestedFollowUpMessageIdsRef.current.delete(
            params.assistantMessageId
          )
        }
      }

      const retryFollowUpQuestionBackfill = () => {
        if (isParallelRequest) {
          pendingFollowUpQuestionsRef.current.delete(params.assistantMessageId)
          return
        }

        clearRequestedFollowUpQuestion()
        const isRetryScheduled = scheduleFollowUpBackfillRetry({
          assistantMessageId: params.assistantMessageId,
          threadId: params.threadId,
        })
        if (!isRetryScheduled) {
          setFollowUpQuestionsPending({
            assistantMessageId: params.assistantMessageId,
            isPending: false,
            model: params.model,
            threadId: params.threadId,
          })
        }
      }

      void (async () => {
        try {
          const response = await fetch("/api/agent/follow-ups", {
            method: "POST",
            headers: createAgentRequestHeaders(),
            body: JSON.stringify({
              model: params.model,
              runMode: params.runMode,
              threadId: params.threadId,
              assistantMessageId: params.assistantMessageId,
              messages: toRequestMessages(params.messages),
            }),
          })

          if (response.status === 401) {
            clearRequestedFollowUpQuestion()
            parallelFollowUpMessageIdsRef.current.delete(
              params.assistantMessageId
            )
            pendingFollowUpQuestionsRef.current.delete(
              params.assistantMessageId
            )
            clearFollowUpBackfillRetry(params.assistantMessageId)
            redirectToSignIn()
            return
          }

          if (!response.ok) {
            retryFollowUpQuestionBackfill()
            return
          }

          const followUpQuestions = parseFollowUpQuestionsResponse(
            await response.json()
          )
          if (followUpQuestions.length === 0) {
            retryFollowUpQuestionBackfill()
            return
          }

          if (params.threadId !== currentThreadIdRef.current) {
            clearRequestedFollowUpQuestion()
            parallelFollowUpMessageIdsRef.current.delete(
              params.assistantMessageId
            )
            pendingFollowUpQuestionsRef.current.delete(
              params.assistantMessageId
            )
            clearFollowUpBackfillRetry(params.assistantMessageId)
            return
          }

          const sourceMessage = messagesRef.current.find(
            (message) =>
              message.id === params.assistantMessageId &&
              message.role === "assistant"
          )
          const existingFollowUpQuestions =
            sourceMessage?.metadata?.followUpQuestions
          const hasExistingFollowUpQuestions =
            (existingFollowUpQuestions?.length ?? 0) > 0
          const canReplaceExistingFollowUpQuestions =
            hasOnlyLegacyCannedFollowUpQuestions(existingFollowUpQuestions)

          if (isParallelRequest) {
            const attached = attachFollowUpQuestionsToCompletedMessage({
              assistantMessageId: params.assistantMessageId,
              followUpQuestions,
              model: params.model,
              replaceLegacyCanned: true,
              threadId: params.threadId,
            })
            if (attached) {
              parallelFollowUpMessageIdsRef.current.delete(
                params.assistantMessageId
              )
              pendingFollowUpQuestionsRef.current.delete(
                params.assistantMessageId
              )
              clearFollowUpBackfillRetry(params.assistantMessageId)
              return
            }

            if (
              sourceMessage &&
              (sourceMessage.metadata?.isStreaming === true ||
                sourceMessage.metadata?.agentStatus !== "completed")
            ) {
              pendingFollowUpQuestionsRef.current.set(
                params.assistantMessageId,
                followUpQuestions
              )
              return
            }

            pendingFollowUpQuestionsRef.current.delete(
              params.assistantMessageId
            )
            parallelFollowUpMessageIdsRef.current.delete(
              params.assistantMessageId
            )
            if (hasGeneratedFollowUpQuestions(existingFollowUpQuestions)) {
              setFollowUpQuestionsPending({
                assistantMessageId: params.assistantMessageId,
                isPending: false,
                model: params.model,
                threadId: params.threadId,
              })
            }
            return
          }

          if (
            !sourceMessage ||
            (hasExistingFollowUpQuestions &&
              !canReplaceExistingFollowUpQuestions)
          ) {
            clearRequestedFollowUpQuestion()
            clearFollowUpBackfillRetry(params.assistantMessageId)
            setFollowUpQuestionsPending({
              assistantMessageId: params.assistantMessageId,
              isPending: false,
              model: params.model,
              threadId: params.threadId,
            })
            return
          }

          if (
            sourceMessage.metadata?.isStreaming === true ||
            sourceMessage.metadata?.agentStatus !== "completed"
          ) {
            retryFollowUpQuestionBackfill()
            return
          }

          const attached = attachFollowUpQuestionsToCompletedMessage({
            assistantMessageId: params.assistantMessageId,
            followUpQuestions,
            model: params.model,
            replaceLegacyCanned: true,
            threadId: params.threadId,
          })
          if (attached) {
            clearRequestedFollowUpQuestion()
            parallelFollowUpMessageIdsRef.current.delete(
              params.assistantMessageId
            )
            pendingFollowUpQuestionsRef.current.delete(
              params.assistantMessageId
            )
            clearFollowUpBackfillRetry(params.assistantMessageId)
          }
        } catch (error) {
          if (isAbortError(error)) {
            return
          }

          retryFollowUpQuestionBackfill()
        }
      })()
    },
    [
      attachFollowUpQuestionsToCompletedMessage,
      clearFollowUpBackfillRetry,
      scheduleFollowUpBackfillRetry,
      setFollowUpQuestionsPending,
    ]
  )

  useEffect(() => {
    if (!currentThreadId || streamingState) {
      return
    }

    const messageIds = new Set(state.messages.map((message) => message.id))
    for (const messageId of Array.from(
      requestedFollowUpMessageIdsRef.current
    )) {
      if (!messageIds.has(messageId)) {
        requestedFollowUpMessageIdsRef.current.delete(messageId)
        clearFollowUpBackfillRetry(messageId)
      }
    }
    for (const messageId of Array.from(parallelFollowUpMessageIdsRef.current)) {
      if (!messageIds.has(messageId)) {
        parallelFollowUpMessageIdsRef.current.delete(messageId)
        pendingFollowUpQuestionsRef.current.delete(messageId)
      }
    }
    for (const messageId of Array.from(
      pendingFollowUpQuestionsRef.current.keys()
    )) {
      if (!messageIds.has(messageId)) {
        pendingFollowUpQuestionsRef.current.delete(messageId)
      }
    }
    for (const messageId of Array.from(
      followUpBackfillRetryCountsRef.current.keys()
    )) {
      if (!messageIds.has(messageId)) {
        clearFollowUpBackfillRetry(messageId)
      }
    }

    const targets = getFollowUpQuestionRequestTargets(
      state.messages,
      requestedFollowUpMessageIdsRef.current
    )

    for (const target of targets) {
      requestedFollowUpMessageIdsRef.current.add(target.assistantMessageId)
      requestFollowUpQuestions({
        ...target,
        requestKind: "backfill",
        threadId: currentThreadId,
      })
    }
  }, [
    attachFollowUpQuestionsToCompletedMessage,
    clearFollowUpBackfillRetry,
    currentThreadId,
    followUpBackfillVersion,
    requestFollowUpQuestions,
    state.messages,
    streamingState,
  ])

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
  }, [clearAllFollowUpBackfillRetries, deleteThread, setCurrentThreadId])

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
    [createThreadSnapshot, requestFollowUpQuestions, saveThread]
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
