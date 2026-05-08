import * as React from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`

function getMobileSnapshot() {
  return (
    typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches
  )
}

function getServerMobileSnapshot() {
  return false
}

function subscribeToMobileChanges(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => undefined
  }

  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onStoreChange)
  return () => {
    mql.removeEventListener("change", onStoreChange)
  }
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribeToMobileChanges,
    getMobileSnapshot,
    getServerMobileSnapshot
  )
}
