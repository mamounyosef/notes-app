import React, { useRef, useState, useCallback, useEffect } from 'react'
import { NodeViewWrapper, NodeViewProps } from '@tiptap/react'

export function ResizableImageNode(props: NodeViewProps) {
  const { node, updateAttributes, selected } = props
  const imgRef = useRef<HTMLImageElement>(null)
  const [resizing, setResizing] = useState(false)
  const [currentWidth, setCurrentWidth] = useState<number | null>(null)
  
  useEffect(() => {
    if (!resizing && node.attrs.width) {
      setCurrentWidth(node.attrs.width)
    }
  }, [node.attrs.width, resizing])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
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
      const newWidth = Math.max(50, startWidth + dx)
      setCurrentWidth(newWidth)
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      setResizing(false)
      const dx = upEvent.clientX - startX
      const finalWidth = Math.max(50, startWidth + dx)
      // Save the final width to the document
      updateAttributes({ width: finalWidth, height: 'auto' })
      
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }, [node.attrs.width, updateAttributes])

  const width = resizing && currentWidth ? currentWidth : node.attrs.width

  return (
    <NodeViewWrapper 
      className={`resizable-image ${selected ? 'ProseMirror-selectednode' : ''}`} 
      style={{ display: 'inline-block', position: 'relative', verticalAlign: 'bottom', maxWidth: '100%', margin: '0.5em 0' }}
    >
      <img
        ref={imgRef}
        src={node.attrs.src}
        alt={node.attrs.alt}
        title={node.attrs.title}
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
        <div
          onPointerDown={onPointerDown}
          style={{
            position: 'absolute',
            bottom: -6,
            right: -6,
            width: 14,
            height: 14,
            backgroundColor: 'var(--accent, #7c9cff)',
            border: '2px solid var(--bg-1, #202020)',
            cursor: 'nwse-resize',
            borderRadius: '50%',
            zIndex: 10,
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)'
          }}
          title="Drag to resize"
        />
      )}
    </NodeViewWrapper>
  )
}
