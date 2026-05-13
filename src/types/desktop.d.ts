export {}

declare global {
  type ChloeiDesktopUpdateStatus =
    | "available"
    | "checking"
    | "downloaded"
    | "downloading"
    | "error"
    | "idle"
    | "unavailable"
    | "up-to-date"

  interface ChloeiDesktopUpdateState {
    canCheck: boolean
    canInstall: boolean
    channel: string
    currentVersion: string
    message: string | null
    percent: number | null
    status: ChloeiDesktopUpdateStatus
    updateVersion: string | null
  }

  interface Window {
    chloeiDesktop?: {
      isDesktop: true
      platform: NodeJS.Platform
      updates: {
        check: () => Promise<ChloeiDesktopUpdateState>
        getState: () => Promise<ChloeiDesktopUpdateState>
        install: () => Promise<ChloeiDesktopUpdateState>
        onStateChange: (
          listener: (state: ChloeiDesktopUpdateState) => void
        ) => () => void
      }
      version: string
    }
  }
}
