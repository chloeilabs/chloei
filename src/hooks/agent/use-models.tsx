import { useQuery } from "@tanstack/react-query"

import { redirectToSignIn } from "@/lib/auth-client"
import { type ModelInfo } from "@/lib/shared"

type HttpError = Error & { status?: number }

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

function createHttpError(status: number, message: string): HttpError {
  const error = new Error(message) as HttpError
  error.status = status
  return error
}

export function useModels() {
  return useQuery({
    queryKey: ["models"],
    queryFn: async (): Promise<ModelInfo[]> => {
      const response = await fetch("/api/models")

      if (response.status === 401) {
        redirectToSignIn()
        throw createHttpError(401, "Unauthorized.")
      }

      if (!response.ok) {
        throw createHttpError(
          response.status,
          `HTTP error! status: ${String(response.status)}`
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
