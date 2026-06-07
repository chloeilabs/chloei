"use client"

import { createContext, type ReactNode, useContext } from "react"

import { useThreadStore } from "./use-thread-store"

type ThreadStore = ReturnType<typeof useThreadStore>

const ThreadStoreContext = createContext<ThreadStore | null>(null)

export function ThreadStoreProvider({ children }: { children: ReactNode }) {
  const threadStore = useThreadStore()

  return (
    <ThreadStoreContext.Provider value={threadStore}>
      {children}
    </ThreadStoreContext.Provider>
  )
}

export function useThreadStoreContext() {
  const threadStore = useContext(ThreadStoreContext)

  if (!threadStore) {
    throw new Error(
      "useThreadStoreContext must be used within ThreadStoreProvider."
    )
  }

  return threadStore
}
