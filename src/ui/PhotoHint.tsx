import { useGame } from '../game/game'

/** The one line of help along the bottom in photo mode, until H hides it. */
export function PhotoHint() {
  const shown = useGame(state => state.photo && state.photoHint)
  if (!shown) return null
  return (
    <p className="bg-ink/55 text-marking/90 pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-1 text-sm whitespace-nowrap">
      Photo mode · WASD to move · Drag to look · Q E down and up · Shift faster · Scroll to zoom · H
      hides this · ` returns
    </p>
  )
}
