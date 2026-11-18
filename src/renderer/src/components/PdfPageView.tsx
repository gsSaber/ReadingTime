import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { TextLayer } from 'pdfjs-dist'
import type { ReaderTone } from '@shared/types'
import { cn } from '../lib/format'

interface PdfPageViewProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  width: number
  height: number
  scale: number
  tone: ReaderTone
  scrollRootRef: RefObject<HTMLDivElement | null>
  registerPage: (page: number, element: HTMLDivElement | null) => void
}

export function PdfPageView({
  pdf,
  pageNumber,
  width,
  height,
  scale,
  tone,
  scrollRootRef,
  registerPage
}: PdfPageViewProps): React.JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(pageNumber === 1)
  const [rendered, setRendered] = useState(false)
  const [renderError, setRenderError] = useState('')

  const displayWidth = Math.max(1, Math.round(width * scale))
  const displayHeight = Math.max(1, Math.round(height * scale))

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    registerPage(pageNumber, shell)
    return () => registerPage(pageNumber, null)
  }, [pageNumber, registerPage])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    const root = scrollRootRef.current
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setActive(entry.isIntersecting)
      },
      {
        root: root || null,
        rootMargin: '1400px 0px 1400px 0px',
        threshold: 0
      }
    )
    observer.observe(shell)
    return () => observer.disconnect()
  }, [scrollRootRef])

  useEffect(() => {
    const canvas = canvasRef.current
    const textContainer = textLayerRef.current
    if (!canvas || !textContainer) return

    if (!active) {
      setRendered(false)
      textContainer.replaceChildren()
      canvas.width = 0
      canvas.height = 0
      return
    }

    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: TextLayer | null = null
    setRenderError('')
    setRendered(false)

    const renderPage = async (): Promise<void> => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const viewport = page.getViewport({ scale })
        const pixelAreaCap = 16_000_000
        const naturalRatio = window.devicePixelRatio || 1
        const capRatio = Math.sqrt(pixelAreaCap / Math.max(1, viewport.width * viewport.height))
        const outputRatio = Math.max(1, Math.min(naturalRatio, 2, capRatio))

        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Canvas 初始化失败。')
        canvas.width = Math.max(1, Math.floor(viewport.width * outputRatio))
        canvas.height = Math.max(1, Math.floor(viewport.height * outputRatio))
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputRatio === 1 ? undefined : [outputRatio, 0, 0, outputRatio, 0, 0]
        })
        await renderTask.promise
        if (cancelled) return

        textContainer.replaceChildren()
        const textContent = await page.getTextContent()
        if (cancelled) return
        textLayer = new TextLayer({
          textContentSource: textContent,
          container: textContainer,
          viewport
        })
        await textLayer.render()
        if (cancelled) return
        if (viewport.rotation === 0) {
          // Match the canvas's fractional CSS size, rather than rounding the
          // text layer down and shifting every percentage-positioned word.
          textContainer.style.width = `${viewport.width}px`
          textContainer.style.height = `${viewport.height}px`
          const adjustments: Array<{ element: HTMLElement; left: number; scaleX: number }> = []
          let index = 0
          for (const item of textContent.items) {
            if (!('str' in item)) continue
            const element = textLayer.textDivs[index++]
            if (
              !element || item.dir !== 'ltr' || item.width <= 0 ||
              item.transform[0] <= 0 || Math.abs(item.transform[1]) > 0.001 ||
              Math.abs(item.transform[2]) > 0.001 ||
              textContent.styles[item.fontName]?.vertical ||
              !/^[\p{Script=Latin}\p{M}\p{N}\p{P}\p{Zs}]+$/u.test(item.str)
            ) continue
            const measured = element.getBoundingClientRect().width
            if (measured <= 0) continue
            // Canvas font measurement (at device resolution) can differ from
            // DOM caret metrics. Fit the actual DOM word to its PDF advance.
            const scaleX = Number(element.style.getPropertyValue('--scale-x') || 1)
            adjustments.push({
              element,
              left: viewport.convertToViewportPoint(item.transform[4], item.transform[5])[0],
              scaleX: scaleX * item.width * scale / measured
            })
          }
          // Batch writes after measurements to avoid a layout per word.
          for (const { element, left, scaleX } of adjustments) {
            element.style.left = `${left}px`
            element.style.setProperty('--scale-x', String(scaleX))
          }
        }
        setRendered(true)
      } catch (error) {
        if (cancelled) return
        if (
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          ((error as { name: string }).name === 'RenderingCancelledException' ||
            (error as { name: string }).name === 'AbortException')
        ) {
          return
        }
        console.error(`[pdf] Failed to render page ${pageNumber}.`, error)
        setRenderError(error instanceof Error ? error.message : '页面渲染失败。')
      }
    }

    void renderPage()
    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
      textContainer.replaceChildren()
    }
  }, [active, pageNumber, pdf, scale])

  return (
    <div
      ref={shellRef}
      className={cn('pdf-page-shell', `tone-${tone}`)}
      style={{ width: displayWidth, height: displayHeight }}
      data-page={pageNumber}
    >
      <div
        className={cn('pdf-page-content', rendered && 'is-rendered')}
        style={
          {
            '--total-scale-factor': scale,
            '--scale-round-x': '1px',
            '--scale-round-y': '1px',
            width: displayWidth,
            height: displayHeight
          } as CSSProperties
        }
      >
        {!rendered && !renderError ? (
          <div className="page-placeholder" aria-hidden="true">
            <span className="placeholder-page-mark">{pageNumber}</span>
            <span className="placeholder-line wide" />
            <span className="placeholder-line" />
            <span className="placeholder-line short" />
          </div>
        ) : null}
        {renderError ? (
          <div className="page-error" role="alert">
            <span>这一页没能渲染</span>
            <small>{renderError}</small>
          </div>
        ) : null}
        <canvas
          ref={canvasRef}
          className="pdf-page-canvas"
          aria-label={`PDF 第 ${pageNumber} 页`}
        />
        <div
          ref={textLayerRef}
          className="textLayer pdf-text-layer"
          data-page-number={pageNumber}
        />
      </div>
      <span className="pdf-page-number">{pageNumber}</span>
    </div>
  )
}
