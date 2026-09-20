import React, { memo, useCallback, useEffect, useRef } from 'react'
import RichEditor from './RichEditor'
import { Grip } from './Icons'
import type { Cell, Settings } from '../types'

interface Props {
  cell: Cell
  settings: Settings
  tool: string
  selected: boolean
  editing: boolean
  onSelect(e: React.MouseEvent): void
  onStartEdit(): void
  onDragStart(e: React.PointerEvent): void
  onResizeStart(e: React.PointerEvent, dir: string): void
  onChange(patch: Partial<Cell>): void
  onContextMenu(e: React.MouseEvent): void
  onDeleteSelf(): void
}

function CellViewInner({
  cell,
  settings,
  tool,
  selected,
  editing,
  onSelect,
  onStartEdit,
  onDragStart,
  onResizeStart,
  onChange,
  onContextMenu,
  onDeleteSelf,
}: Props) {
  const titleRef = useRef<HTMLInputElement>(null)

  // A brand new cell starts with the cursor in its title, like OneNote.
  useEffect(() => {
    if (editing && !cell.title && !cell.html && cell.showTitle) titleRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const handleSize = useCallback(
    (contentW: number, contentH: number) => {
      if (cell.collapsed) return
      
      const patch: Partial<Cell> = {}
      
      // Auto-grow cell width if content is wider than the cell
      const chromeW = settings.cellPadding * 2
      const wantedW = Math.max(cell.w, Math.round(contentW + chromeW))
      
      if (wantedW > cell.w && Math.abs(wantedW - cell.w) > 2) {
        patch.w = wantedW
      }

      const chromeH = 14 + settings.cellPadding * 2 + (cell.showTitle ? settings.titleSize * 1.5 + 4 : 0)
      const wantedH = Math.max(60, Math.round(contentH + chromeH))
      
      if (cell.autoHeight) {
        if (Math.abs(wantedH - cell.h) > 2) {
          patch.h = wantedH
        }
      } else if (wantedH > cell.h && Math.abs(wantedH - cell.h) > 2) {
        // Even if autoHeight is disabled (e.g. manually resized),
        // we must always increase vertical size to fit new content (like pastes)
        patch.h = wantedH
      }
      
      if (Object.keys(patch).length > 0) {
        onChange(patch)
      }
    },
    [cell.autoHeight, cell.collapsed, cell.w, cell.h, cell.showTitle, settings.cellPadding, settings.titleSize, onChange],
  )

  const height = cell.collapsed ? 14 + settings.titleSize * 1.7 : cell.h
  const isDrawing = tool === 'pen' || tool === 'highlighter' || tool === 'eraser'

  return (
    <div
      className={[
        'cell',
        selected ? 'selected' : '',
        editing ? 'editing' : '',
        settings.cellBorder ? 'bordered' : '',
      ].join(' ')}
      style={{
        left: cell.x,
        top: cell.y,
        width: cell.w,
        height,
        zIndex: cell.z,
        background: cell.bg || settings.cellBg || undefined,
        borderColor: cell.border || undefined,
        // @ts-expect-error custom property
        '--cell-radius': `${settings.cellRadius}px`,
      }}
      onMouseDown={isDrawing ? undefined : onSelect}
      onContextMenu={onContextMenu}
      data-cell-id={cell.id}
    >
      <div className="cell-grip" onPointerDown={onDragStart} title="Drag to move. Double click to collapse."
           onDoubleClick={() => onChange({ collapsed: !cell.collapsed })}>
        <Grip size={18} />
      </div>

      <div className="cell-body" style={{ padding: `0 ${settings.cellPadding}px ${settings.cellPadding}px`, pointerEvents: isDrawing ? 'none' : 'auto' }}>
        {cell.strokes && cell.strokes.length > 0 && (
          <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0, overflow: 'visible' }}>
            {cell.strokes.map((s, i) => {
              const pts = []
              for (let j = 0; j < s.points.length; j += 2) pts.push(`${s.points[j]},${s.points[j + 1]}`)
              return (
                <polyline
                  key={i}
                  points={pts.join(' ')}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.size}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={s.size > 10 ? 0.38 : 1}
                />
              )
            })}
          </svg>
        )}
        {cell.showTitle && (
          <input
            ref={titleRef}
            className="cell-title"
            value={cell.title}
            placeholder="Title"
            spellCheck={settings.spellcheck}
            style={{ fontSize: settings.titleSize, color: settings.titleColor, lineHeight: 1.3 }}
            onChange={(e) => onChange({ title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const pm = (e.currentTarget.closest('.cell') as HTMLElement)?.querySelector('.ProseMirror') as HTMLElement
                pm?.focus()
              }
            }}
          />
        )}

        {!cell.collapsed && (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: cell.autoHeight ? 'hidden' : 'auto',
              fontSize: settings.bodySize,
              lineHeight: settings.lineHeight,
              color: settings.bodyColor,
            }}
            onDoubleClick={onStartEdit}
          >
            <RichEditor
              html={cell.html}
              spellcheck={settings.spellcheck}
              onChange={(html) => onChange({ html })}
              onSize={handleSize}
              onFocus={onStartEdit}
              onPaste={() => {
                if (!cell.autoHeight) onChange({ autoHeight: true })
              }}
              onEmptyBackspace={() => {
                if (!cell.title) onDeleteSelf()
              }}
            />
          </div>
        )}
      </div>

      {!cell.locked && (
        <>
          <div className="cell-handle n" onPointerDown={(e) => onResizeStart(e, 'n')} />
          <div className="cell-handle s" onPointerDown={(e) => onResizeStart(e, 's')} />
          <div className="cell-handle e" onPointerDown={(e) => onResizeStart(e, 'e')} />
          <div className="cell-handle w" onPointerDown={(e) => onResizeStart(e, 'w')} />
          <div className="cell-handle se" onPointerDown={(e) => onResizeStart(e, 'se')} />
        </>
      )}
    </div>
  )
}

export default memo(CellViewInner)
