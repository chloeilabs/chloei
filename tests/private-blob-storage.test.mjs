import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/private-blob-storage.ts")
).href

const {
  buildAuthenticatedPrivateBlobDownloadUrl,
  buildPrivateBlobAttachmentPathname,
  getPrivateBlobUserPrefix,
  isPrivateBlobConfigured,
  isUserOwnedBlobPathname,
  normalizeBlobPathname,
  readPrivateBlob,
} = await import(moduleUrl)

function expectedPrefix(userId) {
  return `users/${createHash("sha256").update(userId).digest("hex")}`
}

test("getPrivateBlobUserPrefix hashes the user id deterministically", () => {
  assert.equal(getPrivateBlobUserPrefix("user-a"), expectedPrefix("user-a"))
  assert.equal(
    getPrivateBlobUserPrefix("user-a"),
    getPrivateBlobUserPrefix("user-a")
  )
  assert.notEqual(
    getPrivateBlobUserPrefix("user-a"),
    getPrivateBlobUserPrefix("user-b")
  )
})

test("normalizeBlobPathname accepts safe relative paths", () => {
  assert.equal(
    normalizeBlobPathname("users/abc/attachments/file.pdf"),
    "users/abc/attachments/file.pdf"
  )
  assert.equal(normalizeBlobPathname("a\\b\\c.txt"), "a/b/c.txt")
  assert.equal(normalizeBlobPathname("  users/x/y.txt  "), "users/x/y.txt")
})

test("normalizeBlobPathname rejects traversal and unsafe paths", () => {
  for (const bad of [
    "",
    "   ",
    "/etc/passwd",
    "~/secrets",
    "C:/Windows",
    "a/../b",
    "a/./b",
    "a//b",
    "..",
    "a/b/..",
    "with\0null",
  ]) {
    assert.equal(
      normalizeBlobPathname(bad),
      null,
      `expected ${JSON.stringify(bad)} to be rejected`
    )
  }
})

test("isUserOwnedBlobPathname enforces per-user isolation", () => {
  const prefixA = getPrivateBlobUserPrefix("user-a")
  const ownPath = `${prefixA}/attachments/x.pdf`

  assert.equal(
    isUserOwnedBlobPathname({ pathname: ownPath, userId: "user-a" }),
    true
  )
  // Another user cannot claim ownership of the same path.
  assert.equal(
    isUserOwnedBlobPathname({ pathname: ownPath, userId: "user-b" }),
    false
  )
  // The bare prefix (no trailing slash) is not an owned file path.
  assert.equal(
    isUserOwnedBlobPathname({ pathname: prefixA, userId: "user-a" }),
    false
  )
  // Traversal that tries to climb into another user's namespace is rejected.
  assert.equal(
    isUserOwnedBlobPathname({
      pathname: `${prefixA}/../${getPrivateBlobUserPrefix("user-b")}/x`,
      userId: "user-a",
    }),
    false
  )
})

test("buildPrivateBlobAttachmentPathname namespaces under the user and sanitizes", () => {
  const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  const pathname = buildPrivateBlobAttachmentPathname({
    userId: "user-a",
    filename: "My Report (final).pdf",
    attachmentId: id,
  })

  assert.equal(
    pathname,
    `${getPrivateBlobUserPrefix("user-a")}/attachments/${id}/My-Report-final.pdf`
  )
  assert.equal(isUserOwnedBlobPathname({ pathname, userId: "user-a" }), true)
})

test("buildPrivateBlobAttachmentPathname rejects a non-UUID attachment id", () => {
  assert.throws(() =>
    buildPrivateBlobAttachmentPathname({
      userId: "user-a",
      filename: "x.pdf",
      attachmentId: "not-a-uuid",
    })
  )
})

test("buildPrivateBlobAttachmentPathname generates a UUID when none is given", () => {
  const prefix = `${getPrivateBlobUserPrefix("user-a")}/attachments/`
  const pathname = buildPrivateBlobAttachmentPathname({
    userId: "user-a",
    filename: "x.pdf",
  })

  assert.ok(pathname.startsWith(prefix))
  const generatedId = pathname.slice(prefix.length).split("/")[0]
  assert.match(
    generatedId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  )
})

test("buildAuthenticatedPrivateBlobDownloadUrl encodes segments under /api/uploads", () => {
  assert.equal(
    buildAuthenticatedPrivateBlobDownloadUrl(
      "users/abc/attachments/id/my file.pdf"
    ),
    "/api/uploads/users/abc/attachments/id/my%20file.pdf"
  )
  assert.equal(buildAuthenticatedPrivateBlobDownloadUrl("../escape"), null)
})

test("isPrivateBlobConfigured reflects the blob token env", () => {
  const saved = process.env.BLOB_READ_WRITE_TOKEN
  try {
    delete process.env.BLOB_READ_WRITE_TOKEN
    assert.equal(isPrivateBlobConfigured(), false)
    process.env.BLOB_READ_WRITE_TOKEN = "   "
    assert.equal(isPrivateBlobConfigured(), false)
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_token"
    assert.equal(isPrivateBlobConfigured(), true)
  } finally {
    if (saved === undefined) {
      delete process.env.BLOB_READ_WRITE_TOKEN
    } else {
      process.env.BLOB_READ_WRITE_TOKEN = saved
    }
  }
})

test("readPrivateBlob denies cross-user and traversal access before touching storage", async () => {
  const ownerPath = buildPrivateBlobAttachmentPathname({
    userId: "owner",
    filename: "secret.pdf",
  })

  // A different user cannot read the owner's blob.
  assert.equal(
    await readPrivateBlob({ pathname: ownerPath, userId: "intruder" }),
    null
  )
  // Traversal / invalid pathnames are rejected outright.
  assert.equal(
    await readPrivateBlob({ pathname: "../../etc/passwd", userId: "owner" }),
    null
  )
  assert.equal(
    await readPrivateBlob({
      pathname: `${getPrivateBlobUserPrefix("owner")}/../x`,
      userId: "owner",
    }),
    null
  )
})
