import { setTimeout } from 'worker-timers'

export type Point = {
  lat: number
  lon: number
}

export type NowcastStep = {
  baseUrl: string
  time: number
  displayTime: string
  genTime: string
  suffix: string
  resolution: [number, number]
  dimensions: [[number, number], [number, number]]
  longterm: boolean
}

export type TilePixel = {
  x: number
  y: number
}

const STEP_PATTERN = /"baseUrl":"(https:\/\/api\.weather\.yandex\.ru\/frontend\/nowcast)","ts":\d+,"time":"(\d+)","displayTime":"([^"]+)","genTime":"(\d+)","date":"[^"]+","suffix":"([^"]+)","resolution":\[([0-9.]+),([0-9.]+)\],"dimensions":\[\[(-?[0-9.]+),(-?[0-9.]+)\],\[(-?[0-9.]+),(-?[0-9.]+)\]\],"tzOffset":-?\d+,"longterm":(true|false)/g
const TILE_QUERY_KEYS = new Set(['x', 'y', 'w', 'h', 'for_date', 'nowcast_gen_time', 'downsample'])
const STEP_RETRY_MS = 8_000
const STEP_RETRY_PAUSE_MS = 400
const EURASIA_GRID = {
  resolution: [0.02, 0.02] as [number, number],
  dimensions: [[-25.68, 180], [-47.92, 71.2]] as [[number, number], [number, number]],
}

type TileFrame = {
  baseUrl: string
  time: number
  genTime: string
  suffix: string
}

const normalizePayload = (html: string) => html.replaceAll('\\"', '"').replaceAll('\\u0026', '&')

function readNumber(value: string | undefined) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function readStep(match: RegExpMatchArray): NowcastStep | null {
  const baseUrl = match[1]
  const time = readNumber(match[2])
  const displayTime = match[3]
  const genTime = match[4]
  const suffix = match[5]
  const resolutionLon = readNumber(match[6])
  const resolutionLat = readNumber(match[7])
  const lonMin = readNumber(match[8])
  const lonMax = readNumber(match[9])
  const latMin = readNumber(match[10])
  const latMax = readNumber(match[11])
  const longterm = match[12]

  if (!baseUrl || time === null || !displayTime || !genTime || !suffix) return null
  if (resolutionLon === null || resolutionLat === null || resolutionLon <= 0 || resolutionLat <= 0) return null
  if (lonMin === null || lonMax === null || latMin === null || latMax === null) return null
  if (longterm !== 'true' && longterm !== 'false') return null

  return {
    baseUrl,
    time,
    displayTime,
    genTime,
    suffix,
    resolution: [resolutionLon, resolutionLat],
    dimensions: [[lonMin, lonMax], [latMin, latMax]],
    longterm: longterm === 'true',
  }
}

export function readPoint(search: string): Point | null {
  const params = new URLSearchParams(search)
  const lat = readNumber(params.get('lat') ?? undefined)
  const lon = readNumber(params.get('lon') ?? undefined)

  if (lat === null || lon === null) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null

  return { lat, lon }
}

export function parseNowcastSteps(html: string) {
  const steps = new Map<string, NowcastStep>()

  for (const match of normalizePayload(html).matchAll(STEP_PATTERN)) {
    const step = readStep(match)
    if (!step) continue
    steps.set(`${step.time}:${step.genTime}:${step.suffix}`, step)
  }

  return [...steps.values()]
}

function coversPoint(step: NowcastStep, point: Point) {
  const [[lonMin, lonMax], [latMin, latMax]] = step.dimensions
  return point.lon >= lonMin && point.lon <= lonMax && point.lat >= latMin && point.lat <= latMax
}

export function selectCurrentStep(steps: NowcastStep[], point: Point, nowMs: number) {
  const nowSec = nowMs / 1000
  const candidates = steps.filter((step) => {
    if (step.longterm) return false
    if (step.suffix.includes('region=america')) return false
    return coversPoint(step, point)
  })

  const started = candidates.filter(step => step.time <= nowSec)
  const pool = started.length > 0 ? started : candidates
  const pickLatest = started.length > 0

  return pool.reduce<NowcastStep | null>((best, step) => {
    if (!best) return step
    if (pickLatest) return step.time > best.time ? step : best
    return step.time < best.time ? step : best
  }, null)
}

function gridFromSteps(steps: NowcastStep[]) {
  const current = steps.find(step => !step.longterm && !step.suffix.includes('region=america'))
  const anyRegion = steps.find(step => !step.suffix.includes('region=america'))
  const step = current ?? anyRegion
  if (!step) return null
  return { resolution: step.resolution, dimensions: step.dimensions }
}

export function readTileFrame(url: string): TileFrame | null {
  if (!url.includes('/nowcast/new_encoded_tile') || url.includes('region=america')) return null

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const time = readNumber(parsed.searchParams.get('for_date') ?? undefined)
  const genTime = parsed.searchParams.get('nowcast_gen_time')
  if (time === null || !genTime) return null

  const suffix = [...parsed.searchParams.entries()]
    .filter(([key]) => !TILE_QUERY_KEYS.has(key))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/new_encoded_tile$/, '')}`

  return { baseUrl, time, genTime, suffix }
}

export function pickTileFrame(urls: string[], nowMs: number) {
  const nowSec = nowMs / 1000
  const frames = urls.flatMap((url) => {
    const frame = readTileFrame(url)
    return frame ? [frame] : []
  })
  const started = frames.filter(frame => frame.time <= nowSec)
  const pool = started.length > 0 ? started : frames
  const pickLatest = started.length > 0

  return pool.reduce<TileFrame | null>((best, frame) => {
    if (!best) return frame
    if (pickLatest) {
      if (frame.time > best.time) return frame
      if (frame.time === best.time && frame.genTime > best.genTime) return frame
      return best
    }
    return frame.time < best.time ? frame : best
  }, null)
}

function tileRequestUrls() {
  if (typeof performance === 'undefined') return []
  return performance.getEntriesByType('resource').map(entry => entry.name)
}

function stepFromTiles(steps: NowcastStep[], nowMs: number) {
  const frame = pickTileFrame(tileRequestUrls(), nowMs)
  if (!frame) return null

  const grid = gridFromSteps(steps) ?? EURASIA_GRID
  const displayTime = new Date(frame.time * 1000).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })

  return {
    baseUrl: frame.baseUrl,
    time: frame.time,
    displayTime,
    genTime: frame.genTime,
    suffix: frame.suffix,
    resolution: grid.resolution,
    dimensions: grid.dimensions,
    longterm: false,
  } satisfies NowcastStep
}

export function resolveNowcastStep(html: string, point: Point, nowMs: number) {
  const steps = parseNowcastSteps(html)
  const fromHtml = selectCurrentStep(steps, point, nowMs)
  if (fromHtml) return fromHtml

  const fromTiles = stepFromTiles(steps, nowMs)
  if (!fromTiles || !coversPoint(fromTiles, point)) return null
  return fromTiles
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function currentHtml(fallback: string) {
  if (typeof document === 'undefined') return fallback
  return document.documentElement.innerHTML
}

export function toTilePixel(point: Point, step: NowcastStep): TilePixel {
  const [[lonMin, lonMax], [latMin, latMax]] = step.dimensions
  const [resolutionLon, resolutionLat] = step.resolution
  const width = Math.round((lonMax - lonMin) / resolutionLon)
  const height = Math.round((latMax - latMin) / resolutionLat)
  const x = Math.floor((point.lon - lonMin) / resolutionLon)
  const yFromTop = Math.floor((latMax - point.lat) / resolutionLat)
  const y = height - (yFromTop + 1)

  if (x < 0 || y < 0 || x >= width || y >= height) {
    throw new Error('Точка оказалась вне сетки карты осадков')
  }

  return { x, y }
}

const TILE_SIZE = 256

export function tileWindow(point: Point, step: NowcastStep) {
  const pixel = toTilePixel(point, step)
  const [[lonMin, lonMax], [latMin, latMax]] = step.dimensions
  const [resolutionLon, resolutionLat] = step.resolution
  const width = Math.round((lonMax - lonMin) / resolutionLon)
  const height = Math.round((latMax - latMin) / resolutionLat)
  const yFromTop = Math.floor((latMax - point.lat) / resolutionLat)
  const tileX = Math.floor(pixel.x / TILE_SIZE) * TILE_SIZE
  const tileTop = Math.floor(yFromTop / TILE_SIZE) * TILE_SIZE
  const w = Math.min(TILE_SIZE, width - tileX)
  const h = Math.min(TILE_SIZE, height - tileTop)
  const row = yFromTop - tileTop
  const col = pixel.x - tileX

  if (w < 1 || h < 1 || row < 0 || col < 0 || row >= h || col >= w) {
    throw new Error('Точка оказалась вне сетки карты осадков')
  }

  const query = new URLSearchParams({
    x: String(tileX),
    y: String(height - (tileTop + h)),
    w: String(w),
    h: String(h),
    for_date: String(step.time),
    nowcast_gen_time: step.genTime,
  })
  const prefix = step.suffix ? `${step.suffix}&` : ''

  return {
    url: `${step.baseUrl}/new_encoded_tile?${prefix}${query.toString()}`,
    col,
    row,
  }
}

export const isRainPixel = (red: number, alpha: number) => red !== 0 && alpha > 127

export async function readPngRain(blob: Blob, col = 0, row = 0) {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d', { willReadFrequently: true })

  if (!context || col < 0 || row < 0 || col >= bitmap.width || row >= bitmap.height) {
    throw new Error('Не удалось прочитать ячейку карты')
  }

  context.drawImage(bitmap, 0, 0)
  bitmap.close()

  const pixel = context.getImageData(col, row, 1, 1).data
  const red = pixel[0]
  const alpha = pixel[3]

  if (red === undefined || alpha === undefined) {
    throw new Error('Не удалось прочитать ячейку карты')
  }

  return isRainPixel(red, alpha)
}

export async function loadRainAtPoint(point: Point, html: string, nowMs: number) {
  const deadline = Date.now() + STEP_RETRY_MS
  let step = resolveNowcastStep(html, point, nowMs)

  while (!step && Date.now() < deadline) {
    await wait(STEP_RETRY_PAUSE_MS)
    step = resolveNowcastStep(currentHtml(html), point, Date.now())
  }

  if (!step) {
    throw new Error('На странице нет текущего шага карты осадков')
  }

  const tile = tileWindow(point, step)
  const response = await fetch(tile.url)

  if (!response.ok) {
    throw new Error('Не удалось загрузить ячейку карты')
  }

  return {
    raining: await readPngRain(await response.blob(), tile.col, tile.row),
    step,
  }
}
