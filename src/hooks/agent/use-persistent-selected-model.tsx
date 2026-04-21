"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_SELECTOR_UPDATED_EVENT,
} from "@/lib/constants"
import { type ModelInfo, type ModelType } from "@/lib/shared"

import {
  parseStoredSelectedModel,
  resolvePersistedSelectedModel,
} from "./persistent-selected-model-utils"

function readStoredSelectedModel(): ModelType | null {
  if (typeof window === "undefined") {
    return null
  }

  const value = window.localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY)
  return parseStoredSelectedModel(value)
}

function writeStoredSelectedModel(model: ModelType | null) {
  if (typeof window === "undefined") {
    return
  }

  if (model) {
    window.localStorage.setItem(MODEL_SELECTOR_STORAGE_KEY, model)
  } else {
    window.localStorage.removeItem(MODEL_SELECTOR_STORAGE_KEY)
  }

  window.dispatchEvent(new CustomEvent(MODEL_SELECTOR_UPDATED_EVENT))
}

export function usePersistentSelectedModel(
  initialSelectedModel: ModelType | null | undefined,
  availableModels: ModelInfo[]
) {
  const availableModelIds = useMemo(
    () => new Set(availableModels.map((model) => model.id)),
    [availableModels]
  )

  const fallbackModel = resolvePersistedSelectedModel({
    storedModel: null,
    currentModel: null,
    initialSelectedModel,
    availableModels,
  })

  const [selectedModel, setSelectedModel] = useState<ModelType | null>(
    initialSelectedModel ?? null
  )

  useEffect(() => {
    const syncSelectedModel = () => {
      const storedModel = readStoredSelectedModel()
      const nextSelectedModel = resolvePersistedSelectedModel({
        storedModel,
        currentModel: selectedModel,
        initialSelectedModel,
        availableModels,
      })

      if (nextSelectedModel === selectedModel) {
        return
      }

      setSelectedModel(nextSelectedModel)
      writeStoredSelectedModel(nextSelectedModel)
    }

    syncSelectedModel()

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== MODEL_SELECTOR_STORAGE_KEY) {
        return
      }

      syncSelectedModel()
    }

    const handleModelUpdate = () => {
      syncSelectedModel()
    }

    window.addEventListener("storage", handleStorage)
    window.addEventListener(MODEL_SELECTOR_UPDATED_EVENT, handleModelUpdate)

    return () => {
      window.removeEventListener("storage", handleStorage)
      window.removeEventListener(
        MODEL_SELECTOR_UPDATED_EVENT,
        handleModelUpdate
      )
    }
  }, [availableModels, fallbackModel, initialSelectedModel, selectedModel])

  const persistSelectedModel = useCallback((model: ModelType | null) => {
    setSelectedModel(model)
    writeStoredSelectedModel(model)
  }, [])

  const resolvedSelectedModel =
    selectedModel && availableModelIds.has(selectedModel)
      ? selectedModel
      : fallbackModel

  return {
    selectedModel: resolvedSelectedModel,
    setSelectedModel: persistSelectedModel,
  }
}
