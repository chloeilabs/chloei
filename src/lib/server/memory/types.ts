export interface MemoryRecord {
  id: string
  fact: string
  createdAt: Date
  updatedAt: Date
  similarity?: number
}

export interface MemorySearchResult {
  records: MemoryRecord[]
}

export interface MemoryExtractionInput {
  userMessage: string
  assistantMessage?: string
}

export interface MemoryRuntimeContext {
  userId: string
  aiGatewayApiKey: string
}
