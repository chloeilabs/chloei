"use client"

export function RouteGroupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex size-full h-svh flex-col items-center overflow-hidden">
      {children}
    </div>
  )
}
