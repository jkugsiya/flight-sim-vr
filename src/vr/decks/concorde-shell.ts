import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  type Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  Vector3
} from 'three'
import { type Deck, MATERIALS, type Panel } from '../deck'

/*
 * Cabin shell pieces shared by the Concorde and Shuttle decks. A wall is a four-cornered
 * surface between points you name, so the windscreen, the side windows, and the roof meet
 * at shared corners with no gap between them. Windows are holes cut in the wall's own
 * coordinates: `s` from its left edge to its right, `t` from its bottom edge to its top.
 */

/** Corners as seen from inside: bottom left, bottom right, top right, top left. */
export type Corners = [Vector3, Vector3, Vector3, Vector3]
/** A window hole: from `s0`, `t0` to `s1`, `t1`, each 0 to 1 across the wall. */
export type Hole = [s0: number, t0: number, s1: number, t1: number]

/** A cabin lining seen from both sides, for walls and frames. Disposed with the deck. */
export function lining(color: number, emissive: number) {
  return new MeshStandardMaterial({ color, emissive, roughness: 0.9, side: DoubleSide })
}

/** The point at `s`, `t` on the surface between the corners. */
function bilinear([bl, br, tr, tl]: Corners, s: number, t: number, out: Vector3) {
  const bx = bl.x + (br.x - bl.x) * s
  const by = bl.y + (br.y - bl.y) * s
  const bz = bl.z + (br.z - bl.z) * s
  const tx = tl.x + (tr.x - tl.x) * s
  const ty = tl.y + (tr.y - tl.y) * s
  const tz = tl.z + (tr.z - tl.z) * s
  return out.set(bx + (tx - bx) * t, by + (ty - by) * t, bz + (tz - bz) * t)
}

/** Appends the quad from `s0`, `t0` to `s1`, `t1` as two triangles facing inside. */
function quad(corners: Corners, s0: number, t0: number, s1: number, t1: number, out: number[]) {
  const p = [
    bilinear(corners, s0, t0, new Vector3()),
    bilinear(corners, s1, t0, new Vector3()),
    bilinear(corners, s1, t1, new Vector3()),
    bilinear(corners, s0, t1, new Vector3())
  ]
  for (const i of [0, 1, 2, 0, 2, 3]) out.push(p[i].x, p[i].y, p[i].z)
}

function meshOf(positions: number[], material: Material) {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return new Mesh(geometry, material)
}

/**
 * A wall between four corners with window holes cut in it, as one mesh, plus a pane of
 * glass in each hole. Cells between hole edges are merged along each row.
 */
export function wall(
  parent: Group,
  corners: Corners,
  holes: Hole[],
  material: Material,
  glass: Material | null = MATERIALS.glass
) {
  const ss = [...new Set([0, 1, ...holes.flatMap(([s0, , s1]) => [s0, s1])])].sort((a, b) => a - b)
  const ts = [...new Set([0, 1, ...holes.flatMap(([, t0, , t1]) => [t0, t1])])].sort(
    (a, b) => a - b
  )
  const inHole = (s: number, t: number) =>
    holes.some(([s0, t0, s1, t1]) => s > s0 && s < s1 && t > t0 && t < t1)
  const positions: number[] = []
  for (let j = 0; j < ts.length - 1; j++) {
    const t0 = ts[j]
    const t1 = ts[j + 1]
    let start = -1
    for (let i = 0; i <= ss.length - 1; i++) {
      const solid = i < ss.length - 1 && !inHole((ss[i] + ss[i + 1]) / 2, (t0 + t1) / 2)
      if (solid && start < 0) start = i
      if (!solid && start >= 0) {
        quad(corners, ss[start], t0, ss[i], t1, positions)
        start = -1
      }
    }
  }
  const frame = meshOf(positions, material)
  parent.add(frame)
  if (glass && holes.length > 0) {
    const panes: number[] = []
    for (const [s0, t0, s1, t1] of holes) quad(corners, s0, t0, s1, t1, panes)
    parent.add(meshOf(panes, glass))
  }
  return frame
}

/** Shorthand for a corner point. */
export const p = (x: number, y: number, z: number) => new Vector3(x, y, z)

/** Corners mirrored across the centreline at `cl`, still listed as seen from inside. */
export function mirror([bl, br, tr, tl]: Corners, cl: number): Corners {
  const m = (v: Vector3) => new Vector3(2 * cl - v.x, v.y, v.z)
  return [m(br), m(bl), m(tl), m(tr)]
}

/** Holes mirrored left to right, to match `mirror`. */
export const mirrorHoles = (holes: Hole[]): Hole[] =>
  holes.map(([s0, t0, s1, t1]) => [1 - s1, t0, 1 - s0, t1])

/**
 * A field of painted gauges, switches, and breakers, drawn once: for panels that are there
 * to be seen, such as a flight engineer's wall or a circuit breaker panel.
 */
export function gaugeField(options: {
  title?: string
  rows: number
  columns: number
  kind: 'gauges' | 'switches' | 'breakers'
  seed?: number
}) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const { rows, columns, kind, title } = options
    let seed = options.seed ?? 7
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    ctx.fillStyle = '#2b3036'
    ctx.fillRect(0, 0, w, h)
    const top = title ? h * 0.08 : 0
    if (title) {
      ctx.fillStyle = '#e8e8e2'
      ctx.font = `700 ${h * 0.05}px Arial Narrow, system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(title, w / 2, top / 2)
    }
    const cw = w / columns
    const ch = (h - top) / rows
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const x = cw * (c + 0.5)
        const y = top + ch * (r + 0.5)
        if (kind === 'gauges') {
          const radius = Math.min(cw, ch) * 0.38
          ctx.fillStyle = '#0d0e10'
          ctx.beginPath()
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = '#d8d8d2'
          ctx.lineWidth = Math.max(1, radius * 0.05)
          for (let k = 0; k <= 8; k++) {
            const a = Math.PI * (0.75 + k * 0.1875)
            ctx.beginPath()
            ctx.moveTo(x + Math.cos(a) * radius * 0.78, y + Math.sin(a) * radius * 0.78)
            ctx.lineTo(x + Math.cos(a) * radius * 0.92, y + Math.sin(a) * radius * 0.92)
            ctx.stroke()
          }
          const a = Math.PI * (0.75 + random() * 1.5)
          ctx.strokeStyle = '#f2f2ea'
          ctx.lineWidth = Math.max(1.5, radius * 0.08)
          ctx.beginPath()
          ctx.moveTo(x, y)
          ctx.lineTo(x + Math.cos(a) * radius * 0.75, y + Math.sin(a) * radius * 0.75)
          ctx.stroke()
        } else if (kind === 'switches') {
          ctx.fillStyle = '#16181a'
          ctx.fillRect(x - cw * 0.12, y - ch * 0.18, cw * 0.24, ch * 0.36)
          ctx.fillStyle = '#c9c9c2'
          const up = random() > 0.4
          ctx.fillRect(x - cw * 0.05, y + (up ? -ch * 0.3 : 0), cw * 0.1, ch * 0.3)
          ctx.fillStyle = '#d8d8d2'
          ctx.font = `600 ${ch * 0.16}px Arial Narrow, system-ui, sans-serif`
          ctx.fillText(String(r * columns + c + 1), x, y + ch * 0.38)
        } else {
          ctx.fillStyle = '#111214'
          ctx.beginPath()
          ctx.arc(x, y, Math.min(cw, ch) * 0.28, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = random() > 0.93 ? '#e8e8e2' : '#3b3f44'
          ctx.beginPath()
          ctx.arc(x, y, Math.min(cw, ch) * 0.14, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }
}

/** A panel finish, lit a little from within as daylight lights a flight deck. */
export function finish(color: number, emissive: number) {
  return new MeshStandardMaterial({ color, emissive, roughness: 0.85 })
}

/**
 * A screen on a panel, lifted clear of its bezel. The kit draws the screen flush with the
 * bezel's front face, so the two flicker against each other when seen at a slant.
 */
export function screen(
  deck: Deck,
  panel: Panel,
  u: number,
  v: number,
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  hz?: number,
  pixelsPerMetre?: number
) {
  const display = deck.screen(panel, u, v, width, height, paint, hz, pixelsPerMetre)
  display.mesh.position.copy(panel.at(u, v, 0.0045))
  return display
}
