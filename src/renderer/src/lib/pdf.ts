import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask
} from 'pdfjs-dist'
import { MAX_SELECTION_LENGTH } from '@shared/types'
import type { SelectionContext } from '@shared/types'
import { detectTranslationMode } from '@shared/lookup'
import { getSelectionContext } from './selection-context'

GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', document.baseURI).href

export { TextLayer }
export type { PDFDocumentProxy }

export interface PdfPageSize {
  width: number
  height: number
}

export interface OutlineItem {
  id: string
  title: string
  page: number | null
  level: number
  children: OutlineItem[]
}

export interface RawOutlineNode {
  title: string
  dest?: string | unknown[] | null
  items?: RawOutlineNode[]
}

export interface SelectedText {
  text: string
  truncated: boolean
  context?: SelectionContext
  rect: { left: number; top: number; right: number; bottom: number }
}

function assetUrl(path: string): string {
  return new URL(`pdfjs/${path}`, document.baseURI).href
}

export function loadPdfDocument(
  data: Uint8Array,
  options: {
    onProgress?: (loaded: number, total: number) => void
  } = {}
): PDFDocumentLoadingTask {
  const task = getDocument({
    data,
    cMapUrl: assetUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts/'),
    wasmUrl: assetUrl('wasm/'),
    useSystemFonts: true,
    isEvalSupported: false,
    enableXfa: true
  })
  if (options.onProgress) {
    task.onProgress = (progress: { loaded: number; total: number }) => {
      options.onProgress?.(progress.loaded, progress.total)
    }
  }
  return task
}

export async function collectPageSizes(
  pdf: PDFDocumentProxy,
  onProgress?: (loaded: number, total: number) => void
): Promise<PdfPageSize[]> {
  const sizes: PdfPageSize[] = new Array(pdf.numPages)
  let loaded = 0
  let nextIndex = 0
  const workerCount = Math.min(6, pdf.numPages)

  const worker = async (): Promise<void> => {
    while (nextIndex < pdf.numPages) {
      const index = nextIndex
      nextIndex += 1
      const page = await pdf.getPage(index + 1)
      const viewport = page.getViewport({ scale: 1 })
      sizes[index] = { width: viewport.width, height: viewport.height }
      loaded += 1
      onProgress?.(loaded, pdf.numPages)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return sizes
}

function nodeElement(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
}

export function getSelectedPdfText(root: HTMLElement): SelectedText | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const anchorElement = nodeElement(selection.anchorNode)
  const focusElement = nodeElement(selection.focusNode)
  const anchorInText = anchorElement?.closest('.pdf-text-layer')
  const focusInText = focusElement?.closest('.pdf-text-layer')
  const selectionElement = anchorInText || focusInText
  if (!selectionElement || !root.contains(selectionElement)) return null

  const raw = selection.toString()
  if (!raw.trim()) return null

  const normalized = raw
    .replace(/\u0000/g, '')
    .replace(/\u00ad/g, '')
    .replace(/-\s*\n\s*(?=[a-zà-öø-ÿ])/gi, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  if (!normalized) return null
  const truncated = normalized.length > MAX_SELECTION_LENGTH
  const text = truncated ? normalized.slice(0, MAX_SELECTION_LENGTH).trimEnd() : normalized

  const range = selection.getRangeAt(0)
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0.5 && rect.height > 0.5
  )
  const fallback = range.getBoundingClientRect()
  const usableRects = rects.length
    ? rects
    : fallback.width > 0
      ? [fallback]
      : []
  if (!usableRects.length) return null

  const left = Math.min(...usableRects.map((rect) => rect.left))
  const right = Math.max(...usableRects.map((rect) => rect.right))
  const top = Math.min(...usableRects.map((rect) => rect.top))
  const bottom = Math.max(...usableRects.map((rect) => rect.bottom))

  return {
    text,
    truncated,
    context: detectTranslationMode(text) === 'lookup' ? getSelectionContext(range, selectionElement) : undefined,
    rect: { left, top, right, bottom }
  }
}

function pageFromDestination(
  destination: string | unknown[] | null | undefined,
  pdf: PDFDocumentProxy
): Promise<number | null> {
  return (async () => {
    try {
      const dest =
        typeof destination === 'string' ? await pdf.getDestination(destination) : destination
      if (!Array.isArray(dest) || !dest.length) return null
      const ref = dest[0]
      if (typeof ref === 'number') return Math.max(1, ref + 1)
      if (typeof ref === 'object' && ref !== null) {
        const pageIndex = await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
        return pageIndex + 1
      }
      return null
    } catch {
      return null
    }
  })()
}

export async function collectOutline(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  let raw: RawOutlineNode[] | null = null
  try {
    raw = (await pdf.getOutline()) as RawOutlineNode[] | null
  } catch {
    return []
  }
  if (!raw?.length) return []

  let counter = 0
  const maxNodes = 500

  const walk = async (nodes: RawOutlineNode[], level: number): Promise<OutlineItem[]> => {
    const items: OutlineItem[] = []
    for (const node of nodes) {
      if (counter >= maxNodes) break
      counter += 1
      const id = `outline-${counter}`
      const children = node.items?.length ? await walk(node.items, level + 1) : []
      const page = await pageFromDestination(node.dest, pdf)
      items.push({
        id,
        title: (node.title || '未命名章节').trim(),
        page,
        level,
        children
      })
    }
    return items
  }

  return walk(raw, 0)
}

export function countOutlineItems(items: OutlineItem[]): number {
  return items.reduce((count, item) => count + 1 + countOutlineItems(item.children), 0)
}

export function flattenOutline(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)])
}
