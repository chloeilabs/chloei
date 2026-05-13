"use client"

export function RouteGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="chloei-desktop-shell relative flex size-full h-svh flex-col items-center overflow-hidden bg-background">
      <div aria-hidden="true" className="chloei-desktop-titlebar">
        Chloei
      </div>
      {children}
    </div>
  )
}
