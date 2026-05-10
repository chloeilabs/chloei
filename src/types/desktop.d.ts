export {}

declare global {
  interface Window {
    chloeiDesktop?: {
      isDesktop: true
      platform: NodeJS.Platform
      version: string
    }
  }
}
