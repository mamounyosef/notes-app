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
export const ZoomIn = (p: P) => (<svg {...s(p)}><circle cx="11" cy="11" r="7" /><path d="M11 8v6M8 11h6M20 20l-3.2-3.2" /></svg>)
export const ZoomOut = (p: P) => (<svg {...s(p)}><circle cx="11" cy="11" r="7" /><path d="M8 11h6M20 20l-3.2-3.2" /></svg>)
export const Layers = (p: P) => (<svg {...s(p)}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>)
export const Download = (p: P) => (<svg {...s(p)}><path d="M12 3v12M7 11l5 5 5-5M4 21h16" /></svg>)
export const Sun = (p: P) => (<svg {...s(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>)
export const Moon = (p: P) => (<svg {...s(p)}><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" /></svg>)
