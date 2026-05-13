"use client"

import { AlertCircle, Download, RefreshCw, RotateCcw } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

function getButtonContent(state: ChloeiDesktopUpdateState) {
  switch (state.status) {
    case "available":
      return {
        icon: Download,
        label: "Downloading",
        tooltip: state.updateVersion
          ? `Downloading ${state.updateVersion}`
          : "Downloading update",
      }
    case "checking":
      return {
        icon: RefreshCw,
        label: "Checking",
        tooltip: "Checking for updates",
      }
    case "downloaded":
      return {
        icon: RotateCcw,
        label: "Restart",
        tooltip: state.updateVersion
          ? `Restart to install ${state.updateVersion}`
          : "Restart to install update",
      }
    case "downloading": {
      const percent =
        typeof state.percent === "number"
          ? `${String(Math.round(state.percent))}%`
          : "Downloading"

      return {
        icon: Download,
        label: percent,
        tooltip: state.updateVersion
          ? `Downloading ${state.updateVersion}`
          : "Downloading update",
      }
    }
    case "error":
      return {
        icon: AlertCircle,
        label: "Update",
        tooltip: state.message ?? "Unable to check for updates",
      }
    case "up-to-date":
      return {
        icon: RefreshCw,
        label: "Update",
        tooltip: "Chloei is up to date",
      }
    default:
      return {
        icon: RefreshCw,
        label: "Update",
        tooltip: "Check for updates",
      }
  }
}

export function DesktopUpdateButton() {
  const [state, setState] = useState<ChloeiDesktopUpdateState | null>(null)
  const [isClickPending, setIsClickPending] = useState(false)

  useEffect(() => {
    const desktop = window.chloeiDesktop

    if (!desktop?.updates) {
      return
    }

    let isMounted = true

    void desktop.updates.getState().then((nextState) => {
      if (isMounted) {
        setState(nextState)
      }
    })

    const unsubscribe = desktop.updates.onStateChange((nextState) => {
      setState(nextState)
    })

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [])

  const content = useMemo(() => {
    return state ? getButtonContent(state) : null
  }, [state])

  const handleClick = useCallback(() => {
    const desktop = window.chloeiDesktop

    if (!desktop?.updates || !state) {
      return
    }

    setIsClickPending(true)
    void (async () => {
      try {
        const nextState = state.canInstall
          ? await desktop.updates.install()
          : await desktop.updates.check()
        setState(nextState)
      } catch {
        setState((currentState) =>
          currentState
            ? {
                ...currentState,
                message: "Unable to contact the desktop updater.",
                status: "error",
              }
            : currentState
        )
      } finally {
        setIsClickPending(false)
      }
    })()
  }, [state])

  if (!state || !content || state.status === "unavailable") {
    return null
  }

  const Icon = content.icon
  const isBusy =
    isClickPending ||
    state.status === "available" ||
    state.status === "checking" ||
    state.status === "downloading"
  const isDisabled = isBusy || (!state.canCheck && !state.canInstall)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={state.status === "downloaded" ? "default" : "outline"}
          size="sm"
          className="h-7 w-24 px-2 text-muted-foreground hover:text-foreground"
          disabled={isDisabled}
          onClick={handleClick}
          aria-label={content.tooltip}
        >
          <Icon
            className={cn(
              "size-3.5",
              state.status === "checking" && "animate-spin"
            )}
          />
          <span className="min-w-0 truncate">{content.label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end">
        {content.tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
