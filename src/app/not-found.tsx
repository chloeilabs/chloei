import Link from "next/link"

import { ChloeiLogoSvg } from "@/components/graphics/logo/logo-svg"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function NotFound() {
  return (
    <div className="flex grow flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-4 font-departureMono text-3xl font-medium tracking-tighter">
        <span className="block size-[25px] shrink-0 overflow-hidden">
          <ChloeiLogoSvg />
        </span>
        Page Not Found
      </div>
      <Link
        href="/"
        className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
      >
        Go To Home
      </Link>
    </div>
  )
}
