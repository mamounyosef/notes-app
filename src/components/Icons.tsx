/** Small inline SVG icon set (no icon-font dependency, crisp at any zoom). */
import React from 'react'

type P = { size?: number; className?: string }
const s = (p: P) => ({
  width: p.size ?? 16,
  height: p.size ?? 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: p.className,
})

export const Chevron = (p: P) => (<svg {...s(p)}><path d="M9 6l6 6-6 6" /></svg>)
export const Eye = (p: P) => (<svg {...s(p)}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>)
export const Bolt = (p: P) => (<svg {...s(p)}><path d="M13 2L4 14h7l-1 8 9-12h-7z" /></svg>)
export const QueueI = (p: P) => (<svg {...s(p)}><path d="M4 6h11M4 11h11M4 16h7M17 13v7M14 17l3 3 3-3" /></svg>)
export const Play = (p: P) => (<svg {...s(p)}><path d="M7 5l12 7-12 7z" /></svg>)
export const Clock = (p: P) => (<svg {...s(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>)
export const ArrowLeft =(p: P) => (<svg {...s(p)}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>)
export const ArrowRight = (p: P) => (<svg {...s(p)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>)
export const Plus = (p: P) => (<svg {...s(p)}><path d="M12 5v14M5 12h14" /></svg>)
export const Book = (p: P) => (<svg {...s(p)}><path d="M4 5.5A2.5 2.5 0 016.5 3H20v16H6.5A2.5 2.5 0 004 21.5z" /></svg>)
export const Folder = (p: P) => (<svg {...s(p)}><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></svg>)
export const File = (p: P) => (<svg {...s(p)}><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" /><path d="M14 3v5h5" /></svg>)
export const Search = (p: P) => (<svg {...s(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.2-3.2" /></svg>)
export const Gear = (p: P) => (<svg {...s(p)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.6 1.6 0 008 19.4a1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H2a2 2 0 110-4h.1A1.6 1.6 0 004.6 8a1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V2a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H22a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" /></svg>)
export const Trash = (p: P) => (<svg {...s(p)}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>)
export const Copy = (p: P) => (<svg {...s(p)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" /></svg>)
export const Grip = (p: P) => (<svg {...s(p)} viewBox="0 0 24 8"><circle cx="8" cy="4" r="1" fill="currentColor" /><circle cx="12" cy="4" r="1" fill="currentColor" /><circle cx="16" cy="4" r="1" fill="currentColor" /></svg>)
export const Bold = (p: P) => (<svg {...s(p)}><path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z" /></svg>)
export const Italic = (p: P) => (<svg {...s(p)}><path d="M14 5h-4M14 19h-4M15 5l-4 14" /></svg>)
export const UnderlineI = (p: P) => (<svg {...s(p)}><path d="M7 4v6a5 5 0 0010 0V4M5 20h14" /></svg>)
export const StrikeI = (p: P) => (<svg {...s(p)}><path d="M5 12h14M8 8a4 4 0 018-1M8 16a4 4 0 008 1" /></svg>)
export const ListUl = (p: P) => (<svg {...s(p)}><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1.2" fill="currentColor" /><circle cx="4.5" cy="12" r="1.2" fill="currentColor" /><circle cx="4.5" cy="18" r="1.2" fill="currentColor" /></svg>)
export const ListOl = (p: P) => (<svg {...s(p)}><path d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 15h2v1H4v2h2" /></svg>)
export const Check = (p: P) => (<svg {...s(p)}><path d="M4 12l5 5L20 6" /></svg>)
export const AlignLeft = (p: P) => (<svg {...s(p)}><path d="M4 6h16M4 12h10M4 18h14" /></svg>)
export const AlignCenter = (p: P) => (<svg {...s(p)}><path d="M4 6h16M7 12h10M5 18h14" /></svg>)
export const AlignRight = (p: P) => (<svg {...s(p)}><path d="M4 6h16M10 12h10M6 18h14" /></svg>)
export const AlignJustify = (p: P) => (<svg {...s(p)}><path d="M4 6h16M4 12h16M4 18h16" /></svg>)
export const Palette = (p: P) => (<svg {...s(p)}><path d="M12 3a9 9 0 100 18c1.1 0 1.6-.9 1.2-1.7-.5-1 .2-2.3 1.4-2.3H17a4 4 0 004-4c0-5.5-4-10-9-10z" /><circle cx="7.5" cy="12" r="1" fill="currentColor" /><circle cx="10" cy="8" r="1" fill="currentColor" /><circle cx="15" cy="8.5" r="1" fill="currentColor" /></svg>)
export const Highlighter = (p: P) => (<svg {...s(p)}><path d="M14 4l6 6-8 8H8l-2-2z" /><path d="M4 20h7" /></svg>)
export const TableI = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16M15 4v16" /></svg>)
export const ImageI = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="M21 16l-5-5-9 9" /></svg>)
export const LinkI = (p: P) => (<svg {...s(p)}><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1" /><path d="M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></svg>)
export const CodeI = (p: P) => (<svg {...s(p)}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></svg>)
export const Sigma = (p: P) => (<svg {...s(p)}><path d="M18 5H7l6 7-6 7h11" /></svg>)
export const Quote = (p: P) => (<svg {...s(p)}><path d="M7 7h4v5c0 2.5-1.5 4.2-4 5M15 7h4v5c0 2.5-1.5 4.2-4 5" /></svg>)
export const ColumnsI = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" strokeWidth="3" /></svg>)
export const Hr = (p: P) => (<svg {...s(p)}><path d="M3 12h18" /><path d="M6 7h12M6 17h12" opacity=".4" /></svg>)
export const Undo = (p: P) => (<svg {...s(p)}><path d="M9 14l-5-5 5-5" /><path d="M4 9h9a6 6 0 010 12H8" /></svg>)
export const Redo = (p: P) => (<svg {...s(p)}><path d="M15 14l5-5-5-5" /><path d="M20 9h-9a6 6 0 100 12h5" /></svg>)
export const Pen = (p: P) => (<svg {...s(p)}><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>)
export const Eraser = (p: P) => (<svg {...s(p)}><path d="M16 3l5 5-9 9H7l-4-4z" /><path d="M21 20H9" /></svg>)
export const Cursor = (p: P) => (<svg {...s(p)}><path d="M5 3l14 8-6 1.5L10 19z" /></svg>)
export const SpaceI = (p: P) => (<svg {...s(p)}><path d="M12 3v7M12 14v7M8 6l4-4 4 4M8 18l4 4 4-4" /><path d="M3 12h18" opacity=".5" /></svg>)
export const Star = (p: P) => (<svg {...s(p)}><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 17l-5.3 2.7 1.1-5.9L3.5 9.7l5.9-.8z" /></svg>)
export const PanelLeft = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>)
export const PanelMid = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /></svg>)
export const X = (p: P) => (<svg {...s(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>)
export const Min = (p: P) => (<svg {...s(p)}><path d="M5 12h14" /></svg>)
export const Max = (p: P) => (<svg {...s(p)}><rect x="5" y="5" width="14" height="14" rx="2" /></svg>)
export const ZoomIn = (p: P) => (<svg {...s(p)}><path d="M12 6v12M6 12h12" /></svg>)
export const ZoomOut = (p: P) => (<svg {...s(p)}><path d="M6 12h12" /></svg>)
export const RotateI = (p: P) => (<svg {...s(p)}><path d="M20 11a8 8 0 10-2.3 5.7" /><path d="M20 4v7h-7" /></svg>)
export const FitI = (p: P) => (<svg {...s(p)}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>)
export const Layers = (p: P) => (<svg {...s(p)}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>)
export const Download = (p: P) => (<svg {...s(p)}><path d="M12 3v12M7 11l5 5 5-5M4 21h16" /></svg>)
export const Sun = (p: P) => (<svg {...s(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>)
export const Moon = (p: P) => (<svg {...s(p)}><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" /></svg>)

export const SyncI = (p: P) => (<svg {...s(p)}><path d="M20 11a8 8 0 00-14.3-4.9L4 8M4 4v4h4" /><path d="M4 13a8 8 0 0014.3 4.9L20 16M20 20v-4h-4" /></svg>)
export const Archive = (p: P) => (<svg {...s(p)}><polyline points="21 8 21 21 3 21 3 8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" /></svg>)
export const SidebarPeek = (p: P) => (
  <svg {...s(p)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 4v16" strokeDasharray="2 2" />
    <path d="M12 12h4m-2-2l2 2-2 2" />
  </svg>
)

export const ArtifactI = (p: P) => (
  <svg {...s(p)}>
    <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
    <line x1="12" y1="22.08" x2="12" y2="12" />
  </svg>
)

/** The assistant's mark: a glowing orb in the accent color. */
export const AssistantMark = (p: P) => {
  const id = React.useId().replace(/:/g, '')
  const size = p.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" className={p.className} aria-hidden="true">
      <defs>
        <radialGradient id={`am${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#fff" />
          <stop offset=".25" style={{ stopColor: 'color-mix(in srgb, var(--accent) 45%, #fff)' }} />
          <stop offset=".7" style={{ stopColor: 'var(--accent)', stopOpacity: 0.9 }} />
          <stop offset="1" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <circle cx="13" cy="13" r="12.5" fill={`url(#am${id})`} />
    </svg>
  )
}
export const Send = (p: P) => (<svg {...s(p)}><path d="M12 19V5M5 12l7-7 7 7" /></svg>)
export const StopI = (p: P) => (<svg {...s(p)}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>)
export const Mic = (p: P) => (<svg {...s(p)}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></svg>)
export const Clip = (p: P) => (<svg {...s(p)}><path d="M21 11.5l-8.5 8.5a5 5 0 01-7-7L14 4.5a3.4 3.4 0 014.8 4.8L10.3 17.8a1.7 1.7 0 01-2.4-2.4L15.5 8" /></svg>)
export const History = (p: P) => (<svg {...s(p)}><path d="M3 12a9 9 0 103-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 3" /></svg>)
export const Dock = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>)
export const Float = (p: P) => (<svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="12" y="8" width="6" height="8" rx="1" /></svg>)
export const Brain = (p: P) => (<svg {...s(p)}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 00-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0012 3z" /></svg>)
export const AtI = (p: P) => (<svg {...s(p)}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-4 8" /></svg>)
export const Retry = (p: P) => (<svg {...s(p)}><path d="M21 12a9 9 0 11-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>)
export const Pencil = (p: P) => (<svg {...s(p)}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>)
/* Voice mode */
export const Gauge = (p: P) => (<svg {...s(p)}><path d="M4 18a8 8 0 1116 0" /><path d="M12 14l4-5" /><circle cx="12" cy="14" r="1.3" fill="currentColor" /></svg>)
export const AudioLines = (p: P) => (<svg {...s(p)}><path d="M3 10v4M7.5 6v12M12 3v18M16.5 8v8M21 10v4" /></svg>)
export const MicOff = (p: P) => (<svg {...s(p)}><path d="M9 5a3 3 0 016 0v5M15 13.5A3 3 0 019 11v-1M5 11a7 7 0 0011.5 5.4M19 11a7 7 0 01-.6 2.8M12 18v3M3 3l18 18" /></svg>)
export const PhoneOff = (p: P) => (<svg {...s(p)}><path d="M3.5 13.5c4.7-4 12.3-4 17 0l-1.6 2.8a1 1 0 01-1.2.4l-3-1.1a1 1 0 01-.6-.9v-2a12.5 12.5 0 00-4.2 0v2a1 1 0 01-.6.9l-3 1.1a1 1 0 01-1.2-.4z" /></svg>)
