import type { ReadingTimeApi } from '../../shared/types'

declare global {
  interface Window {
    readingTime: ReadingTimeApi
  }
}

export {}
