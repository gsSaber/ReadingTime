export function modelEndpointUrl(value: string): URL {
  const url = new URL(value.trim())
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = /\/chat\/completions$/i.test(path) ? path : path + '/chat/completions'
  url.hash = ''
  return url
}

export function sameModelEndpoint(left: string, right: string): boolean {
  try {
    return modelEndpointUrl(left).href === modelEndpointUrl(right).href
  } catch {
    return false
  }
}
