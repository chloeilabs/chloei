"use client"

import type { AgentRequestAttachment } from "@/lib/shared"

const DB_NAME = "chloei-attachments"
const STORE_NAME = "attachments"
const THREAD_INDEX = "by-thread"
const DB_VERSION = 1

interface AttachmentRecord {
  threadId: string
  messageId: string
  attachmentId: string
  attachment: AgentRequestAttachment
}

function isClient(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: ["threadId", "messageId", "attachmentId"],
        })
        store.createIndex(THREAD_INDEX, "threadId")
      }
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed."))
    }
  }).catch((error: unknown) => {
    dbPromise = null
    throw error
  })

  return dbPromise
}

function awaitTx(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error("IndexedDB transaction failed."))
    }
    tx.onabort = () => {
      reject(tx.error ?? new Error("IndexedDB transaction aborted."))
    }
  })
}

export async function persistMessageAttachments(
  threadId: string,
  messageId: string,
  attachments: readonly AgentRequestAttachment[]
): Promise<void> {
  if (!isClient() || attachments.length === 0) return

  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)

    for (const attachment of attachments) {
      const record: AttachmentRecord = {
        threadId,
        messageId,
        attachmentId: attachment.id,
        attachment,
      }
      store.put(record)
    }

    await awaitTx(tx)
  } catch {
    // best-effort: in-memory state still works without persistence
  }
}

export async function loadThreadAttachmentPayloads(
  threadId: string
): Promise<Map<string, AgentRequestAttachment[]>> {
  const result = new Map<string, AgentRequestAttachment[]>()
  if (!isClient()) return result

  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, "readonly")
    const index = tx.objectStore(STORE_NAME).index(THREAD_INDEX)
    const records: AttachmentRecord[] = []

    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openCursor(IDBKeyRange.only(threadId))
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          records.push(cursor.value as AttachmentRecord)
          cursor.continue()
        } else {
          resolve()
        }
      }
      cursorReq.onerror = () => {
        reject(cursorReq.error ?? new Error("IndexedDB cursor failed."))
      }
    })
    await awaitTx(tx)

    for (const record of records) {
      const list = result.get(record.messageId) ?? []
      list.push(record.attachment)
      result.set(record.messageId, list)
    }

    return result
  } catch {
    return result
  }
}

export async function deleteThreadAttachments(threadId: string): Promise<void> {
  if (!isClient()) return

  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const index = tx.objectStore(STORE_NAME).index(THREAD_INDEX)

    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openCursor(IDBKeyRange.only(threadId))
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          cursor.delete()
          cursor.continue()
        } else {
          resolve()
        }
      }
      cursorReq.onerror = () => {
        reject(cursorReq.error ?? new Error("IndexedDB cursor failed."))
      }
    })
    await awaitTx(tx)
  } catch {
    // best-effort
  }
}

export async function pruneThreadAttachmentsToMessages(
  threadId: string,
  validMessageIds: ReadonlySet<string>
): Promise<void> {
  if (!isClient()) return

  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const index = tx.objectStore(STORE_NAME).index(THREAD_INDEX)

    await new Promise<void>((resolve, reject) => {
      const cursorReq = index.openCursor(IDBKeyRange.only(threadId))
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor) {
          const record = cursor.value as AttachmentRecord
          if (!validMessageIds.has(record.messageId)) {
            cursor.delete()
          }
          cursor.continue()
        } else {
          resolve()
        }
      }
      cursorReq.onerror = () => {
        reject(cursorReq.error ?? new Error("IndexedDB cursor failed."))
      }
    })
    await awaitTx(tx)
  } catch {
    // best-effort
  }
}
