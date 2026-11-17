import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  TorusGeometry
} from 'three'
import type { GaugeSpec } from '../sim/aircraft'

/**
 * Round cockpit instruments, built the way real-time simulators build them: a face printed
 * once into a texture, and needles and cards that move as meshes. Nothing is repainted per
 * frame, which keeps the headset's frame rate. Each instrument faces +Z, toward the pilot.
 */

const WHITE = '#f2f2ee'
const GREEN = '#2fb34a'
const YELLOW = '#f2c014'
const RED = '#e3261b'
const FACE = '#0d0e10'
const FONT = 'Arial Narrow, Roboto Condensed, system-ui, sans-serif'
const DEG = Math.PI / 180

/** Dial degrees, clockwise from twelve o'clock, to canvas radians. */
const canvasAngle = (degrees: number) => (degrees - 90) * DEG

/** Draws on a square canvas and returns it as a texture. */
function paint(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The browser gave no 2D canvas, so the instrument faces cannot draw')
  draw(ctx, size)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Tools for printing a round dial face; `s` is the canvas size in pixels. */
function dialTools(ctx: CanvasRenderingContext2D, s: number) {
  const c = s / 2
  const r = s * 0.47
  return {
    c,
    r,
    ticks(from: number, to: number, step: number, inner: number, width: number, color = WHITE) {
      ctx.strokeStyle = color
      ctx.lineWidth = s * width
      for (let a = from; a <= to + 1e-6; a += step) {
        const t = canvasAngle(a)
        ctx.beginPath()
        ctx.moveTo(c + Math.cos(t) * r * inner, c + Math.sin(t) * r * inner)
        ctx.lineTo(c + Math.cos(t) * r * 0.97, c + Math.sin(t) * r * 0.97)
        ctx.stroke()
      }
    },
    arc(from: number, to: number, radius: number, width: number, color: string) {
      ctx.strokeStyle = color
      ctx.lineWidth = s * width
      ctx.beginPath()
      ctx.arc(c, c, r * radius, canvasAngle(from), canvasAngle(to))
      ctx.stroke()
    },
    label(text: string, angle: number, radius: number, size: number, color = WHITE) {
      const t = canvasAngle(angle)
      ctx.fillStyle = color
      ctx.font = `700 ${s * size}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, c + Math.cos(t) * r * radius, c + Math.sin(t) * r * radius)
    },
    text(text: string, x: number, y: number, size: number, color = WHITE) {
      ctx.fillStyle = color
      ctx.font = `700 ${s * size}px ${FONT}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, s * x, s * y)
    },
    background() {
      ctx.fillStyle = FACE
      ctx.beginPath()
      ctx.arc(c, c, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

const BEZEL = new MeshStandardMaterial({ color: 0x141517, roughness: 0.5, metalness: 0.3 })
const NEEDLE = new MeshBasicMaterial({ color: 0xf4f4f0, toneMapped: false })
const ORANGE = new MeshBasicMaterial({ color: 0xff8a1c, toneMapped: false })
/** Materials every instrument shares, which outlive any one cockpit. */
export const SHARED = new Set<Material>([BEZEL, NEEDLE, ORANGE])

/** A tapered needle along +Y from the pivot, with a short tail behind it. */
function needleGeometry(length: number, width: number, tail = length * 0.18) {
  const shape = new Shape()
  shape.moveTo(-width / 2, -tail)
  shape.lineTo(width / 2, -tail)
  shape.lineTo(width * 0.35, length * 0.8)
  shape.lineTo(0, length)
  shape.lineTo(-width * 0.35, length * 0.8)
  shape.closePath()
  return new ShapeGeometry(shape)
}

/** A round instrument: bezel, printed face, and whatever moves in front of it. */
export abstract class Instrument {
  readonly group = new Group()
  private readonly textures: Texture[] = []

  constructor(readonly diameter: number) {
    const bezel = new Mesh(new TorusGeometry(diameter / 2, diameter * 0.045, 8, 32), BEZEL)
    bezel.position.z = 0.004
    this.group.add(bezel)
  }

  /** Called every frame with the seconds since the last. */
  abstract update(dt: number): void

  protected face(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 256, z = 0) {
    const texture = paint(size, draw)
    this.textures.push(texture)
    const mesh = new Mesh(
      new CircleGeometry(this.diameter / 2, 40),
      new MeshBasicMaterial({ map: texture, toneMapped: false, transparent: z > 0 })
    )
    mesh.position.z = z
    this.group.add(mesh)
    return mesh
  }

  protected needle(length: number, width: number, z: number, material = NEEDLE, tail?: number) {
    const mesh = new Mesh(needleGeometry(length, width, tail), material)
    mesh.position.z = z
    this.group.add(mesh)
    return mesh
  }

  /** The cap over the needle pivot. */
  protected hub(z: number) {
    const hub = new Mesh(new CircleGeometry(this.diameter * 0.05, 16), BEZEL)
    hub.position.z = z
    this.group.add(hub)
  }

  dispose() {
    for (const texture of this.textures) texture.dispose()
    this.group.traverse(object => {
      if (!(object instanceof Mesh)) return
      object.geometry.dispose()
      const material = object.material as Material
      if (!SHARED.has(material)) material.dispose()
    })
  }
}

/** Points a needle at dial degrees, clockwise from twelve o'clock. */
const point = (needle: Mesh, degrees: number) => {
  needle.rotation.z = -degrees * DEG
}

/** Airspeed in knots, with the flap (white), normal (green), and caution (yellow) arcs. */
export class AirspeedIndicator extends Instrument {
  private readonly hand: Mesh
  private shown = 0

  constructor(
    diameter: number,
    private readonly scale: GaugeSpec['airspeed'],
    private readonly knots: () => number
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
      const at = (k: number) => this.angle(k)
      if (scale.flapRange) d.arc(at(scale.flapRange[0]), at(scale.flapRange[1]), 0.72, 0.03, WHITE)
      d.arc(at(scale.normalRange[0]), at(scale.normalRange[1]), 0.8, 0.04, GREEN)
      d.arc(at(scale.cautionRange[0]), at(scale.cautionRange[1]), 0.8, 0.04, YELLOW)
      d.ticks(at(scale.cautionRange[1]), at(scale.cautionRange[1]), 1, 0.7, 0.014, RED)
      for (let k = scale.min; k <= scale.max; k += scale.tickEvery)
        d.ticks(at(k), at(k), 1, 0.86, 0.01)
      for (let k = scale.min + scale.labelEvery; k <= scale.max; k += scale.labelEvery) {
        d.label(String(k), at(k), 0.58, 0.1)
      }
      d.text('AIRSPEED', 0.5, 0.36, 0.055)
      d.text('KNOTS', 0.5, 0.66, 0.055)
    })
    this.hand = this.needle(diameter * 0.42, diameter * 0.045, 0.002)
    this.hub(0.003)
  }

  /** Below the scale's start the needle rests on a stop near twelve o'clock. */
  private angle(knots: number) {
    const { min, max } = this.scale
    return 12 + ((Math.min(Math.max(knots, min), max) - min) / (max - min)) * 330
  }

  update(dt: number) {
    // The airspeed needle settles in about a fifth of a second
    this.shown += (this.knots() - this.shown) * Math.min(1, dt * 5)
    point(this.hand, this.angle(this.shown))
  }
}

/**
 * Attitude indicator: a sky and ground card that tilts and slides behind a fixed orange
 * miniature aircraft, with a bank pointer against the bank scale at the top.
 */
export class AttitudeIndicator extends Instrument {
  private readonly card: Texture
  private readonly pointer: Mesh
  // Card texture height that one degree of pitch moves, as a share of the card
  private readonly perDegree = 1 / 100

  constructor(
    diameter: number,
    private readonly attitude: () => { pitch: number; bank: number }
  ) {
    super(diameter)
    const cardMesh = this.face((ctx, s) => {
      // Sky above ground, with pitch lines every 5 degrees up to 30 each way
      ctx.fillStyle = '#2f7fc6'
      ctx.fillRect(0, 0, s, s / 2)
      ctx.fillStyle = '#6b4424'
      ctx.fillRect(0, s / 2, s, s / 2)
      ctx.strokeStyle = WHITE
      ctx.lineWidth = s * 0.008
      ctx.beginPath()
      ctx.moveTo(0, s / 2)
      ctx.lineTo(s, s / 2)
      ctx.stroke()
      for (let deg = -30; deg <= 30; deg += 5) {
        if (deg === 0) continue
        const y = s / 2 - deg * s * this.perDegree
        const w = deg % 10 === 0 ? s * 0.16 : s * 0.08
        ctx.beginPath()
        ctx.moveTo(s / 2 - w, y)
        ctx.lineTo(s / 2 + w, y)
        ctx.stroke()
        if (deg % 10 === 0) {
          ctx.fillStyle = WHITE
          ctx.font = `700 ${s * 0.05}px ${FONT}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(Math.abs(deg)), s / 2 - w - s * 0.05, y)
          ctx.fillText(String(Math.abs(deg)), s / 2 + w + s * 0.05, y)
        }
      }
    }, 512)
    this.card = (cardMesh.material as MeshBasicMaterial).map as Texture
    this.card.center.set(0.5, 0.5)
    // The fixed bank scale and the miniature aircraft, printed on a transparent overlay
    this.face(
      (ctx, s) => {
        const d = dialTools(ctx, s)
        for (const a of [-60, -30, 30, 60]) d.ticks(a, a, 1, 0.82, 0.02)
        for (const a of [-45, -20, -10, 10, 20, 45]) d.ticks(a, a, 1, 0.88, 0.012)
        ctx.fillStyle = WHITE
        ctx.beginPath()
        ctx.moveTo(d.c, d.c - d.r * 0.8)
        ctx.lineTo(d.c - s * 0.03, d.c - d.r * 0.95)
        ctx.lineTo(d.c + s * 0.03, d.c - d.r * 0.95)
        ctx.fill()
        ctx.strokeStyle = '#ff8a1c'
        ctx.lineWidth = s * 0.03
        ctx.beginPath()
        ctx.moveTo(d.c - s * 0.3, d.c)
        ctx.lineTo(d.c - s * 0.08, d.c)
        ctx.lineTo(d.c, d.c + s * 0.06)
        ctx.lineTo(d.c + s * 0.08, d.c)
        ctx.lineTo(d.c + s * 0.3, d.c)
        ctx.stroke()
        ctx.fillStyle = '#ff8a1c'
        ctx.beginPath()
        ctx.arc(d.c, d.c, s * 0.02, 0, Math.PI * 2)
        ctx.fill()
      },
      256,
      0.003
    )
    this.pointer = new Mesh(
      new PlaneGeometry(diameter * 0.05, diameter * 0.06),
      new MeshBasicMaterial({ color: 0xff8a1c, toneMapped: false, side: DoubleSide })
    )
    this.pointer.geometry.translate(0, diameter * 0.32, 0)
    this.pointer.position.z = 0.002
    this.group.add(this.pointer)
  }

  update() {
    const { pitch, bank } = this.attitude()
    // The card turns against the bank and slides with the pitch, along its own up direction
    // A positive texture rotation turns the picture anticlockwise, as the horizon turns in
    // a right bank. The offset applies in the card's own axes, so the pitch slides the
    // horizon along the tilted card; a positive offset moves it down, as a raised nose does.
    this.card.rotation = bank
    this.card.offset.set(0, (pitch / DEG) * this.perDegree)
    // The bank pointer rides on the card
    this.pointer.rotation.z = bank
  }
}

/** Altimeter with hundreds, thousands, and ten-thousands hands, set to 29.92. */
export class Altimeter extends Instrument {
  private readonly hundreds: Mesh
  private readonly thousands: Mesh
  private readonly tenThousands: Mesh

  constructor(
    diameter: number,
    private readonly feet: () => number
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
      d.ticks(0, 358, 7.2, 0.9, 0.008)
      d.ticks(0, 324, 36, 0.8, 0.016)
      for (let i = 0; i < 10; i++) d.label(String(i), i * 36, 0.62, 0.13)
      d.text('ALT', 0.5, 0.32, 0.06)
      ctx.fillStyle = '#222'
      ctx.fillRect(s * 0.68, s * 0.45, s * 0.2, s * 0.1)
      d.text('29.92', 0.78, 0.5, 0.06)
    })
    this.tenThousands = this.needle(diameter * 0.44, diameter * 0.02, 0.001)
    this.thousands = this.needle(diameter * 0.26, diameter * 0.07, 0.002)
    this.hundreds = this.needle(diameter * 0.42, diameter * 0.04, 0.003)
    this.hub(0.004)
  }

  update() {
    const feet = Math.max(0, this.feet())
    point(this.hundreds, ((feet % 1000) / 1000) * 360)
    point(this.thousands, ((feet % 10_000) / 10_000) * 360)
    point(this.tenThousands, ((feet % 100_000) / 100_000) * 360)
  }
}

/**
 * Turn coordinator: the miniature aircraft banks with the rate of turn, reaching the L or R
 * mark at a standard rate turn, and the ball shows slip. It is electric, with a red flag
 * when it has no power.
 */
export class TurnCoordinator extends Instrument {
  private readonly plane: Mesh
  private readonly ball: Mesh
  private readonly flag: Mesh
  private turn = 0

  constructor(
    diameter: number,
    private readonly read: () => { turnRate: number; slip: number; powered: boolean }
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
      d.ticks(-110, -110, 1, 0.75, 0.025)
      d.ticks(110, 110, 1, 0.75, 0.025)
      d.ticks(-70, -70, 1, 0.75, 0.025)
      d.ticks(70, 70, 1, 0.75, 0.025)
      d.label('L', -110, 0.58, 0.1)
      d.label('R', 110, 0.58, 0.1)
      d.text('TURN COORDINATOR', 0.5, 0.25, 0.05)
      d.text('2 MIN', 0.5, 0.85, 0.05)
      // The glass tube the ball rolls in
      ctx.strokeStyle = '#555'
      ctx.lineWidth = s * 0.07
      ctx.beginPath()
      ctx.arc(d.c, -s * 0.05, s * 0.75, Math.PI * 0.37, Math.PI * 0.63)
      ctx.stroke()
    })
    const plane = paint(128, (ctx, s) => {
      ctx.fillStyle = WHITE
      ctx.fillRect(0, s * 0.45, s, s * 0.1)
      ctx.beginPath()
      ctx.arc(s / 2, s / 2, s * 0.09, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillRect(s * 0.47, s * 0.3, s * 0.06, s * 0.2)
    })
    this.plane = new Mesh(
      new PlaneGeometry(diameter * 0.7, diameter * 0.7),
      new MeshBasicMaterial({ map: plane, transparent: true, toneMapped: false })
    )
    this.plane.position.z = 0.002
    this.ball = new Mesh(
      new SphereGeometry(diameter * 0.04, 12, 8),
      new MeshBasicMaterial({ color: 0x111111 })
    )
    this.ball.position.set(0, -diameter * 0.32, 0.003)
    this.flag = new Mesh(
      new PlaneGeometry(diameter * 0.14, diameter * 0.08),
      new MeshBasicMaterial({ color: 0xd8261b, toneMapped: false })
    )
    this.flag.position.set(diameter * 0.18, -diameter * 0.1, 0.004)
    this.group.add(this.plane, this.ball, this.flag)
  }

  update(dt: number) {
    const { turnRate, slip, powered } = this.read()
    // Standard rate is 3 degrees a second, which the instrument shows as a 20 degree tilt
    const target = Math.max(-30, Math.min(30, (turnRate / (3 * DEG)) * 20))
    this.turn += (target - this.turn) * Math.min(1, dt * 4)
    this.plane.rotation.z = -this.turn * DEG
    const along = Math.max(-1, Math.min(1, slip * 6))
    const radius = this.diameter * 0.8
    const swing = along * 0.32
    this.ball.position.set(
      Math.sin(swing) * radius,
      this.diameter * 0.48 - Math.cos(swing) * radius,
      0.003
    )
    this.flag.visible = !powered
  }
}

/**
 * Heading indicator: a compass card that turns under a fixed lubber line, with the orange
 * heading bug for the autopilot. Headings in degrees.
 */
export class HeadingIndicator extends Instrument {
  private readonly card: Mesh
  private readonly bug: Mesh

  constructor(
    diameter: number,
    private readonly read: () => { heading: number; bug: number }
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
    })
    this.card = this.face(
      (ctx, s) => {
        const d = dialTools(ctx, s)
        d.ticks(0, 355, 5, 0.86, 0.008)
        d.ticks(0, 350, 10, 0.78, 0.014)
        const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }
        for (let a = 0; a < 360; a += 30) d.label(names[a] ?? String(a / 10), a, 0.62, 0.11)
      },
      256,
      0.001
    )
    this.bug = new Mesh(new PlaneGeometry(diameter * 0.08, diameter * 0.05), ORANGE)
    this.bug.geometry.translate(0, diameter * 0.43, 0)
    this.bug.position.z = 0.002
    this.group.add(this.bug)
    this.face(
      (ctx, s) => {
        const d = dialTools(ctx, s)
        ctx.fillStyle = '#ff8a1c'
        ctx.beginPath()
        ctx.moveTo(d.c, d.c - d.r * 0.72)
        ctx.lineTo(d.c - s * 0.03, d.c - d.r * 0.98)
        ctx.lineTo(d.c + s * 0.03, d.c - d.r * 0.98)
        ctx.fill()
        ctx.strokeStyle = WHITE
        ctx.lineWidth = s * 0.02
        ctx.beginPath()
        ctx.moveTo(d.c, d.c - s * 0.15)
        ctx.lineTo(d.c, d.c + s * 0.15)
        ctx.moveTo(d.c - s * 0.13, d.c - s * 0.02)
        ctx.lineTo(d.c + s * 0.13, d.c - s * 0.02)
        ctx.moveTo(d.c - s * 0.05, d.c + s * 0.12)
        ctx.lineTo(d.c + s * 0.05, d.c + s * 0.12)
        ctx.stroke()
      },
      256,
      0.003
    )
  }

  update() {
    const { heading, bug } = this.read()
    this.card.rotation.z = heading * DEG
    this.bug.rotation.z = -(bug - heading) * DEG
  }
}

/**
 * Vertical speed indicator, in hundreds of feet per minute. It reads from a calibrated leak
 * in the static line, so it lags a real climb by several seconds.
 */
export class VerticalSpeedIndicator extends Instrument {
  private readonly hand: Mesh
  private shown = 0

  constructor(
    diameter: number,
    private readonly fullScale: number,
    private readonly fpm: () => number
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
      const at = (f: number) => this.angle(f)
      for (let f = -fullScale; f <= fullScale; f += fullScale / 10)
        d.ticks(at(f), at(f), 1, 0.86, 0.01)
      for (let f = -fullScale; f <= fullScale; f += fullScale / 4) {
        d.label(String(Math.abs(f / 100)), at(f), 0.62, 0.1)
      }
      d.text('UP', 0.36, 0.34, 0.06)
      d.text('DN', 0.36, 0.66, 0.06)
      d.text('VERTICAL SPEED', 0.6, 0.5, 0.045)
    })
    this.hand = this.needle(diameter * 0.42, diameter * 0.045, 0.002)
    this.hub(0.003)
  }

  /** Zero at nine o'clock; full scale either way at 170 degrees from it. */
  private angle(fpm: number) {
    return 270 + (Math.max(-this.fullScale, Math.min(this.fullScale, fpm)) / this.fullScale) * 170
  }

  update(dt: number) {
    this.shown += (this.fpm() - this.shown) * Math.min(1, dt / 6)
    point(this.hand, this.angle(this.shown))
  }
}

/** Tachometer, in hundreds of rpm, with the green arc and the red line. */
export class Tachometer extends Instrument {
  private readonly hand: Mesh
  private shown = 0

  constructor(
    diameter: number,
    private readonly scale: GaugeSpec['power'],
    private readonly rpm: () => number
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
      const at = (r: number) => this.angle(r)
      d.arc(at(scale.normalRange[0]), at(scale.normalRange[1]), 0.82, 0.05, GREEN)
      d.ticks(at(scale.redline), at(scale.redline), 1, 0.72, 0.02, RED)
      for (let r = 0; r <= scale.max; r += scale.tickEvery) d.ticks(at(r), at(r), 1, 0.88, 0.008)
      for (let r = 0; r <= scale.max; r += scale.labelEvery) {
        d.label(String(r / scale.labelScale), at(r), 0.62, 0.1)
      }
      d.text('RPM', 0.5, 0.34, 0.06)
      d.text(scale.caption, 0.5, 0.7, 0.05)
    })
    this.hand = this.needle(diameter * 0.42, diameter * 0.045, 0.002)
    this.hub(0.003)
  }

  private angle(rpm: number) {
    return 225 + (Math.max(0, Math.min(rpm, this.scale.max)) / this.scale.max) * 270
  }

  update(dt: number) {
    this.shown += (this.rpm() - this.shown) * Math.min(1, dt * 6)
    point(this.hand, this.angle(this.shown))
  }
}

/** One half of a twin engine gauge: a label, a coloured scale, and a reading from 0 to 1. */
export type HalfGauge = {
  label: string
  /** Bands along the scale, each from and to as shares of it. */
  bands: { from: number; to: number; color: 'green' | 'yellow' | 'red' }[]
  read: () => number
}

/**
 * A pair of small gauges on one rectangular face, as in the Cessna's engine cluster: fuel
 * left and right, oil temperature and pressure, and so on.
 */
export class TwinGauge {
  readonly group = new Group()
  private readonly hands: Mesh[] = []
  private readonly texture: Texture

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly halves: [HalfGauge, HalfGauge]
  ) {
    const colors = { green: GREEN, yellow: YELLOW, red: RED }
    this.texture = paint(256, (ctx, s) => {
      ctx.fillStyle = FACE
      ctx.fillRect(0, 0, s, s)
      halves.forEach((half, i) => {
        const cx = s * (i === 0 ? 0.25 : 0.75)
        const cy = s * 0.82
        const r = s * 0.38
        for (const band of half.bands) {
          ctx.strokeStyle = colors[band.color]
          ctx.lineWidth = s * 0.05
          ctx.beginPath()
          ctx.arc(
            cx,
            cy,
            r,
            -Math.PI * 0.75 + band.from * Math.PI * 0.5,
            -Math.PI * 0.75 + band.to * Math.PI * 0.5
          )
          ctx.stroke()
        }
        ctx.fillStyle = WHITE
        ctx.font = `700 ${s * 0.09}px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(half.label, cx, s * 0.95)
      })
      ctx.strokeStyle = '#333'
      ctx.lineWidth = s * 0.02
      ctx.beginPath()
      ctx.moveTo(s / 2, 0)
      ctx.lineTo(s / 2, s)
      ctx.stroke()
    })
    const face = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false })
    )
    this.group.add(face)
    const frame = new Mesh(new PlaneGeometry(width * 1.08, height * 1.12), BEZEL)
    frame.position.z = -0.001
    this.group.add(frame)
    for (let i = 0; i < 2; i++) {
      const hand = new Mesh(needleGeometry(height * 0.62, height * 0.06, 0), NEEDLE)
      hand.position.set((i === 0 ? -0.25 : 0.25) * width, -0.32 * height, 0.001)
      this.group.add(hand)
      this.hands.push(hand)
    }
  }

  update() {
    this.halves.forEach((half, i) => {
      const share = Math.max(0, Math.min(1, half.read()))
      this.hands[i].rotation.z = -(-45 + share * 90) * DEG
    })
  }

  dispose() {
    this.texture.dispose()
    this.group.traverse(object => {
      if (object instanceof Mesh) object.geometry.dispose()
    })
  }
}

/**
 * Course deviation indicator for the approach: the vertical needle for the localizer or
 * course, the horizontal one for the glide slope, each with its warning flag.
 */
export class CourseIndicator extends Instrument {
  private readonly course: Mesh
  private readonly slope: Mesh
  private readonly navFlag: Mesh
  private readonly slopeFlag: Mesh
  private readonly card: Mesh
  private lateral = 0
  private vertical = 0

  constructor(
    diameter: number,
    private readonly read: () => {
      lateral: number
      vertical: number
      course: number
      valid: boolean
      slope: boolean
    }
  ) {
    super(diameter)
    this.face((ctx, s) => {
      const d = dialTools(ctx, s)
      d.background()
      ctx.strokeStyle = WHITE
      ctx.lineWidth = s * 0.008
      for (let i = -5; i <= 5; i++) {
        if (i === 0) continue
        ctx.beginPath()
        ctx.arc(d.c + i * s * 0.065, d.c, s * 0.015, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(d.c, d.c + i * s * 0.065, s * 0.015, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(d.c, d.c, s * 0.03, 0, Math.PI * 2)
      ctx.stroke()
    })
    this.card = this.face(
      (ctx, s) => {
        const d = dialTools(ctx, s)
        d.ticks(0, 355, 5, 0.9, 0.006)
        d.ticks(0, 330, 30, 0.84, 0.012)
        for (let a = 0; a < 360; a += 30) d.label(String(a / 10), a, 0.74, 0.07)
      },
      256,
      0.001
    )
    const bar = (w: number, h: number) =>
      new Mesh(
        new PlaneGeometry(w, h),
        new MeshBasicMaterial({ color: 0xf4f4f0, toneMapped: false })
      )
    this.course = bar(diameter * 0.02, diameter * 0.62)
    this.slope = bar(diameter * 0.62, diameter * 0.02)
    this.course.position.z = 0.002
    this.slope.position.z = 0.0025
    const flag = (x: number, y: number) => {
      const mesh = new Mesh(
        new PlaneGeometry(diameter * 0.14, diameter * 0.08),
        new MeshBasicMaterial({ color: 0xd8261b, toneMapped: false })
      )
      mesh.position.set(x, y, 0.003)
      return mesh
    }
    this.navFlag = flag(-diameter * 0.2, diameter * 0.12)
    this.slopeFlag = flag(diameter * 0.22, -diameter * 0.12)
    this.group.add(this.course, this.slope, this.navFlag, this.slopeFlag)
  }

  update(dt: number) {
    const { lateral, vertical, course, valid, slope } = this.read()
    const k = Math.min(1, dt * 3)
    this.lateral += ((valid ? lateral : 0) - this.lateral) * k
    this.vertical += ((slope ? vertical : 0) - this.vertical) * k
    // Five dots each side, 2.5 dots of deviation at full scale
    const dot = this.diameter * 0.065 * 2
    this.course.position.x = Math.max(-2.5, Math.min(2.5, this.lateral)) * dot
    this.slope.position.y = Math.max(-2.5, Math.min(2.5, this.vertical)) * dot
    this.card.rotation.z = course * DEG
    this.navFlag.visible = !valid
    this.slopeFlag.visible = !slope
  }
}

/**
 * The magnetic compass hanging from the windscreen frame: a heading card seen through a
 * window behind a lubber line. Its float swings past the heading and settles, as in fluid.
 */
export class Compass {
  readonly group = new Group()
  private readonly texture: Texture
  private shown = 0

  constructor(private readonly heading: () => number) {
    const box = new Mesh(new BoxGeometry(0.07, 0.05, 0.05), BEZEL)
    // The card: one strip of headings all the way round, a quarter of it in the window
    this.texture = paint(1024, (ctx, s) => {
      ctx.fillStyle = '#151515'
      ctx.fillRect(0, 0, s, s)
      ctx.fillStyle = WHITE
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `700 ${s * 0.3}px ${FONT}`
      const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }
      for (let a = 0; a < 360; a += 5) {
        const x = (a / 360) * s
        const long = a % 30 === 0
        ctx.fillRect(x - 1.5, s * 0.08, 3, s * (long ? 0.22 : 0.12))
        if (long) ctx.fillText(names[a] ?? String(a / 10), x, s * 0.62)
      }
    })
    this.texture.wrapS = RepeatWrapping
    this.texture.repeat.set(0.25, 1)
    const card = new Mesh(
      new PlaneGeometry(0.05, 0.022),
      new MeshBasicMaterial({ map: this.texture, toneMapped: false })
    )
    card.position.z = 0.0255
    const lubber = new Mesh(
      new PlaneGeometry(0.0015, 0.024),
      new MeshBasicMaterial({ color: 0xe3261b })
    )
    lubber.position.z = 0.026
    this.group.add(box, card, lubber)
  }

  update(dt: number) {
    const turn = ((this.heading() - this.shown + 540) % 360) - 180
    this.shown = (this.shown + turn * Math.min(1, dt * 1.5) + 360) % 360
    // The window centres the heading under the lubber line
    this.texture.offset.x = this.shown / 360 - 0.125
  }

  dispose() {
    this.texture.dispose()
    this.group.traverse(object => {
      if (object instanceof Mesh) object.geometry.dispose()
    })
  }
}
