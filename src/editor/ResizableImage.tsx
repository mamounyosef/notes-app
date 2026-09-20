import React, { useRef, useState, useCallback, useEffect } from 'react'
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react'
import { Copy, Grip } from '../components/Icons'

export function ResizableImageNode(props: NodeViewProps) {
  const { node, updateAttributes, selected } = props
  const imgRef = useRef<HTMLImageElement>(null)
  const [resizing, setResizing] = useState(false)
  const [currentWidth, setCurrentWidth] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  
  useEffect(() => {
    if (!resizing && node.attrs.width) {
      setCurrentWidth(node.attrs.width)
    }
  }, [node.attrs.width, resizing])

  const onPointerDown = useCallback((e: React.PointerEvent, corner: 'tl' | 'tr' | 'bl' | 'br') => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)
    
    const startX = e.clientX
    // We measure the actual rendered width of the image to start resizing from
    const startWidth = imgRef.current?.offsetWidth || (node.attrs.width ? parseInt(node.attrs.width, 10) : 300)

    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault()
      const dx = moveEvent.clientX - startX
      // If dragging left corners (tl, bl), moving left (negative dx) INCREASES width
      // If dragging right corners (tr, br), moving right (positive dx) INCREASES width
      const delta = (corner === 'tl' || corner === 'bl') ? -dx : dx
      const newWidth = Math.max(50, startWidth + delta)
      setCurrentWidth(newWidth)
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      setResizing(false)
      const dx = upEvent.clientX - startX
      const delta = (corner === 'tl' || corner === 'bl') ? -dx : dx
      const finalWidth = Math.max(50, startWidth + delta)
      // Save the final width to the document
      updateAttributes({ width: finalWidth, height: 'auto' })
      
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }, [node.attrs.width, updateAttributes])

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const img = imgRef.current
    if (!img) return
    try {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      canvas.toBlob(async (blob) => {
        if (!blob) return
        try {
          await navigator.clipboard.write([
            new window.ClipboardItem({ [blob.type]: blob })
          ])
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        } catch (err) {
          console.error('Clipboard write failed', err)
        }
      }, 'image/png')
    } catch (err) {
      console.error('Canvas draw failed', err)
    }
  }

  const width = resizing && currentWidth ? currentWidth : node.attrs.width
  const textAlign = node.attrs.textAlign || 'left'

  let justifyContent = 'flex-start'
  if (textAlign === 'center') justifyContent = 'center'
  if (textAlign === 'right') justifyContent = 'flex-end'

  return (
    <NodeViewWrapper 
      className={`resizable-image ${selected ? 'ProseMirror-selectednode' : ''}`} 
      style={{ 
        display: 'flex', 
        justifyContent,
        position: 'relative', 
        verticalAlign: 'bottom', 
        maxWidth: '100%', 
        margin: '0.5em 0' 
      }}
    >
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <img
          ref={imgRef}
          src={node.attrs.src}
          alt={node.attrs.alt}
          title={node.attrs.title}
          draggable={false}
          style={{
            display: 'block',
            width: width ? `${width}px` : 'auto',
            height: node.attrs.height && node.attrs.height !== 'auto' ? `${node.attrs.height}px` : 'auto',
            // Maximum width should not be clamped to 100% of parent if we want it to extend the cell width.
            // By removing maxWidth: 100%, the image can be larger than the cell width, causing scrollWidth to increase!
            maxWidth: 'none', 
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />

        {selected && (
          <>
            <div
              data-drag-handle
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                zIndex: 10,
                cursor: 'grab',
                background: 'var(--surface-2, rgba(0,0,0,0.5))',
                borderRadius: 4,
                padding: '4px',
                color: 'white',
                display: 'flex',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }}
              title="Drag image"
            >
              <Grip size={16} />
            </div>

            <div
              onClick={handleCopy}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                zIndex: 10,
                cursor: 'pointer',
                background: copied ? 'var(--accent, #7c9cff)' : 'var(--surface-2, rgba(0,0,0,0.5))',
                borderRadius: 4,
                padding: '4px',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 12,
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
              }}
              title="Copy image"
            >
              <Copy size={16} />
              {copied && <span style={{ paddingRight: 4 }}>Copied</span>}
            </div>

            {(['tl', 'tr', 'bl', 'br'] as const).map(corner => {
              const isTop = corner[0] === 't'
              const isLeft = corner[1] === 'l'
              return (
                <div
                  key={corner}
                  onPointerDown={(e) => onPointerDown(e, corner)}
                  style={{
                    position: 'absolute',
                    top: isTop ? -6 : undefined,
                    bottom: !isTop ? -6 : undefined,
                    left: isLeft ? -6 : undefined,
                    right: !isLeft ? -6 : undefined,
                    width: 14,
                    height: 14,
                    backgroundColor: 'var(--accent, #7c9cff)',
                    border: '2px solid var(--bg-1, #202020)',
                    cursor: (isTop === isLeft) ? 'nwse-resize' : 'nesw-resize',
                    borderRadius: '50%',
                    zIndex: 10,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
                  }}
                  title="Drag to resize"
                />
              )
            })}
          </>
        )}
      </div>
    </NodeViewWrapper>
  )
}
