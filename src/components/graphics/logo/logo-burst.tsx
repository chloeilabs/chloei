"use client"

import "./logo-animation.css"

import { AnimatedLogo, type LogoSize } from "./logo-animated"
import { CleoLogoBurstSvg } from "./logo-burst-svg"
import { CleoLogoSvg } from "./logo-svg"

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
        <CleoLogoBurstSvg className={logoClassName} />
      )}
      renderStaticLogo={(logoClassName) => (
        <CleoLogoSvg className={logoClassName} />
      )}
    />
  )
}
