import React, { useEffect, useRef, useState } from 'react'
import { useActiveEditor } from '../editor/activeEditor'
import { insertImageFile } from '../editor/extensions'
import { useStore } from '../store'
import { Menu, type MenuItem } from './Menu'
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check, CodeI, Cursor, Eraser,
  Highlighter, Hr, ImageI, Italic, Layers, LinkI, ListOl, ListUl, Palette, Pen, Plus,
  Quote, Redo, Sigma, SpaceI, StrikeI, TableI, UnderlineI, Undo,
} from './Icons'

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 40, 48]
const FONTS = [
  'Segoe UI', 'Calibri', 'Arial', 'Georgia', 'Times New Roman', 'Verdana',
  'Consolas', 'Cascadia Code', 'Comic Sans MS',
]
const PALETTE = [
  '#ffffff', '#e6e6e6', '#a5a5a5', '#000000',
  '#e06c75', '#ff8f6b', '#e5c07b', '#98c379',
  '#56b6c2', '#61afef', '#7c9cff', '#c678dd',
  '#f06292', '#8d6e63', '#26a69a', '#ffd75e',
]

function FontSizeControl({ editor, can }: { editor: any; can: boolean }) {
  const settings = useStore((s) => s.settings)
  const currentSizeAttr = editor?.getAttributes('textStyle').fontSize
  const currentSize = currentSizeAttr ? parseInt(currentSizeAttr, 10) : settings.bodySize

  const [val, setVal] = useState<string | number>(currentSize)

  useEffect(() => {
    setVal(currentSize)
  }, [currentSize])

  const applySize = (newSize: number) => {
    if (!editor) return
    if (newSize > 0) {
      if (editor.state.selection.empty) {
        const { $from } = editor.state.selection
        if ($from.parent.isTextblock) {
          const text = $from.parent.textContent
          const offset = $from.parentOffset
          const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c)
          let start = offset
          while (start > 0 && isWordChar(text[start - 1])) start--
          let end = offset
          while (end < text.length && isWordChar(text[end])) end++
          
          if (start < end) {
            const from = $from.pos - (offset - start)
            const to = $from.pos + (end - offset)
            editor.chain().focus().setTextSelection({ from, to }).setFontSize(`${newSize}px`).setTextSelection($from.pos).run()
            return
          }
        }
      }
      editor.chain().focus().setFontSize(`${newSize}px`).run()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const num = parseInt(val.toString(), 10)
      if (!isNaN(num)) applySize(num)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      inc()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      dec()
    }
  }

  const handleBlur = () => {
    const num = parseInt(val.toString(), 10)
    if (!isNaN(num)) applySize(num)
    else setVal(currentSize)
  }
  
  const inc = () => {
    const num = parseInt(val.toString(), 10) || currentSize
    const n = num + 1
    setVal(n)
    applySize(n)
  }
  
  const dec = () => {
    const num = parseInt(val.toString(), 10) || currentSize
    const n = num > 1 ? num - 1 : 1
    setVal(n)
    applySize(n)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', margin: '0 4px' }}>
      <input
        type="text"
        title="Text size"
        disabled={!can}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        style={{
          width: 32,
          height: 24,
          textAlign: 'center',
          border: '1px solid var(--border)',
          borderRadius: '4px 0 0 4px',
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 12,
          outline: 'none',
          padding: 0
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', margin: '0 1px', gap: '1px' }}>
        <button 
          title="Increase size"
          disabled={!can}
          onClick={inc}
          style={{ 
            width: 16, height: 11, padding: 0, minWidth: 0, 
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--surface-2)', border: '1px solid var(--border)', 
            borderRadius: '0 4px 0 0', cursor: 'pointer',
            color: 'var(--text-faint)'
          }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>
        </button>
        <button 
          title="Decrease size"
          disabled={!can}
          onClick={dec}
          style={{ 
            width: 16, height: 12, padding: 0, minWidth: 0, 
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--surface-2)', border: '1px solid var(--border)', 
            borderRadius: '0 0 4px 0', cursor: 'pointer',
            color: 'var(--text-faint)'
          }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
      </div>
    </div>
  )
}

export default function Toolbar() {
  const editor = useActiveEditor((s) => s.editor)
  useActiveEditor((s) => s.tick) // re-render on selection change
  const settings = useStore((s) => s.settings)
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  const selection = useStore((s) => s.selection)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const can = !!editor
  const run = (fn: (chain: any) => any) => () => {
    if (!editor) return
    fn(editor.chain().focus())
  }
  const is = (name: string, attrs?: any) => (editor ? editor.isActive(name, attrs) : false)

  const colorMenu = (e: React.MouseEvent, kind: 'text' | 'highlight') => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { title: kind === 'text' ? 'Text color' : 'Highlight' },
        {
          icon: (
            <div className="swatches" style={{ padding: 0 }}>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className="swatch"
                  style={{ background: c }}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    if (!editor) return
                    kind === 'text'
                      ? editor.chain().focus().setColor(c).run()
                      : editor.chain().focus().setHighlight({ color: c }).run()
                    rememberColor(c)
                    setMenu(null)
                  }}
                />
              ))}
            </div>
          ),
        },
        { separator: true },
        {
          label: 'Custom color',
          onClick: () => {
            const input = document.createElement('input')
            input.type = 'color'
            input.oninput = () => {
              if (!editor) return
              kind === 'text'
                ? editor.chain().focus().setColor(input.value).run()
                : editor.chain().focus().setHighlight({ color: input.value }).run()
              rememberColor(input.value)
            }
            input.click()
          },
        },
        {
          label: 'Remove',
          onClick: () =>
            kind === 'text' ? editor?.chain().focus().unsetColor().run() : editor?.chain().focus().unsetHighlight().run(),
        },
      ],
    })
  }

  const rememberColor = (c: string) => {
    const st = useStore.getState()
    st.setSettings({ recentColors: [c, ...st.settings.recentColors.filter((x) => x !== c)].slice(0, 8) })
  }

  const insertMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: 'Table 3 x 3', icon: <TableI />, onClick: run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()) },
        { label: 'Add row below', onClick: run((c) => c.addRowAfter().run()) },
        { label: 'Add column right', onClick: run((c) => c.addColumnAfter().run()) },
        { label: 'Delete row', onClick: run((c) => c.deleteRow().run()) },
        { label: 'Delete column', onClick: run((c) => c.deleteColumn().run()) },
        { label: 'Delete table', danger: true, onClick: run((c) => c.deleteTable().run()) },
        { separator: true },
        { label: 'Image from file', icon: <ImageI />, onClick: () => fileRef.current?.click() },
        { label: 'Horizontal line', icon: <Hr />, hint: '---', onClick: run((c) => c.setHorizontalRule().run()) },
        { label: 'Thick horizontal line', icon: <Hr />, hint: settings.thickLineShortcut || 'Alt-S', onClick: run((c) => (c as any).setThickHorizontalRule().run()) },
        { label: 'Code block', icon: <CodeI />, hint: '```', onClick: run((c) => c.toggleCodeBlock().run()) },
        { label: 'Quote', icon: <Quote />, hint: '> ', onClick: run((c) => c.toggleBlockquote().run()) },
        { label: 'Checklist', icon: <Check />, hint: '[] ', onClick: run((c) => c.toggleTaskList().run()) },
        { separator: true },
        { label: 'Inline math', icon: <Sigma />, hint: '$x$', onClick: run((c) => c.insertInlineMath('x^2').run()) },
        { label: 'Block math', icon: <Sigma />, hint: '$$', onClick: run((c) => c.insertBlockMath('\\int_0^1 f(x)\\,dx').run()) },
        { separator: true },
        {
          label: 'Link',
          icon: <LinkI />,
          hint: 'Ctrl+K',
          onClick: () => {
            const url = window.prompt('Link address')
            if (url) editor?.chain().focus().setLink({ href: url }).run()
          },
        },
      ],
    })
  }

  return (
    <div className="toolbar">
      <button className="tb-btn" title="Undo (Ctrl+Z)" onClick={() => {
        const st = useStore.getState()
        if (st.editingCellId && editor?.can().undo()) {
          editor.chain().focus().undo().run()
        } else {
          st.undo()
        }
      }}><Undo /></button>
      <button className="tb-btn" title="Redo (Ctrl+Y)" onClick={() => {
        const st = useStore.getState()
        if (st.editingCellId && editor?.can().redo()) {
          editor.chain().focus().redo().run()
        } else {
          st.redo()
        }
      }}><Redo /></button>
      <div className="tb-sep" />

      <select
        className="tb-select"
        title="Font"
        value=""
        onChange={(e) => e.target.value && editor?.chain().focus().setFontFamily2(e.target.value).run()}
        disabled={!can}
      >
        <option value="">Font</option>
        {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>

      <FontSizeControl editor={editor} can={can} />

      <select
        className="tb-select"
        title="Paragraph style"
        value={is('heading', { level: 1 }) ? 'h1' : is('heading', { level: 2 }) ? 'h2' : is('heading', { level: 3 }) ? 'h3' : 'p'}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'p') editor?.chain().focus().setParagraph().run()
          else editor?.chain().focus().toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
        }}
        disabled={!can}
      >
        <option value="p">Body</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

      <div className="tb-sep" />
      <button className={`tb-btn ${is('bold') ? 'on' : ''}`} title="Bold (Ctrl+B)" disabled={!can} onClick={run((c) => c.toggleBold().run())}><Bold /></button>
      <button className={`tb-btn ${is('italic') ? 'on' : ''}`} title="Italic (Ctrl+I)" disabled={!can} onClick={run((c) => c.toggleItalic().run())}><Italic /></button>
      <button className={`tb-btn ${is('underline') ? 'on' : ''}`} title="Underline (Ctrl+U)" disabled={!can} onClick={run((c) => c.toggleUnderline().run())}><UnderlineI /></button>
      <button className={`tb-btn ${is('strike') ? 'on' : ''}`} title="Strikethrough" disabled={!can} onClick={run((c) => c.toggleStrike().run())}><StrikeI /></button>
      <button className={`tb-btn ${is('code') ? 'on' : ''}`} title="Inline code" disabled={!can} onClick={run((c) => c.toggleCode().run())}><CodeI /></button>

      <button className="tb-btn" title="Text color" disabled={!can} onClick={(e) => colorMenu(e, 'text')}><Palette /></button>
      <button className="tb-btn" title="Highlight" disabled={!can} onClick={(e) => colorMenu(e, 'highlight')}><Highlighter /></button>

      {/* one click recent colors */}
      {settings.recentColors.slice(0, 5).map((c) => (
        <button
          key={c}
          className="tb-btn"
          title={`Text color ${c}`}
          disabled={!can}
          onClick={() => editor?.chain().focus().setColor(c).run()}
          style={{ padding: 0, minWidth: 18 }}
        >
          <span className="swatch" style={{ background: c, width: 14, height: 14 }} />
        </button>
      ))}

      <div className="tb-sep" />
      <button className={`tb-btn ${is('bulletList') ? 'on' : ''}`} title="Bullet list" disabled={!can} onClick={run((c) => c.toggleBulletList().run())}><ListUl /></button>
      <button className={`tb-btn ${is('orderedList') ? 'on' : ''}`} title="Numbered list" disabled={!can} onClick={run((c) => c.toggleOrderedList().run())}><ListOl /></button>
      <button className={`tb-btn ${is('taskList') ? 'on' : ''}`} title="Checklist" disabled={!can} onClick={run((c) => c.toggleTaskList().run())}><Check /></button>

      <div className="tb-sep" />
      <button className={`tb-btn ${is({ textAlign: 'left' } as any) ? 'on' : ''}`} title="Align left" disabled={!can} onClick={run((c) => c.setTextAlign('left').run())}><AlignLeft /></button>
      <button className="tb-btn" title="Center" disabled={!can} onClick={run((c) => c.setTextAlign('center').run())}><AlignCenter /></button>
      <button className="tb-btn" title="Align right" disabled={!can} onClick={run((c) => c.setTextAlign('right').run())}><AlignRight /></button>
      <button className="tb-btn" title="Justify" disabled={!can} onClick={run((c) => c.setTextAlign('justify').run())}><AlignJustify /></button>

      <div className="tb-sep" />
      <button className="tb-btn" title="Insert" onClick={insertMenu}><Plus /> Insert</button>

      <div className="tb-sep" />
      <button className={`tb-btn ${tool === 'select' ? 'on' : ''}`} title="Select (V)" onClick={() => setTool('select')}><Cursor /></button>
      <button className={`tb-btn ${tool === 'pen' ? 'on' : ''}`} title="Pen (P)" onClick={() => setTool(tool === 'pen' ? 'select' : 'pen')}><Pen /></button>
      <button className={`tb-btn ${tool === 'highlighter' ? 'on' : ''}`} title="Highlighter (H)" onClick={() => setTool(tool === 'highlighter' ? 'select' : 'highlighter')}><Highlighter /></button>
      <button className={`tb-btn ${tool === 'eraser' ? 'on' : ''}`} title="Eraser (E)" onClick={() => setTool(tool === 'eraser' ? 'select' : 'eraser')}><Eraser /></button>
      <button className={`tb-btn ${tool === 'space' ? 'on' : ''}`} title="Insert space (S): drag down to push everything below" onClick={() => setTool(tool === 'space' ? 'select' : 'space')}><SpaceI /></button>

      {tool === 'pen' || tool === 'highlighter' ? (
        <>
          <input
            type="color"
            title="Ink color"
            value={tool === 'pen' ? settings.penColor : settings.highlighterColor}
            onChange={(e) =>
              useStore.getState().setSettings(tool === 'pen' ? { penColor: e.target.value } : { highlighterColor: e.target.value })
            }
            style={{ width: 28, height: 26, padding: 2 }}
          />
          <input
            type="range"
            min={1}
            max={40}
            title="Ink size"
            value={tool === 'pen' ? settings.penSize : settings.highlighterSize}
            onChange={(e) =>
              useStore.getState().setSettings(
                tool === 'pen' ? { penSize: Number(e.target.value) } : { highlighterSize: Number(e.target.value) },
              )
            }
            style={{ width: 90 }}
          />
        </>
      ) : null}

      <div className="tb-sep" />
      <button className="tb-btn" title="New cell (Ctrl+Enter)" onClick={() => useStore.getState().addCell()}><Plus /> Cell</button>
      {selection.length > 0 && (
        <button className="tb-btn" title="Arrange selected cells" onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const st = useStore.getState()
          setMenu({
            x: r.left, y: r.bottom + 4,
            items: [
              { label: 'Align left edges', onClick: () => alignCells('left') },
              { label: 'Align top edges', onClick: () => alignCells('top') },
              { label: 'Same width', onClick: () => alignCells('width') },
              { label: 'Stack vertically', onClick: () => alignCells('stack') },
              { separator: true },
              { label: 'Bring to front', icon: <Layers />, onClick: () => st.bringToFront(st.selection) },
              { label: 'Send to back', icon: <Layers />, onClick: () => st.sendToBack(st.selection) },
            ],
          })
        }}><Layers /> {selection.length}</button>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          if (!f || !editor) return
          await insertImageFile(editor, f)
          e.target.value = ''
        }}
      />

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function alignCells(mode: 'left' | 'top' | 'width' | 'stack') {
  const st = useStore.getState()
  const page = st.page
  if (!page) return
  const sel = page.cells.filter((c) => st.selection.includes(c.id))
  if (sel.length < 2) return
  st.pushHistory()
  const gap = st.settings.cellGap
  if (mode === 'left') {
    const x = Math.min(...sel.map((c) => c.x))
    st.updateCells(st.selection, () => ({ x }))
  } else if (mode === 'top') {
    const y = Math.min(...sel.map((c) => c.y))
    st.updateCells(st.selection, () => ({ y }))
  } else if (mode === 'width') {
    const w = Math.max(...sel.map((c) => c.w))
    st.updateCells(st.selection, () => ({ w }))
  } else {
    const sorted = [...sel].sort((a, b) => a.y - b.y)
    const x = Math.min(...sel.map((c) => c.x))
    let y = sorted[0].y
    const pos: Record<string, { x: number; y: number }> = {}
    for (const c of sorted) {
      pos[c.id] = { x, y }
      y += c.h + gap
    }
    st.updateCells(st.selection, (c) => pos[c.id])
  }
}
