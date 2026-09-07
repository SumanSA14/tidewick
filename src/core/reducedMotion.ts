/**
 * prefers-reduced-motion is honoured as a first-class input, not an
 * afterthought: it disables idle camera drift and cuts particle density.
 * The island must still be a complete, readable picture without any of it.
 */
const query = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null

export function prefersReducedMotion(): boolean {
  return query?.matches ?? false
}

export function onReducedMotionChange(fn: (reduced: boolean) => void): () => void {
  if (!query) return () => {}
  const handler = (e: MediaQueryListEvent) => fn(e.matches)
  query.addEventListener('change', handler)
  return () => query.removeEventListener('change', handler)
}
