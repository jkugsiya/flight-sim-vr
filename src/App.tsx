import { useEffect } from 'react'
import { game } from './game/game'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Menu } from './ui/Menu'

export function App() {
  useEffect(() => game.attach(), [])
  return (
    <main className="relative h-full font-sans select-none">
      <Scene />
      <Hud />
      <Menu />
    </main>
  )
}
