import { useFrame } from '@react-three/fiber'
import { useMemo } from 'react'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  type Deck,
  fromStrip,
  HELIPADS,
  HOSPITAL,
  PLATFORM,
  RESCUE_SHIP,
  type Strip,
  type Structure
} from '../world/island'
import { nightUniform } from './atmosphere'
import { useDisposal } from './dispose'
import { type Light, lightMaterial, pointsGeometry, type Rgb } from './lightPoints'
import { depthBias } from './logDepth'
import { painted } from './Scenery'

const UP = new Vector3(0, 1, 0)
const radians = (degrees: number) => (degrees * Math.PI) / 180

/** Position and axes a part is laid out on: a structure, or one of its decks. */
type Frame = { x: number; z: number; heading: number }

/** World point at distances along and across a frame's axes, `y` metres above sea level. */
function at(frame: Frame, along: number, across: number, y: number) {
  const spot = fromStrip({ ...frame, length: 0, width: 0 }, along, across)
  return new Vector3(spot.x, y, spot.z)
}

/**
 * Turns a part built on its own axes, with the bow along -Z and the right side along +X,
 * to face the frame's heading, and moves its origin to a point on the frame.
 */
function put(geometry: BufferGeometry, frame: Frame, along: number, across: number, y: number) {
  const spot = at(frame, along, across, y)
  return geometry.rotateY(-radians(frame.heading)).translate(spot.x, spot.y, spot.z)
}

/** Painted box from `base` to `top`, `length` along the frame and `width` across it. */
function block(
  frame: Frame,
  along: number,
  across: number,
  [length, width]: [number, number],
  [base, top]: [number, number],
  color: string
) {
  const box = new BoxGeometry(width, top - base, length)
  return painted(put(box, frame, along, across, (base + top) / 2), color)
}

/** Painted upright cylinder from `base` to `top`, narrowing to `topRadius`. */
function column(
  frame: Frame,
  along: number,
  across: number,
  [radius, topRadius]: [number, number],
  [base, top]: [number, number],
  color: string,
  sides = 8
) {
  const cylinder = new CylinderGeometry(topRadius, radius, top - base, sides)
  return painted(put(cylinder, frame, along, across, (base + top) / 2), color)
}

const turn = new Quaternion()
const direction = new Vector3()

/** Painted round bar between two world points, for braces and struts. */
function beam(from: Vector3, to: Vector3, radius: number, color: string) {
  const bar = new CylinderGeometry(radius, radius, from.distanceTo(to), 6, 1, true)
  bar.applyQuaternion(turn.setFromUnitVectors(UP, direction.subVectors(to, from).normalize()))
  bar.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2)
  return painted(bar, color)
}

/** The deck of a structure with this part name. */
function deckOf(structure: Structure, part: Deck['part']) {
  const deck = structure.decks.find(candidate => candidate.part === part)
  if (!deck) throw new Error(`${structure.name} has no ${part} deck to draw`)
  return deck
}

const HELIDECK = '#3e4944'
const STRUT = '#9aa0a3'
const SAFETY_ORANGE = '#f28c1c'

/** Hull, bridge, mast, and raised helideck of the rescue ship. */
function shipParts(ship: Structure) {
  const parts: BufferGeometry[] = []
  const hull = deckOf(ship, 'hull')
  // Two bands of hull: dark antifouling below the waterline, rescue red above it
  for (const [bottom, top, color] of [
    [-2.5, 1, '#2b2f35'],
    [1, hull.top, '#c4462d']
  ] as const) {
    const box = new BoxGeometry(hull.width, top - bottom, 92, 1, 1, 12)
    const position = box.getAttribute('position')
    for (let i = 0; i < position.count; i++) {
      const along = -position.getZ(i)
      // The bow narrows to a point over its last 16 m, and the hull tucks in under the water
      const bow = along > 30 ? 1 - ((along - 30) / 16) ** 1.4 * 0.88 : 1
      const keel = position.getY(i) < 0 && bottom < 0 ? 0.8 : 1
      position.setX(i, position.getX(i) * bow * keel)
    }
    box.computeVertexNormals()
    parts.push(painted(put(box, ship, 0, 0, (bottom + top) / 2), color))
  }
  parts.push(
    block(hull, 0, 0, [hull.length, hull.width - 0.6], [hull.top - 0.1, hull.top + 0.04], '#5d6a62')
  )

  const bridge = deckOf(ship, 'bridge')
  parts.push(
    block(bridge, 0, 0, [bridge.length, bridge.width], [bridge.base, bridge.top], '#eef0ec')
  )
  parts.push(
    block(
      bridge,
      0,
      0,
      [bridge.length + 0.3, bridge.width + 0.3],
      [bridge.top - 3, bridge.top - 1.4],
      '#1f2b35'
    )
  )
  // Lifeboats hang on each side of the bridge, and a rescue boat waits on the aft deck
  for (const side of [-1, 1]) {
    parts.push(
      block(
        bridge,
        -5,
        side * (bridge.width / 2 + 1.1),
        [7, 2.2],
        [bridge.base + 2, bridge.base + 4.2],
        SAFETY_ORANGE
      )
    )
  }
  parts.push(block(ship, -10, -4, [6.5, 2.6], [hull.top, hull.top + 1.1], SAFETY_ORANGE))

  for (const post of ship.posts) {
    const mast = { ...post, heading: ship.heading }
    parts.push(
      column(mast, 0, 0, [post.radius * 0.55, post.radius * 0.4], [post.base, post.top], '#d9dcdc')
    )
    // The yard across the mast carries the radar and signal lamps
    parts.push(block(mast, 0, 0, [0.3, 6], [post.top - 2.6, post.top - 2.3], '#d9dcdc'))
  }

  const deck = deckOf(ship, 'helideck')
  parts.push(block(deck, 0, 0, [deck.length, deck.width], [deck.top - 1, deck.top], HELIDECK))
  for (const along of [-11, 0, 11]) {
    for (const across of [-6.5, 6.5]) {
      parts.push(column(deck, along, across, [0.3, 0.3], [deck.base, deck.top - 1], STRUT, 6))
    }
  }
  return parts
}

/** Legs and bracing, decks, modules, derrick, flare stack, and the overhanging helideck. */
function platformParts(platform: Structure) {
  const parts: BufferGeometry[] = []
  const LEG = '#d8a31d'
  const legs = platform.posts.filter(post => post.part === 'leg')
  for (const leg of legs) {
    parts.push(
      column({ ...leg, heading: 0 }, 0, 0, [leg.radius, leg.radius], [-3, leg.top], LEG, 10)
    )
  }
  // Each face of the jacket: rails at three levels and crossed braces between them
  const levels = [2, 12, 21]
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i]
      const b = legs[j]
      // Only neighbouring legs share a face, not the diagonal pairs
      if (Math.hypot(a.x - b.x, a.z - b.z) > 31) continue
      const point = (leg: typeof a, y: number) => new Vector3(leg.x, y, leg.z)
      levels.forEach((y, k) => {
        parts.push(beam(point(a, y), point(b, y), 0.45, LEG))
        if (k === 0) return
        parts.push(beam(point(a, levels[k - 1]), point(b, y), 0.4, LEG))
        parts.push(beam(point(b, levels[k - 1]), point(a, y), 0.4, LEG))
      })
    }
  }

  const deck = deckOf(platform, 'deck')
  parts.push(block(deck, 0, 0, [deck.length, deck.width], [deck.base, deck.top], '#6f7579'))
  const module = deckOf(platform, 'module')
  parts.push(
    block(module, 0, 0, [module.length, module.width], [module.base, module.top], '#c7cbce')
  )
  const quarters = deckOf(platform, 'quarters')
  parts.push(
    block(
      quarters,
      0,
      0,
      [quarters.length, quarters.width],
      [quarters.base, quarters.top],
      '#ecebe5'
    )
  )
  parts.push(
    block(
      quarters,
      0,
      0,
      [quarters.length + 0.3, quarters.width + 0.3],
      [quarters.base + 3, quarters.base + 4.4],
      '#26313a'
    )
  )

  for (const part of platform.posts) {
    const post = { ...part, heading: platform.heading }
    if (post.part === 'derrick') {
      // A square tower that tapers to its crown
      const tower = new CylinderGeometry(1.4, post.radius, post.top - post.base - 2, 4).rotateY(
        Math.PI / 4
      )
      parts.push(painted(put(tower, post, 0, 0, (post.base + post.top - 2) / 2), '#d2d5d6'))
      parts.push(block(post, 0, 0, [3.2, 3.2], [post.top - 2, post.top], '#b3261e'))
    } else if (post.part === 'flare') {
      parts.push(
        column(post, 0, 0, [post.radius, post.radius * 0.75], [post.base, post.top], '#8c9195')
      )
    }
  }

  const helideck = deckOf(platform, 'helideck')
  parts.push(
    block(
      helideck,
      0,
      0,
      [helideck.length, helideck.width],
      [helideck.top - 1.2, helideck.top],
      HELIDECK
    )
  )
  // Short posts on the quarters roof, and struts from the end of the main deck under the overhang
  for (const along of [-6, 2]) {
    for (const across of [-9, 9]) {
      const post = { ...at(helideck, along, across, 0), heading: 0 }
      parts.push(column(post, 0, 0, [0.35, 0.35], [helideck.base, helideck.top - 1.2], STRUT, 6))
    }
  }
  const end = -deck.length / 2
  for (const across of [-11, 0, 11]) {
    parts.push(
      beam(
        at(platform, end, across, deck.base + 1),
        at(platform, end - 13, across, helideck.top - 1.2),
        0.35,
        STRUT
      )
    )
  }
  return parts
}

/** Grey roofs on the hospital's tower and wing, and the red canopy over the ambulance bay. */
function hospitalParts(hospital: Structure) {
  const parts: BufferGeometry[] = []
  for (const deck of hospital.decks) {
    // A little inside the walls, so the roof's edges never flicker against them
    parts.push(
      block(
        deck,
        0,
        0,
        [deck.length - 0.1, deck.width - 0.1],
        [deck.top - 0.3, deck.top],
        '#a2a5a7'
      )
    )
  }
  const wing = deckOf(hospital, 'wing')
  parts.push(
    block(wing, 0, wing.width / 2 + 3, [12, 6], [wing.base + 4, wing.base + 4.5], '#cf3a2e')
  )
  for (const along of [-5.5, 5.5]) {
    parts.push(
      column(
        wing,
        along,
        wing.width / 2 + 5.5,
        [0.2, 0.2],
        [wing.base, wing.base + 4],
        '#d9dcdc',
        6
      )
    )
  }
  return parts
}

/** Builds flat textured quads into one geometry. */
function quadBuilder() {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const edgeA = new Vector3()
  const edgeB = new Vector3()
  return {
    /** Adds a quad from its four corners in order round its edge, facing `normal`. */
    add(corners: Vector3[], uv: [number, number][], normal: Vector3) {
      edgeA.subVectors(corners[1], corners[0])
      edgeB.subVectors(corners[2], corners[0])
      // Wind the triangles so their front faces point along the normal
      const order = edgeA.cross(edgeB).dot(normal) > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]
      for (const k of order) {
        positions.push(corners[k].x, corners[k].y, corners[k].z)
        normals.push(normal.x, normal.y, normal.z)
        uvs.push(...uv[k])
      }
    },
    build() {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2))
      return geometry
    }
  }
}

type Quads = ReturnType<typeof quadBuilder>

/** One wall of a deck, by the direction it faces, with its outward normal and right-hand side. */
function wall(deck: Strip, side: 'front' | 'back' | 'left' | 'right') {
  const along = new Vector3(Math.sin(radians(deck.heading)), 0, -Math.cos(radians(deck.heading)))
  const across = new Vector3(Math.cos(radians(deck.heading)), 0, Math.sin(radians(deck.heading)))
  const sign = side === 'front' || side === 'right' ? 1 : -1
  const lengthwise = side === 'front' || side === 'back'
  const normal = (lengthwise ? along : across).clone().multiplyScalar(sign)
  const reach = lengthwise ? deck.length / 2 : deck.width / 2
  const centre = new Vector3(deck.x, 0, deck.z).addScaledVector(normal, reach)
  // Seen from outside, the wall's right-hand side
  const right = new Vector3(normal.z, 0, -normal.x)
  return { normal, centre, right, span: lengthwise ? deck.width : deck.length }
}

/** Adds a flat rectangle `width` by `height` on a wall, centred at `y`, with a texture window. */
function onWall(
  quads: Quads,
  face: ReturnType<typeof wall>,
  [width, height]: [number, number],
  y: number,
  [u0, v0, u1, v1]: [number, number, number, number],
  lift = 0
) {
  const middle = face.centre.clone().addScaledVector(face.normal, lift)
  const corner = (side: number, rise: number) =>
    middle
      .clone()
      .addScaledVector(face.right, (side * width) / 2)
      .setY(y + (rise * height) / 2)
  quads.add(
    [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1]
    ],
    face.normal
  )
}

// One wall tile covers four window bays across and four floors up
const TILE_WIDTH = 14
const TILE_HEIGHT = 14.4

/** Hospital walls in white render with ribbon windows, as a colour tile and a lit-at-night tile. */
function wallTextures() {
  const draw = (lit: boolean) => {
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Hospital walls need a 2D canvas, which this browser refused')
    ctx.fillStyle = lit ? '#000000' : '#f1efe9'
    ctx.fillRect(0, 0, 128, 128)
    for (let floor = 0; floor < 4; floor++) {
      // A band of glass across every floor, split by mullions at each bay
      ctx.fillStyle = lit ? (floor === 2 ? '#6a5a40' : '#ffe2b0') : '#7d95a6'
      ctx.fillRect(0, floor * 32 + 10, 128, 15)
      ctx.fillStyle = lit ? '#000000' : '#dfe3e5'
      for (let bay = 0; bay < 4; bay++) ctx.fillRect(bay * 32, floor * 32 + 10, 3, 15)
    }
    const texture = new CanvasTexture(canvas)
    texture.colorSpace = SRGBColorSpace
    texture.wrapS = RepeatWrapping
    texture.wrapT = RepeatWrapping
    texture.anisotropy = 8
    return texture
  }
  return { color: draw(false), lit: draw(true) }
}

/** Red cross on a white panel in the left quarter, and the word HOSPITAL to its right. */
function signTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Hospital signs need a 2D canvas, which this browser refused')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1024, 256)
  ctx.fillStyle = '#d42a20'
  ctx.fillRect(98, 24, 60, 208)
  ctx.fillRect(24, 98, 208, 60)
  ctx.font = 'bold 170px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('HOSPITAL', 640, 136, 740)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/** Hospital walls with their window tiles, and the cross and name signs on them. */
function hospitalFacades(hospital: Structure) {
  const walls = quadBuilder()
  const signs = quadBuilder()
  for (const deck of hospital.decks) {
    for (const side of ['front', 'back', 'left', 'right'] as const) {
      const face = wall(deck, side)
      const height = deck.top - deck.base
      onWall(walls, face, [face.span, height], (deck.base + deck.top) / 2, [
        0,
        0,
        face.span / TILE_WIDTH,
        height / TILE_HEIGHT
      ])
      if (deck.part === 'tower') {
        onWall(signs, face, [8, 8], deck.top - 6, [0, 0, 0.25, 1], 0.15)
      } else if (side === 'front' || side === 'left') {
        // The name faces the sea to the north and the end of the city to the east
        onWall(signs, face, [18, 6], deck.top - 4, [0.25, 0, 1, 1], 0.15)
      }
    }
  }
  return { walls: walls.build(), signs: signs.build() }
}

/** A pad seen from above: grey surface, white edge, yellow circle, and a white H. */
function padTexture() {
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Helipad markings need a 2D canvas, which this browser refused')
  ctx.fillStyle = '#4b5156'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = '#f1f1ec'
  ctx.lineWidth = size * 0.03
  ctx.strokeRect(size * 0.03, size * 0.03, size * 0.94, size * 0.94)
  // The circle is two thirds as wide as the square
  ctx.strokeStyle = '#f2c230'
  ctx.lineWidth = size * 0.05
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 3 - size * 0.025, 0, Math.PI * 2)
  ctx.stroke()
  // The H reads upright when you fly in along the pad's heading
  const tall = size * 0.36
  const wide = size * 0.24
  const stroke = size * 0.065
  ctx.fillStyle = '#f7f7f2'
  ctx.fillRect(size / 2 - wide / 2, size / 2 - tall / 2, stroke, tall)
  ctx.fillRect(size / 2 + wide / 2 - stroke, size / 2 - tall / 2, stroke, tall)
  ctx.fillRect(size / 2 - wide / 2, size / 2 - stroke / 2, wide, stroke)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 16
  return texture
}

/** The marked square of every helipad, a few centimetres above its deck or the ground. */
function padGeometry() {
  const quads = quadBuilder()
  for (const pad of HELIPADS) {
    const y = pad.elevation + (pad.kind === 'ground' ? 0.1 : 0.03)
    const corner = (along: number, across: number) =>
      at(pad, along * pad.radius, across * pad.radius, y)
    // The texture's top edge lies ahead along the heading, so the H stands upright
    quads.add(
      [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)],
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1]
      ],
      UP
    )
  }
  return quads.build()
}

const GREEN: Rgb = [0.1, 1, 0.3]
const RED: Rgb = [1, 0.15, 0.1]
const WHITE: Rgb = [1, 1, 1]
const FLAME: Rgb = [1, 0.62, 0.25]
const LAMP: Rgb = [1, 0.84, 0.6]

/**
 * Green lights every 4 m or so round each marked square, red warnings on the high points,
 * anchor lights on the ship, and the flare's glow. They show by day too.
 */
function padLights() {
  const lights: Light[] = []
  for (const pad of HELIPADS) {
    const side = pad.radius * 2
    const steps = Math.max(4, Math.round(side / 4))
    for (let step = 0; step < steps; step++) {
      const t = -1 + (2 * step) / steps
      for (const [along, across] of [
        [t, -1],
        [1, t],
        [-t, 1],
        [-1, -t]
      ]) {
        const spot = at(pad, along * pad.radius, across * pad.radius, pad.elevation + 0.3)
        lights.push({ ...spot, color: GREEN })
      }
    }
  }
  const tower = deckOf(HOSPITAL, 'tower')
  for (const along of [-1, 1]) {
    for (const across of [-1, 1]) {
      const spot = at(
        tower,
        (along * tower.length) / 2,
        (across * tower.width) / 2,
        tower.top + 0.6
      )
      lights.push({ ...spot, color: RED })
    }
  }
  for (const post of [...RESCUE_SHIP.posts, ...PLATFORM.posts]) {
    if (post.part === 'leg') continue
    const color = post.part === 'flare' ? FLAME : RED
    lights.push({ x: post.x, y: post.top + (post.part === 'flare' ? 2.5 : 0.4), z: post.z, color })
  }
  lights.push({ ...at(RESCUE_SHIP, 45, 0, 9), color: WHITE })
  lights.push({ ...at(RESCUE_SHIP, -46, 0, 13), color: WHITE })
  return lights
}

/** Warm lamps every 5 m or so round the walls of a deck, `rise` metres above its base. */
function lampsRound(lights: Light[], deck: Deck, rise: number) {
  for (const side of ['front', 'back', 'left', 'right'] as const) {
    const face = wall(deck, side)
    const steps = Math.max(1, Math.round(face.span / 5))
    for (let step = 0; step <= steps; step++) {
      const spot = face.centre
        .clone()
        .addScaledVector(face.normal, 0.3)
        .addScaledVector(face.right, (step / steps - 0.5) * face.span)
      lights.push({ x: spot.x, y: deck.base + rise, z: spot.z, color: LAMP })
    }
  }
}

/** Lit bridge windows and deck lamps on the ship, and the work lights of the platform. */
function workLights() {
  const lights: Light[] = []
  lampsRound(lights, deckOf(RESCUE_SHIP, 'bridge'), 7.8)
  lampsRound(lights, deckOf(RESCUE_SHIP, 'hull'), 8.5)
  lampsRound(lights, deckOf(PLATFORM, 'deck'), 6)
  lampsRound(lights, deckOf(PLATFORM, 'module'), 6.5)
  lampsRound(lights, deckOf(PLATFORM, 'quarters'), 3.7)
  return lights
}

/**
 * Coral Bay Hospital with its rooftop pad, the rescue ship at anchor, the gas platform, and
 * the marked pads at every airport, with their lights. Seven draw calls in all.
 */
export function Helipads() {
  const built = useMemo(() => {
    const structure = new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 })
    const tiles = wallTextures()
    const facade = new MeshStandardMaterial({
      map: tiles.color,
      emissiveMap: tiles.lit,
      emissive: '#ffffff',
      emissiveIntensity: 0,
      roughness: 0.8
    })
    const sign = signTexture()
    const signs = new MeshStandardMaterial({
      map: sign,
      emissiveMap: sign,
      emissive: '#ffffff',
      emissiveIntensity: 0,
      roughness: 0.6
    })
    const markings = padTexture()
    const pads = new MeshStandardMaterial({
      map: markings,
      emissiveMap: markings,
      emissive: '#ffffff',
      emissiveIntensity: 0,
      roughness: 0.9,
      ...depthBias(0.0008)
    })
    const flare = PLATFORM.posts.find(post => post.part === 'flare')
    const flame = new ConeGeometry(1.3, 6, 8).translate(0, 3, 0)
    if (flare) flame.translate(flare.x, flare.top, flare.z)
    return {
      structures: mergeGeometries([
        ...shipParts(RESCUE_SHIP),
        ...platformParts(PLATFORM),
        ...hospitalParts(HOSPITAL)
      ]),
      structure,
      ...hospitalFacades(HOSPITAL),
      facade,
      signMaterial: signs,
      pads: padGeometry(),
      padMaterial: pads,
      lights: pointsGeometry(padLights()),
      lightMaterial: lightMaterial(0.7),
      work: pointsGeometry(workLights()),
      workMaterial: lightMaterial(0.8, true),
      flame,
      flameMaterial: new MeshBasicMaterial({ color: '#ffa648', transparent: true, opacity: 0.85 })
    }
  }, [])
  useDisposal(built)

  useFrame(({ clock }) => {
    const night = nightUniform.value
    // Windows, signs, and floodlit pads glow after dark
    built.facade.emissiveIntensity = night * 0.9
    built.signMaterial.emissiveIntensity = night * 0.8
    built.padMaterial.emissiveIntensity = night * 0.22
    built.workMaterial.visible = night > 0.01
    const time = clock.elapsedTime
    built.flameMaterial.opacity = 0.85 + Math.sin(time * 13) * 0.08 + Math.sin(time * 7.3) * 0.06
  })

  return (
    <>
      <mesh geometry={built.structures} material={built.structure} castShadow receiveShadow />
      <mesh geometry={built.walls} material={built.facade} castShadow receiveShadow />
      <mesh geometry={built.signs} material={built.signMaterial} />
      <mesh geometry={built.pads} material={built.padMaterial} receiveShadow />
      <mesh geometry={built.flame} material={built.flameMaterial} />
      <points geometry={built.lights} material={built.lightMaterial} frustumCulled={false} />
      <points geometry={built.work} material={built.workMaterial} frustumCulled={false} />
    </>
  )
}
