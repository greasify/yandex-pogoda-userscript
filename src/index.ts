import type { Point } from './nowcast'
import { clearTimeout, setInterval, setTimeout } from 'worker-timers'
import { loadRainAtPoint, readPoint } from './nowcast'
import './style.scss'

const RELOAD_MS = 10 * 60 * 1000
const WIDGET_TIMEOUT_MS = 20_000
const START_KEY = '__yandexPogodaRainStarted'

const isNowcastPage = () => location.hostname.endsWith('yandex.ru') && location.pathname.includes('/maps/nowcast')

function claimRun() {
  const page = window as Window & { [START_KEY]?: boolean }
  if (page[START_KEY]) return false
  page[START_KEY] = true
  return true
}

const answerKey = (time: number, point: Point) => `yandex-pogoda-rain:${time}:${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`

function wasAnswered(time: number, point: Point) {
  try {
    return sessionStorage.getItem(answerKey(time, point)) === '1'
  } catch {
    return false
  }
}

function rememberAnswer(time: number, point: Point) {
  try {
    sessionStorage.setItem(answerKey(time, point), '1')
  } catch {
    // Приватный режим без storage не должен ронять проверку.
  }
}

function findReportButtons() {
  const buttons = [...document.querySelectorAll('button')]
  const inWidget = (label: string) => buttons.find((button) => {
    if (button.textContent?.trim() !== label) return false
    return button.parentElement?.textContent?.includes('Идёт дождь') ?? false
  })
  const yes = inWidget('Да')
  const no = inWidget('Нет')

  if (!yes || !no) return null
  return { yes, no }
}

function waitForWidget() {
  return new Promise<NonNullable<ReturnType<typeof findReportButtons>> | null>((resolve) => {
    const existing = findReportButtons()
    if (existing) {
      resolve(existing)
      return
    }

    let timer = 0

    const observer = new MutationObserver(() => {
      const widget = findReportButtons()
      if (!widget) return
      observer.disconnect()
      clearTimeout(timer)
      resolve(widget)
    })

    observer.observe(document.documentElement, { childList: true, subtree: true })

    timer = setTimeout(() => {
      observer.disconnect()
      resolve(findReportButtons())
    }, WIDGET_TIMEOUT_MS)
  })
}

function formatClock(date: Date) {
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function createBadge(lines: string[], state: 'yes' | 'no' | 'error') {
  const badge = document.createElement('aside')
  badge.className = `rain-check rain-check_${state}`
  badge.setAttribute('role', 'status')

  for (const line of lines) {
    const row = document.createElement('p')
    row.textContent = line
    badge.append(row)
  }

  return badge
}

function showBadge(lines: string[], state: 'yes' | 'no' | 'error') {
  document.querySelector('.rain-check')?.remove()
  document.body.append(createBadge(lines, state))
}

function scheduleReload() {
  setTimeout(() => {
    location.reload()
  }, RELOAD_MS)
}

const pointLabel = (lat: number, lon: number) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`

const pointKey = (point: Point) => `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`

function watchLocation(onChange: () => void) {
  window.addEventListener('popstate', onChange)

  const pushState = history.pushState.bind(history)
  const replaceState = history.replaceState.bind(history)

  history.pushState = (...args: Parameters<History['pushState']>) => {
    pushState(...args)
    onChange()
  }
  history.replaceState = (...args: Parameters<History['replaceState']>) => {
    replaceState(...args)
    onChange()
  }
  setInterval(onChange, 1000)
}

function isSamePoint(point: Point) {
  const latest = readPoint(location.search)
  return latest !== null && pointKey(latest) === pointKey(point)
}

async function checkPoint(point: Point) {
  try {
    const { raining, step } = await loadRainAtPoint(point, document.documentElement.innerHTML, Date.now())
    if (!isSamePoint(point)) return

    const answer = raining ? 'Да' : 'Нет'
    const state = raining ? 'yes' : 'no'
    const lines = (status: string) => [
      `Дождь: ${answer}`,
      `${formatClock(new Date())} · шаг карты ${step.displayTime}`,
      pointLabel(point.lat, point.lon),
      status,
    ]
    const alreadyAnswered = wasAnswered(step.time, point)

    showBadge(lines(alreadyAnswered ? 'Ответ за этот шаг уже отправлен' : 'Карта прочитана'), state)
    if (alreadyAnswered) return

    const widget = findReportButtons() ?? await waitForWidget()
    if (!isSamePoint(point)) return
    if (!widget) {
      showBadge(lines('Кнопки «Да» и «Нет» нет, карта прочитана'), state)
      return
    }

    widget[raining ? 'yes' : 'no'].click()
    rememberAnswer(step.time, point)
    showBadge(lines('Ответ отправлен'), state)
  } catch (error) {
    if (!isSamePoint(point)) return
    const message = error instanceof Error ? error.message : 'Не удалось прочитать ячейку карты'
    showBadge(['Не удалось проверить дождь', message, pointLabel(point.lat, point.lon)], 'error')
  }
}

function followPoint() {
  let checking = false
  let queued = false
  let seenKey = ''

  const run = async () => {
    if (checking) {
      queued = true
      return
    }

    checking = true
    try {
      do {
        queued = false
        const point = readPoint(location.search)
        if (!point) {
          seenKey = ''
          showBadge(['Не удалось проверить дождь', 'В адресе нет координат пина'], 'error')
          continue
        }

        const key = pointKey(point)
        if (key === seenKey) continue

        seenKey = key
        await checkPoint(point)
      } while (queued)
    } finally {
      checking = false
      if (queued) void run()
    }
  }

  return run
}

async function run() {
  if (!isNowcastPage() || !claimRun()) return

  scheduleReload()
  const follow = followPoint()
  watchLocation(() => {
    void follow()
  })
  await follow()
}

await run()
