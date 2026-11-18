import type { SelectionContext } from '@shared/types'
import { contextAroundSelection } from '@shared/lookup'

/** Map the actual DOM range to its occurrence, including PDF line/span boundaries. */
export function getSelectionContext(range: Range, layer: Element): SelectionContext | undefined {
  if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return undefined
  const prefix = range.cloneRange()
  prefix.selectNodeContents(layer)
  prefix.setEnd(range.startContainer, range.startOffset)
  const rawStart = prefix.toString().length
  prefix.setEnd(range.endContainer, range.endOffset)
  const rawEnd = prefix.toString().length
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT)
  let rawOffset = 0
  let text = ''
  let start = 0
  let end = 0
  let previous: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const value = node.data
    if (previous && previous.parentElement !== node.parentElement) {
      const before = previous.parentElement?.getBoundingClientRect()
      const after = node.parentElement?.getBoundingClientRect()
      if (before && after && Math.abs(before.top - after.top) > Math.min(before.height, after.height) * 0.5) {
        text += after.top - before.bottom > Math.max(before.height, after.height) * 1.4 ? '\n\n' : '\n'
      } else if (before && after && after.left - before.right > 1 && !/\s$/.test(text) && !/^\s/.test(value)) {
        text += ' '
      }
    }
    if (rawStart >= rawOffset && rawStart <= rawOffset + value.length) start = text.length + rawStart - rawOffset
    if (rawEnd >= rawOffset && rawEnd <= rawOffset + value.length) end = text.length + rawEnd - rawOffset
    text += value
    rawOffset += value.length
    previous = node
  }
  return contextAroundSelection(text, start, end)
}
