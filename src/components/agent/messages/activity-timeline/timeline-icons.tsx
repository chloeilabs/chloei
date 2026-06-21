/**
 * Inline SVG icons that replicate the @opal/icons Onyx uses in its agent
 * timeline (circle / globe / fold / expand). Kept as local components so the
 * timeline stays visually faithful without pulling in the Onyx icon set.
 */

interface TimelineIconProps {
  className?: string
}

export function TimelineCircleIcon({ className }: TimelineIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <circle cx="8" cy="8" r="4" strokeWidth={1.5} />
    </svg>
  )
}

export function TimelineGlobeIcon({ className }: TimelineIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M14.6667 8C14.6667 11.6819 11.6819 14.6667 8 14.6667M14.6667 8C14.6667 4.3181 11.6819 1.33333 8 1.33333M14.6667 8H1.33334M8 14.6667C4.31811 14.6667 1.33334 11.6819 1.33334 8M8 14.6667C9.66753 12.8411 10.6152 10.472 10.6667 8C10.6152 5.52802 9.66753 3.1589 8 1.33333M8 14.6667C6.33249 12.8411 5.38484 10.472 5.33334 8C5.38484 5.52802 6.33249 3.1589 8 1.33333M1.33334 8C1.33334 4.3181 4.31811 1.33333 8 1.33333"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TimelineFoldIcon({ className }: TimelineIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M11 3.25L8.47136 5.77857C8.21103 6.0389 7.78889 6.0389 7.52856 5.77857L4.99999 3.25M11 12.75L8.47136 10.2214C8.21103 9.96103 7.78889 9.96103 7.52856 10.2214L4.99999 12.75"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function TimelineExpandIcon({ className }: TimelineIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M4.99994 5.49995L7.52858 2.97131C7.78891 2.71098 8.21105 2.71098 8.47138 2.97131L11 5.49995M5.00024 10.5L7.5288 13.0286C7.78914 13.2889 8.21127 13.2889 8.4716 13.0286L11.0002 10.5"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
