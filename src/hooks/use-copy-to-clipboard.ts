import { useCallback, useEffect, useRef, useState } from "react"

export function useCopyToClipboard() {
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)

      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current)
      }

      timeoutRef.current = window.setTimeout(() => {
        setIsCopied(false)
        timeoutRef.current = null
      }, 3000)

      return true
    } catch (error) {
      console.error("Failed to copy to clipboard:", error)
      return false
    }
  }, [])

  return { copyToClipboard, isCopied }
}
