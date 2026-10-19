/// <reference types="vite/client" />
/**
 * Turns files the user drops, pastes or picks into chat attachments:
 * images as they are (downscaled when huge), PDFs as text plus page images
 * when they have little text (scans), Word files and text files as text.
 */
import { chatApi, toBase64, type ChatAttachment } from './api'

const MAX_IMAGE_SIDE = 2400
const MAX_PDF_PAGE_IMAGES = 12

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|jsx|ts|tsx|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|sh|ps1|bat|yaml|yml|toml|ini|sql|tex|log|r|m|swift|kt)$/i

async function saveBuf(buf: ArrayBuffer) {
  return chatApi.saveBlob(toBase64(buf))
}

async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/** Keeps photos at a size the model reads well, as JPEG or PNG. */
async function normalizeImage(file: Blob): Promise<{ buf: ArrayBuffer; mime: string }> {
  const mime = file.type || 'image/png'
  if (mime === 'image/gif' || mime === 'image/svg+xml') {
    // The model needs pixels: draw them.
    const img = await loadImage(file)
    return canvasOut(img, img.naturalWidth || 800, img.naturalHeight || 600, 'image/png')
  }
  const img = await loadImage(file)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h))
  if (scale >= 1 && file.size < 6 * 1024 * 1024 && /^image\/(png|jpeg|webp)$/.test(mime)) return { buf: await file.arrayBuffer(), mime }
  return canvasOut(img, Math.round(w * scale), Math.round(h * scale), mime === 'image/png' ? 'image/png' : 'image/jpeg')
}

async function canvasOut(img: CanvasImageSource, w: number, h: number, mime: string) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  if (mime === 'image/jpeg') {
    g.fillStyle = '#fff'
    g.fillRect(0, 0, w, h)
  }
  g.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), mime, 0.9))
  return { buf: await blob.arrayBuffer(), mime }
}

async function readPdf(buf: ArrayBuffer, onProgress?: (s: string) => void) {
  const pdfjs = await import('pdfjs-dist')
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = worker
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise
  const texts: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Reading page ${i} of ${doc.numPages}`)
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    let line = ''
    const lines: string[] = []
    for (const it of tc.items as any[]) {
      line += it.str
      if (it.hasEOL) {
        lines.push(line)
        line = ''
      } else line += ''
    }
    if (line) lines.push(line)
    texts.push(`--- page ${i} ---\n${lines.join('\n').trim()}`)
  }
  const text = texts.join('\n\n')
  const letters = text.replace(/--- page \d+ ---|\s/g, '').length
  // Scanned or handwritten PDFs have no text layer: render pages for the model.
  const pages: string[] = []
  if (letters < doc.numPages * 200) {
    const n = Math.min(doc.numPages, MAX_PDF_PAGE_IMAGES)
    for (let i = 1; i <= n; i++) {
      onProgress?.(`Rendering page ${i} of ${n}`)
      const page = await doc.getPage(i)
      const vp1 = page.getViewport({ scale: 1 })
      const scale = Math.min(2, 1600 / Math.max(vp1.width, vp1.height))
      const vp = page.getViewport({ scale })
      const c = document.createElement('canvas')
      c.width = Math.round(vp.width)
      c.height = Math.round(vp.height)
      const g = c.getContext('2d')!
      g.fillStyle = '#fff'
      g.fillRect(0, 0, c.width, c.height)
      await page.render({ canvasContext: g, viewport: vp }).promise
      const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.85))
      pages.push(await saveBuf(await blob.arrayBuffer()))
    }
  }
  return { text: letters ? text : '', pages, pageCount: doc.numPages }
}

async function readDocx(buf: ArrayBuffer) {
  const mammoth: any = await import('mammoth')
  const res = await (mammoth.default || mammoth).extractRawText({ arrayBuffer: buf })
  return String(res.value || '')
}

export async function fileToAttachment(file: File, onProgress?: (s: string) => void): Promise<ChatAttachment> {
  const name = file.name || (file.type.startsWith('image/') ? `pasted image.${file.type.split('/')[1] || 'png'}` : 'file')
  if (file.size > 60 * 1024 * 1024) throw new Error(`${name} is larger than 60 MB.`)
  if (file.type.startsWith('image/')) {
    onProgress?.('Preparing image')
    const { buf, mime } = await normalizeImage(file)
    return { sha: await saveBuf(buf), mime, name, size: buf.byteLength, kind: 'image' }
  }
  const buf = await file.arrayBuffer()
  if (file.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    const sha = await saveBuf(buf)
    const { text, pages, pageCount } = await readPdf(buf, onProgress)
    return { sha, mime: 'application/pdf', name, size: file.size, kind: 'pdf', text, pages, pageCount }
  }
  if (/\.docx$/i.test(name)) {
    onProgress?.('Reading document')
    const sha = await saveBuf(buf)
    return { sha, mime: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name, size: file.size, kind: 'doc', text: await readDocx(buf) }
  }
  if (file.type.startsWith('text/') || TEXT_EXT.test(name) || file.type === 'application/json') {
    const sha = await saveBuf(buf)
    return { sha, mime: file.type || 'text/plain', name, size: file.size, kind: 'text', text: new TextDecoder().decode(buf) }
  }
  throw new Error(`${name}: this file type is not supported. Images, PDF, Word (.docx) and text files work.`)
}

export function prettySize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
