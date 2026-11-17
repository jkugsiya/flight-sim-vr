import { useEffect } from 'react'
import { game, useGame } from './game/game'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Menu } from './ui/Menu'
import { PhotoHint } from './ui/PhotoHint'
import { VRButton } from './vr/VRButton'

export function App() {
  useEffect(() => game.attach(), [])
  // Photo mode hides the panels without unmounting them, so they come back as they were.
  // In VR the cockpit and the tablet replace the page's instruments and menus.
  const photo = useGame(state => state.photo)
  const vr = useGame(state => state.vr)
  return (
    <main className="relative h-full font-sans select-none">
      <Scene />
      {!vr && (
        <div className={photo ? 'hidden' : 'contents'}>
          <Hud />
        </div>
      )}
      <PhotoHint />
      {!vr && <Menu />}
      <VRButton />
    </main>
  )
}
