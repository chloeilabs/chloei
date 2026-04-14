import Link from "next/link"

import { LogoHover } from "@/components/graphics/logo/logo-hover"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex grow flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-4 font-departureMono text-3xl font-medium tracking-tighter">
        <LogoHover size="lg" />
        Page Not Found
      </div>
      <Button variant="secondary" size="lg" asChild>
        <Link href="/">Go To Home</Link>
      </Button>
    </div>
  )
}
