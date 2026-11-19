import type { TranslateError } from '../shared/types'

export class LlmRequestError extends Error {
  readonly code: TranslateError['code']

  constructor(message: string, code: TranslateError['code']) {
    super(message)
    this.name = 'LlmRequestError'
    this.code = code
  }
}

