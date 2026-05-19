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

test("follow-up questions are requested once after streaming completes", async () => {
  const source = await readFile(
    path.join(cwd, "src/components/agent/home/use-agent-session.ts"),
    "utf8"
  )

  assert.doesNotMatch(
    source,
    /requestKind:\s*"parallel"/,
    "Expected follow-up generation to avoid partial-stream requests."
  )
  assert.doesNotMatch(
    source,
    /shouldStartParallelFollowUpQuestions|PARALLEL_FOLLOW_UP_MIN_CHARS|pendingFollowUpQuestionsRef/,
    "Expected no parallel follow-up state that can visibly replace chips after completion."
  )
  assert.match(
    source,
    /upsertAssistantMessage\(accumulator,\s*\{[\s\S]*isStreaming:\s*false[\s\S]*\}\)[\s\S]*const shouldRequestFinalFollowUpQuestions =[\s\S]*shouldRequestFollowUpQuestions\(accumulator\)[\s\S]*requestKind:\s*"final"/,
    "Expected final follow-up generation to start only after the assistant stream is finalized."
  )
})

test("follow-up backfill retries are retriggered after transient misses", async () => {
  const source = await readFile(
    path.join(cwd, "src/components/agent/home/use-agent-session.ts"),
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
