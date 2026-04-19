"use client"

import "./logo-animation.css"

import { AnimatedLogo, type LogoSize } from "./logo-animated"
import { ChloeiLogoBurstSvg } from "./logo-burst-svg"
import { ChloeiLogoSvg } from "./logo-svg"

export function LogoBurst({
  forceAnimate,
  size = "md",
  className,
}: {
  forceAnimate?: boolean
  size?: LogoSize
  className?: string
}) {
  return (
    <AnimatedLogo
      className={className}
      forceAnimate={forceAnimate}
      size={size}
      renderAnimatedLogo={(logoClassName) => (
        <ChloeiLogoBurstSvg className={logoClassName} />
      )}
      renderStaticLogo={(logoClassName) => (
        <ChloeiLogoSvg className={logoClassName} />
      )}
    />
  )
}
