"use client"

import { createContext, type ReactNode, useContext } from "react"

import { type ModelInfo } from "@/lib/shared"

const ModelsContext = createContext<ModelInfo[]>([])

export function ModelsProvider({
  models,
  children,
}: {
  models: ModelInfo[]
  children: ReactNode
}) {
  return (
    <ModelsContext.Provider value={models}>{children}</ModelsContext.Provider>
  )
}

// The available-model list is static server configuration (it only changes with
// server env / configured keys), so it is resolved once on the server and read
// from context here — no client refetching needed.
export function useModels(): { data: ModelInfo[] } {
  return { data: useContext(ModelsContext) }
}
