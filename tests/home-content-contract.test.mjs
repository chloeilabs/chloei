import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const homeContentPath = path.join(
  cwd,
  "src/components/agent/home/home-content.tsx"
)

test("home animated prompt forwards attachments from the initial prompt", async () => {
  const source = await readFile(homeContentPath, "utf8")

  assert.match(
    source,
    /attachments:\s*AgentRequestAttachment\[\]\s*=\s*\[\]/,
    "Expected the animated initial prompt submit handler to accept attachments."
  )

  const forwardedCalls = source.match(
    /handlePromptSubmit\(message,\s*model,\s*runMode,\s*attachments\)/g
  )
  assert.equal(
    forwardedCalls?.length,
    4,
    "Expected every animated prompt branch to forward attachments."
  )
  assert.match(
    source,
    /const handlePromptFormSubmit = useCallback\([\s\S]*handlePromptSubmit\(message,\s*model,\s*runMode,\s*attachments\)/,
    "Expected PromptForm's streaming argument to be adapted outside the session hook."
  )
})

test("prompt submissions queue while the submit lock is still active", async () => {
  const source = await readFile(
    path.join(cwd, "src/components/agent/home/use-agent-session.ts"),
    "utf8"
  )

  assert.match(
    source,
    /if \(submitLockRef\.current\) \{[\s\S]*setQueuedSubmission\(\{[\s\S]*message: trimmedMessage,[\s\S]*return[\s\S]*\}/,
    "Expected follow-up submissions during the stream cleanup window to be queued."
  )
  assert.doesNotMatch(
    source,
    /if \(queue && submitLockRef\.current\)/,
    "Expected queueing to depend on the actual submit lock, not only the PromptForm streaming prop."
  )
})

test("first active conversation turn stays bottom-pinned during streaming", async () => {
  const source = await readFile(homeContentPath, "utf8")

  assert.match(
    source,
    /const isOnlyTurn = latestTurnGroups\.length === 1/,
    "Expected the scroll target logic to detect the first conversation turn."
  )
  assert.match(
    source,
    /isOnlyTurn[\s\S]*isActiveTurnInProgress[\s\S]*return targetScrollTop/,
    "Expected the first active turn to follow the true bottom target while the first response streams."
  )
})

test("follow-up questions are prefetched while the assistant is streaming", async () => {
  const source = await readFile(
    path.join(cwd, "src/components/agent/home/use-agent-session.ts"),
    "utf8"
  )
  const followUpSource = await readFile(
    path.join(cwd, "src/components/agent/home/follow-up-questions.ts"),
    "utf8"
  )

  assert.match(
    followUpSource,
    /const PARALLEL_FOLLOW_UP_MIN_CHARS = 80/,
    "Expected follow-up generation to start early enough to hide network latency behind long streams."
  )
  assert.match(
    source,
    /shouldStartParallelFollowUpQuestions|pendingFollowUpQuestionsRef/,
    "Expected parallel follow-up state for caching questions before the completed render."
  )
  assert.match(
    source,
    /startParallelFollowUpQuestions[\s\S]*requestKind:\s*"parallel"/,
    "Expected follow-up generation to start from the streaming assistant response."
  )
  assert.match(
    source,
    /const parallelFollowUpQuestions =[\s\S]*pendingFollowUpQuestionsRef\.current\.get\(assistantId\)[\s\S]*upsertAssistantMessage\(\s*accumulator,[\s\S]*followUpQuestions:\s*hasParallelFollowUpQuestions[\s\S]*parallelFollowUpQuestions[\s\S]*followUpQuestionsPending:\s*shouldShowPendingFollowUpQuestions/,
    "Expected prefetched questions or the pending state to be included in the same render that completes streaming."
  )
  assert.match(
    source,
    /if \(shouldRequestFinalFollowUpQuestions\) \{[\s\S]*requestKind:\s*"final"/,
    "Expected the final follow-up request to remain as a fallback when the parallel result is not ready."
  )
})

test("follow-up backfill retries are retriggered after transient misses", async () => {
  const source = await readFile(
    path.join(cwd, "src/components/agent/home/use-follow-up-questions.ts"),
    "utf8"
  )

  assert.match(
    source,
    /const \[followUpBackfillVersion,\s*setFollowUpBackfillVersion\] = useState\(0\)/,
    "Expected follow-up backfill to have an explicit retry trigger."
  )
  assert.match(
    source,
    /const scheduleFollowUpBackfillRetry = useCallback\([\s\S]*setFollowUpBackfillVersion\(\(version\) => version \+ 1\)/,
    "Expected transient follow-up misses to schedule a bounded backfill retry."
  )
  assert.match(
    source,
    /if \(!response\.ok\) \{[\s\S]*retryFollowUpQuestionBackfill\(\)[\s\S]*return[\s\S]*\}/,
    "Expected failed follow-up responses to clear the in-flight guard and trigger backfill."
  )
  assert.match(
    source,
    /if \(followUpQuestions\.length === 0\) \{[\s\S]*retryFollowUpQuestionBackfill\(\)[\s\S]*return[\s\S]*\}/,
    "Expected empty follow-up responses to clear the in-flight guard and trigger backfill."
  )
  assert.match(
    source,
    /if \(params\.threadId !== currentThreadIdRef\.current\) \{[\s\S]*clearRequestedFollowUpQuestion\(\)[\s\S]*return[\s\S]*\}/,
    "Expected in-flight follow-up requests to be cleared when users switch threads."
  )
})
