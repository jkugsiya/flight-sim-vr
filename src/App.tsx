import { useEffect } from 'react'
import { game, useGame } from './game/game'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Menu } from './ui/Menu'
import { VRButton } from './vr/VRButton'

export function App() {
  useEffect(() => game.attach(), [])
  // In VR the cockpit and the tablet replace the page's instruments and menus
  const vr = useGame(state => state.vr)
  return (
    <main className="relative h-full font-sans select-none">
      <Scene />
      {!vr && <Hud />}
      {!vr && <Menu />}
      <VRButton />
    </main>
  )
}
