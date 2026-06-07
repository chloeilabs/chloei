"use client"

import { CandlestickChartIcon } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function TradingDeskNavButton({ className }: { className?: string }) {
  const pathname = usePathname()
  const isCurrent = pathname === "/trading-desk"
  const buttonClassName = cn(
    "text-muted-foreground hover:text-foreground",
    isCurrent && "cursor-default bg-muted text-foreground",
    className
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {isCurrent ? (
          <Button
            aria-current="page"
            aria-label="Trading desk"
            className={buttonClassName}
            size="iconSm"
            type="button"
            variant="ghost"
          >
            <CandlestickChartIcon />
          </Button>
        ) : (
          <Button
            aria-label="Trading desk"
            asChild
            className={buttonClassName}
            size="iconSm"
            variant="ghost"
          >
            <Link href="/trading-desk">
              <CandlestickChartIcon />
            </Link>
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent align="end" side="bottom">
        Trading desk
      </TooltipContent>
    </Tooltip>
  )
}
