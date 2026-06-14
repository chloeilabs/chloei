import { useCallback, useEffect, useRef, useState } from "react"

import { redirectToSignIn } from "@/lib/auth-client"
import { isAbortError } from "@/lib/cast"
import {
  type FollowUpQuestion,
  type Message as AgentMessage,
  type ModelType,
  type Thread,
} from "@/lib/shared"

import {
  attachFollowUpQuestionsToMessage,
  setFollowUpQuestionsPendingForMessage,
} from "./agent-session-state"
import {
  type FollowUpQuestionRequestParams,
  getFollowUpQuestionRequestTargets,
  hasGeneratedFollowUpQuestions,
  hasOnlyLegacyCannedFollowUpQuestions,
  parseFollowUpQuestionsResponse,
} from "./follow-up-questions"
import {
  createAgentRequestHeaders,
  toRequestMessages,
} from "./home-agent-utils"
import type { useThreadStore } from "./use-thread-store"

const FOLLOW_UP_BACKFILL_RETRY_DELAY_MS = 1500
const FOLLOW_UP_BACKFILL_MAX_RETRIES = 2

interface FollowUpQuestionsHost {
  currentThreadId: string | null
  currentThreadIdRef: { current: string | null }
  messagesRef: { current: AgentMessage[] }
  messages: AgentMessage[]
  streamingState: boolean
  commitMessages: (messages: AgentMessage[]) => void
  saveThread: ReturnType<typeof useThreadStore>["saveThread"]
  createThreadSnapshot: (
    threadId: string,
    messages: AgentMessage[],
    model?: ModelType
  ) => Thread
}

/**
 * Owns the assistant follow-up-question lifecycle: the in-flight/parallel/
 * pending bookkeeping refs, the bounded backfill retry state machine, and the
 * effect that backfills follow-ups for completed turns that are missing them.
 * The streaming session in `useAgentSession` drives it via the returned
 * `requestFollowUpQuestions` and the shared bookkeeping refs.
 */
export function useFollowUpQuestions({
  currentThreadId,
  currentThreadIdRef,
  messagesRef,
  messages,
  streamingState,
  commitMessages,
  saveThread,
  createThreadSnapshot,
}: FollowUpQuestionsHost) {
  const [followUpBackfillVersion, setFollowUpBackfillVersion] = useState(0)
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
    [currentThreadIdRef]
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
      commitMessages(updatedMessages)

      return true
    },
    [
      commitMessages,
      createThreadSnapshot,
      currentThreadIdRef,
      messagesRef,
      saveThread,
    ]
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
      commitMessages(updatedMessages)

      return true
    },
    [
      commitMessages,
      createThreadSnapshot,
      currentThreadIdRef,
      messagesRef,
      saveThread,
    ]
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
      currentThreadIdRef,
      messagesRef,
      scheduleFollowUpBackfillRetry,
      setFollowUpQuestionsPending,
    ]
  )

  useEffect(() => {
    if (!currentThreadId || streamingState) {
      return
    }

    const messageIds = new Set(messages.map((message) => message.id))
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
      messages,
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
    clearFollowUpBackfillRetry,
    currentThreadId,
    followUpBackfillVersion,
    messages,
    requestFollowUpQuestions,
    streamingState,
  ])

  useEffect(() => {
    const parallelFollowUpMessageIds = parallelFollowUpMessageIdsRef.current
    const pendingFollowUpQuestions = pendingFollowUpQuestionsRef.current

    return () => {
      clearAllFollowUpBackfillRetries()
      parallelFollowUpMessageIds.clear()
      pendingFollowUpQuestions.clear()
    }
  }, [clearAllFollowUpBackfillRetries])

  return {
    requestFollowUpQuestions,
    clearAllFollowUpBackfillRetries,
    requestedFollowUpMessageIdsRef,
    parallelFollowUpMessageIdsRef,
    pendingFollowUpQuestionsRef,
  }
}
