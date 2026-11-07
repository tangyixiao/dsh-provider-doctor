/**
 * The panel icon.
 *
 * A sidebar row is a 16px glyph and nothing else, so the mark has to read at
 * that size: a stethoscope, drawn as strokes on a 24-unit grid and scaled by
 * the slot's `size` owner prop. `currentColor` keeps it in step with the row's
 * own hover/active colour instead of hard-coding a theme colour.
 *
 * @module dsh-provider-doctor/client/icons
 */

import type { ReactNode } from 'react'

/** Props the sidebar hands one panel icon. */
export interface PanelIconProps {
  /** Edge length in CSS pixels; the sidebar supplies its own preferred size. */
  size: number
}

/**
 * Render the doctor mark.
 *
 * @param props - The sidebar's icon props.
 * @returns An inline SVG sized to the row.
 */
export function DoctorIcon({ size }: PanelIconProps): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The chest piece. */}
      <path d="M6 3v6a4 4 0 0 0 8 0V3" />
      {/* The tubing down to the bell. */}
      <path d="M10 13v3a4 4 0 0 0 8 0v-2" />
      <circle cx="18" cy="10" r="2" />
    </svg>
  )
}
