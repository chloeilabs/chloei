"use client"

import "./logo-animation.css"

import { AnimatedLogo, type LogoSize } from "./logo-animated"
import { CleoLogoHoverSvg } from "./logo-hover-svg"
import { CleoLogoSvg } from "./logo-svg"

export function LogoHover({
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
        <CleoLogoHoverSvg className={logoClassName} />
      )}
      renderStaticLogo={(logoClassName) => (
        <CleoLogoSvg className={logoClassName} />
      )}
    />
  )
}
