"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

import {
  MODEL_SELECTOR_STORAGE_KEY,
  MODEL_SELECTOR_UPDATED_EVENT,
} from "@/lib/constants"
import { isModelType, type ModelInfo, type ModelType } from "@/lib/shared"

function readStoredSelectedModel(): ModelType | null {
  if (typeof window === "undefined") {
    return null
  }

  const value = window.localStorage.getItem(MODEL_SELECTOR_STORAGE_KEY)
  return isModelType(value) ? value : null
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

  const fallbackModel =
    initialSelectedModel && availableModelIds.has(initialSelectedModel)
      ? initialSelectedModel
      : (availableModels[0]?.id ?? null)

  const [selectedModel, setSelectedModel] = useState<ModelType | null>(
    initialSelectedModel ?? null
  )

  useEffect(() => {
    const syncSelectedModel = () => {
      const storedModel = readStoredSelectedModel()

      if (storedModel && availableModelIds.has(storedModel)) {
        setSelectedModel(storedModel)
        return
      }

      setSelectedModel((currentModel) => {
        if (currentModel && availableModelIds.has(currentModel)) {
          return currentModel
        }

        return fallbackModel
      })

      writeStoredSelectedModel(fallbackModel)
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
  }, [availableModelIds, fallbackModel])

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
