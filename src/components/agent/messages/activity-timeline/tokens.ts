import type { CSSProperties } from "react"

/**
 * Shared geometry for the activity timeline rail, exposed as CSS variables so
 * the layout can be themed/overridden in one place. Mirrors Onyx's timeline
 * token system (`timeline/primitives/tokens.ts`). Applied on the timeline root
 * by {@link ActivityTimeline}, then consumed by the rail primitives via Tailwind
 * arbitrary-value classes (e.g. `w-[var(--activity-rail-width)]`).
 */
export interface ActivityTimelineTokens {
  /** Width of the left rail (avatar + icon column), Onyx `--timeline-rail-width`. */
  railWidth: string
  /** Height of the header row (avatar + title), Onyx `--timeline-header-row-height`. */
  headerRowHeight: string
  /** Size of the square wrapper that centers each step icon. */
  iconWrapperSize: string
  /** Glyph size of the step icon itself. */
  iconSize: string
  /** Height of a step's header row (keeps the icon aligned to the label). */
  stepHeaderHeight: string
  /** Length of the connector segment drawn above a step icon. */
  topConnectorHeight: string
  /** Reserved right-side column on each step (Onyx collapse-controls slot). */
  rightSectionWidth: string
}

export const activityTimelineTokenDefaults: ActivityTimelineTokens = {
  railWidth: "2.25rem", // w-9 (Onyx --timeline-rail-width)
  headerRowHeight: "2.25rem", // h-9 (Onyx --timeline-header-row-height)
  iconWrapperSize: "1.25rem", // size-5 (Onyx --timeline-branch-icon-wrapper-size)
  iconSize: "0.75rem", // size-3 (Onyx --timeline-icon-size)
  stepHeaderHeight: "2rem", // h-8 (Onyx --timeline-step-header-height)
  topConnectorHeight: "0.5rem", // h-2 (Onyx --timeline-top-connector-height)
  rightSectionWidth: "2.125rem", // Onyx --timeline-step-header-right-section-width
}

/**
 * Returns the CSS custom properties for the timeline layout, merging any
 * overrides over the defaults. Spread onto the timeline root's `style`.
 */
export function getActivityTimelineStyles(
  tokens?: Partial<ActivityTimelineTokens>
): CSSProperties {
  const merged = { ...activityTimelineTokenDefaults, ...tokens }

  return {
    "--activity-rail-width": merged.railWidth,
    "--activity-header-row-height": merged.headerRowHeight,
    "--activity-icon-wrapper-size": merged.iconWrapperSize,
    "--activity-icon-size": merged.iconSize,
    "--activity-step-header-height": merged.stepHeaderHeight,
    "--activity-top-connector-height": merged.topConnectorHeight,
    "--activity-right-section-width": merged.rightSectionWidth,
  } as CSSProperties
}
