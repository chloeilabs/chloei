import { useQuery } from "@tanstack/react-query"

import { redirectToSignIn } from "@/lib/auth-client"
import {
  createHttpErrorFromResponse,
  type HttpError,
} from "@/lib/http-error"
import { createRequestHeaders } from "@/lib/request-id"
import { type ModelInfo } from "@/lib/shared"

function isModelInfo(value: unknown): value is ModelInfo {
  if (typeof value !== "object" || value === null) {
    return false
  }

  const candidate = value as { id?: unknown; name?: unknown }
  return typeof candidate.id === "string" && typeof candidate.name === "string"
}

function isModelInfoArray(value: unknown): value is ModelInfo[] {
  return Array.isArray(value) && value.every(isModelInfo)
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: async (): Promise<ModelInfo[]> => {
      const response = await fetch("/api/models", {
        headers: createRequestHeaders(),
      })

      if (response.status === 401) {
        redirectToSignIn()
        throw await createHttpErrorFromResponse(response, "Unauthorized.")
      }

      if (!response.ok) {
        throw await createHttpErrorFromResponse(
          response,
          "Failed to fetch models."
        )
      }

      const data: unknown = await response.json()
      if (!isModelInfoArray(data)) {
        throw new Error("Invalid model response.")
      }
      return data
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: (failureCount, error) =>
      (error as HttpError).status !== 401 && failureCount < 2,
  })
}
