import type { Mesh } from 'three'
import { Instrument } from '../gauges'

/*
 * Round dials for the P-51D's engine and systems instruments: manifold pressure, coolant,
 * the three-needle engine gauge unit, fuel quantity, suction, and the clock. Each dial
 * holds one or more scales, each with its own needle about its own centre.
 */

const WHITE = '#f2f2ee'
const COLORS = { green: '#2fb34a', yellow: '#f2c014', red: '#e3261b', white: WHITE }
const FONT = 'Arial Narrow, Roboto Condensed, system-ui, sans-serif'
const DEG = Math.PI / 180

/** One scale on a dial, swept clockwise from `from` to `to` dial degrees (0 at twelve). */
export type Scale = {
  min: number
  max: number
  from: number
  to: number
  ticks: number
  labels: number
  read: () => number
  /** Centre of the scale on the face, as shares of the face from its top left. */
  centre?: [number, number]
  /** Radius as a share of the face's. */
  radius?: number
  bands?: { from: number; to: number; color: keyof typeof COLORS }[]
  /** The printed label for a value; an empty string prints none. */
  format?: (value: number) => string
  /** Printed beside the scale's centre, such as OIL or FUEL. */
  title?: string
  /** Needle length as a share of the scale's radius. */
  needle?: number
  /** Seconds the needle takes to settle. */
  lag?: number
}

/** A round dial with one or more scales, its caption printed across the face. */
export class Dial extends Instrument {
  private readonly hands: Mesh[] = []
  private readonly shown: number[]

  constructor(
    diameter: number,
    caption: string[],
    private readonly scales: Scale[]
  ) {
    super(diameter)
    this.shown = scales.map(scale => scale.read())
    this.face((ctx, s) => {
      const c = s / 2
      ctx.fillStyle = '#0d0e10'
      ctx.beginPath()
      ctx.arc(c, c, s * 0.47, 0, Math.PI * 2)
      ctx.fill()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const scale of scales) this.printScale(ctx, s, scale)
      ctx.fillStyle = WHITE
      ctx.font = `700 ${s * 0.055}px ${FONT}`
      caption.forEach((line, i) => {
        ctx.fillText(line, c, s * (0.66 + i * 0.065))
      })
    }, 512)
    for (const scale of scales) {
      const r = (diameter / 2) * 0.94 * (scale.radius ?? 1)
      const hand = this.needle(r * (scale.needle ?? 0.86), diameter * 0.04, 0.002)
      const [x, y] = scale.centre ?? [0.5, 0.5]
      hand.position.x = (x - 0.5) * diameter
      hand.position.y = (0.5 - y) * diameter
      this.hands.push(hand)
    }
    this.hub(0.003)
  }

  private angle(scale: Scale, value: number) {
    const share =
      (Math.min(scale.max, Math.max(scale.min, value)) - scale.min) / (scale.max - scale.min)
    return scale.from + share * (scale.to - scale.from)
  }

  private printScale(ctx: CanvasRenderingContext2D, s: number, scale: Scale) {
    const [x, y] = scale.centre ?? [0.5, 0.5]
    const cx = s * x
    const cy = s * y
    const r = s * 0.47 * (scale.radius ?? 1)
    const at = (degrees: number, radius: number): [number, number] => {
      const t = (degrees - 90) * DEG
      return [cx + Math.cos(t) * radius, cy + Math.sin(t) * radius]
    }
    for (const band of scale.bands ?? []) {
      ctx.strokeStyle = COLORS[band.color]
      ctx.lineWidth = r * 0.09
      ctx.beginPath()
      ctx.arc(
        cx,
        cy,
        r * 0.8,
        (this.angle(scale, band.from) - 90) * DEG,
        (this.angle(scale, band.to) - 90) * DEG
      )
      ctx.stroke()
    }
    ctx.strokeStyle = WHITE
    for (let value = scale.min; value <= scale.max + 1e-6; value += scale.ticks) {
      const major = Math.abs(value / scale.labels - Math.round(value / scale.labels)) < 1e-6
      const a = this.angle(scale, value)
      ctx.lineWidth = r * (major ? 0.035 : 0.02)
      ctx.beginPath()
      ctx.moveTo(...at(a, r * (major ? 0.74 : 0.84)))
      ctx.lineTo(...at(a, r * 0.95))
      ctx.stroke()
      if (!major) continue
      // Ticks step by adding, so round away the sums' floating point dust
      const text = scale.format ? scale.format(value) : String(Math.round(value * 1000) / 1000)
      if (!text) continue
      ctx.fillStyle = WHITE
      ctx.font = `700 ${r * 0.2}px ${FONT}`
      ctx.fillText(text, ...at(a, r * 0.56))
    }
    if (scale.title) {
      ctx.fillStyle = WHITE
      ctx.font = `700 ${r * 0.2}px ${FONT}`
      ctx.fillText(scale.title, cx, cy + r * 0.35)
    }
  }

  update(dt: number) {
    this.scales.forEach((scale, i) => {
      this.shown[i] += (scale.read() - this.shown[i]) * Math.min(1, dt / (scale.lag ?? 0.3))
      this.hands[i].rotation.z = -this.angle(scale, this.shown[i]) * DEG
    })
  }
}
