/**
 * Formatting tools over the keyboard while a cell is being edited. Taps never
 * take focus away from the text, so the keyboard stays up.
 */
import React, { useRef, useState } from 'react'
import { useActiveEditor } from '../../../src/editor/activeEditor'
import { useStore } from '../../../src/store'
import {
  Bold,
  Italic,
  UnderlineI,
  StrikeI,
  ListUl,
  ListOl,
  Check,
  Highlighter,
  Palette,
  LinkI,
  ImageI,
  TableI,
  Sigma,
  CodeI,
  Hr,
  Undo,
  Redo,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Quote,
  ArrowLeft,
  ArrowRight,
} from '../../../src/components/Icons'
import { storage } from '../../../src/lib/storage'
import { askText, COLORS } from './overlays'
import { stopEditing } from './PageView'
import { tick } from '../platform'

type Pop = null | 'text' | 'color' | 'mark' | 'insert'

export function FormatBar() {
  const editingId = useStore((s) => s.editingCellId)
  const editor = useActiveEditor((s) => s.editor)
  useActiveEditor((s) => s.tick)
  const [pop, setPop] = useState<Pop>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const camRef = useRef<HTMLInputElement>(null)
  if (!editingId) return null
  const ed = editor && !editor.isDestroyed ? editor : null
  const is = (name: string, attrs?: any) => Boolean(ed?.isActive(name, attrs))
  const run = (fn: (c: any) => any) => {
    if (!ed) return
    tick()
    fn(ed.chain().focus()).run()
  }
  // Keeps the editor focused: the button acts on pointer down.
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault()
  const B = ({ on, label, onPress, children }: { on?: boolean; label: string; onPress(): void; children: React.ReactNode }) => (
    <button
      className={`m-fbtn ${on ? 'on' : ''}`}
      aria-label={label}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={() => {
        onPress()
      }}
    >
      {children}
    </button>
  )
  const toggle = (p: Pop) => setPop((cur) => (cur === p ? null : p))
  const level = [1, 2, 3].find((l) => is('heading', { level: l }))

  const addImage = async (file: File | undefined) => {
    if (!file || !ed) return
    const dataUrl = await shrinkImage(file)
    const src = (await storage.saveAsset(dataUrl)) || dataUrl
    const img = new Image()
    img.src = dataUrl
    await img.decode().catch(() => {})
    const maxW = useStore.getState().settings.maxImageWidth || 800
    ed.chain().focus().setImage({ src, width: Math.min(img.naturalWidth || maxW, maxW) } as any).run()
  }

  return (
    <>
      {pop && (
        <div className="m-fpop" onPointerDown={keep}>
          {pop === 'text' && (
            <>
              <B label="Normal text" on={!level} onPress={() => run((c) => c.setParagraph())}>
                Aa
              </B>
              {[1, 2, 3].map((l) => (
                <B key={l} label={`Heading ${l}`} on={level === l} onPress={() => run((c) => c.toggleHeading({ level: l }))}>
                  H{l}
                </B>
              ))}
              <B label="Quote" on={is('blockquote')} onPress={() => run((c) => c.toggleBlockquote())}>
                <Quote />
              </B>
              <B label="Align left" onPress={() => run((c) => c.setTextAlign('left'))}>
                <AlignLeft />
              </B>
              <B label="Center" onPress={() => run((c) => c.setTextAlign('center'))}>
                <AlignCenter />
              </B>
              <B label="Align right" onPress={() => run((c) => c.setTextAlign('right'))}>
                <AlignRight />
              </B>
              <B label="Clear formatting" onPress={() => run((c) => c.unsetAllMarks().clearNodes())}>
                Tx
              </B>
            </>
          )}
          {(pop === 'color' || pop === 'mark') &&
            ['', ...(pop === 'mark' ? ['#ffd75e', '#98c379', '#61afef', '#e06c75', '#c678dd'] : COLORS)].map((c) => (
              <button
                key={c || 'none'}
                className={`m-swatch ${c ? '' : 'none'}`}
                style={c ? { background: c } : undefined}
                aria-label={c || 'None'}
                onPointerDown={keep}
                onMouseDown={keep}
                onClick={() => {
                  if (pop === 'color') run((ch) => (c ? ch.setColor(c) : ch.unsetColor()))
                  else run((ch) => (c ? ch.setHighlight({ color: c }) : ch.unsetHighlight()))
                  setPop(null)
                }}
              />
            ))}
          {pop === 'insert' && (
            <>
              <B label="Picture from gallery" onPress={() => fileRef.current?.click()}>
                <ImageI />
              </B>
              <B label="Take a photo" onPress={() => camRef.current?.click()}>
                <span style={{ fontSize: 12 }}>Camera</span>
              </B>
              <B label="Table" onPress={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}>
                <TableI />
              </B>
              <B label="Equation" onPress={() => run((c) => c.insertInlineMath?.('x^2') ?? c)}>
                <Sigma />
              </B>
              <B label="Code block" on={is('codeBlock')} onPress={() => run((c) => c.toggleCodeBlock())}>
                <CodeI />
              </B>
              <B label="Line" onPress={() => run((c) => c.setHorizontalRule())}>
                <Hr />
              </B>
              <B
                label="Link"
                on={is('link')}
                onPress={() => {
                  const cur = ed?.getAttributes('link')?.href || ''
                  askText({
                    title: 'Link',
                    value: cur || 'https://',
                    ok: 'Set link',
                    onOk: (href) => run((c) => (href ? c.extendMarkRange('link').setLink({ href }) : c.unsetLink())),
                  })
                }}
              >
                <LinkI />
              </B>
            </>
          )}
        </div>
      )}
      <div className="m-format" onPointerDown={keep}>
        <div className="m-format-scroll">
          <B label="Undo" onPress={() => run((c) => c.undo())}>
            <Undo />
          </B>
          <B label="Redo" onPress={() => run((c) => c.redo())}>
            <Redo />
          </B>
          <span className="m-fsep" />
          <B label="Text style" on={pop === 'text' || Boolean(level)} onPress={() => toggle('text')}>
            {level ? `H${level}` : 'Aa'}
          </B>
          <B label="Bold" on={is('bold')} onPress={() => run((c) => c.toggleBold())}>
            <Bold />
          </B>
          <B label="Italic" on={is('italic')} onPress={() => run((c) => c.toggleItalic())}>
            <Italic />
          </B>
          <B label="Underline" on={is('underline')} onPress={() => run((c) => c.toggleUnderline())}>
            <UnderlineI />
          </B>
          <B label="Highlight" on={is('highlight') || pop === 'mark'} onPress={() => toggle('mark')}>
            <Highlighter />
          </B>
          <B label="Text color" on={pop === 'color'} onPress={() => toggle('color')}>
            <Palette />
          </B>
          <span className="m-fsep" />
          <B label="Bullets" on={is('bulletList')} onPress={() => run((c) => c.toggleBulletList())}>
            <ListUl />
          </B>
          <B label="Numbers" on={is('orderedList')} onPress={() => run((c) => c.toggleOrderedList())}>
            <ListOl />
          </B>
          <B label="Check list" on={is('taskList')} onPress={() => run((c) => c.toggleTaskList())}>
            <Check />
          </B>
          <B label="Indent less" onPress={() => run((c) => (is('taskItem') ? c.liftListItem('taskItem') : c.liftListItem('listItem')))}>
            <ArrowLeft />
          </B>
          <B label="Indent more" onPress={() => run((c) => (is('taskItem') ? c.sinkListItem('taskItem') : c.sinkListItem('listItem')))}>
            <ArrowRight />
          </B>
          <B label="Strikethrough" on={is('strike')} onPress={() => run((c) => c.toggleStrike())}>
            <StrikeI />
          </B>
          <span className="m-fsep" />
          <B label="Insert" on={pop === 'insert'} onPress={() => toggle('insert')}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>+</span>
          </B>
        </div>
        <button
          className="m-fdone"
          onPointerDown={keep}
          onClick={() => {
            setPop(null)
            stopEditing()
          }}
        >
          <Check /> Done
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => (addImage(e.target.files?.[0]), (e.target.value = ''), setPop(null))} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (addImage(e.target.files?.[0]), (e.target.value = ''), setPop(null))} />
    </>
  )
}

/** Phone photos are huge: scaled to at most 1600 px and saved as JPEG (PNG stays PNG when small). */
async function shrinkImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const max = 1600
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight))
    if (k === 1 && file.size < 600_000) {
      return await new Promise((res) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result))
        r.readAsDataURL(file)
      })
    }
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}
