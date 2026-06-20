import Link from "next/link"

import { ChloeiLogoSvg } from "@/components/graphics/logo/logo-svg"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

export default function NotFound() {
  return (
    <Empty className="grow">
      <EmptyHeader>
        <EmptyMedia variant="default">
          <span className="block size-10 shrink-0 overflow-hidden">
            <ChloeiLogoSvg />
          </span>
        </EmptyMedia>
        <EmptyTitle>Page Not Found</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Link
          href="/"
          className={cn(buttonVariants({ variant: "secondary", size: "lg" }))}
        >
          Go To Home
        </Link>
      </EmptyContent>
    </Empty>
  )
}
