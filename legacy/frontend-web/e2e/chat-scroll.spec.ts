/* eslint-disable camelcase -- mocked API payloads use the backend's snake_case fields */
import { expect, Page, Route, test } from '@playwright/test'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'

/**
 * Regression tests for issue #84: after every sent message the chat swapped the
 * message list for a full-screen spinner and remounted it scrolled to the top.
 * And for issue #164: while an answer streams, a reader at the bottom follows it,
 * a reader who scrolled up is left alone, and a jump-to-latest button brings them back.
 *
 * Every backend route is intercepted, so the tests are deterministic and never
 * touch a real API. route.fulfill() cannot stream, so streamed answers come from a
 * tiny local HTTP server the POST is redirected to.
 */

const THREAD_ID = '1'
const QUESTION = 'What is the e2e regression question?'
const ANSWER_END = 'END-OF-E2E-ANSWER'
const ANSWER = Array.from(
  { length: 12 },
  (_, i) => `Answer paragraph ${i + 1}. ${'Lorem ipsum dolor sit amet. '.repeat(8)}`,
)
  .concat(ANSWER_END)
  .join('\n\n')

// Latencies that mimic a real network; without them the spinner swap is too brief to observe.
const THREAD_LIST_LATENCY_MS = 300
const ANSWER_LATENCY_MS = 1500
// The app refetches the thread list right after the answer and again 2s later.
const OBSERVATION_WINDOW_MS = 3500

// A streamed answer: long enough to overflow the viewport, in small chunks over several seconds.
const STREAM_END = 'END-OF-STREAMED-ANSWER'
const STREAM_ANSWER = Array.from(
  { length: 24 },
  (_, i) => `Streamed paragraph ${i + 1}. ${'Lorem ipsum dolor sit amet. '.repeat(6)}`,
)
  .concat(STREAM_END)
  .join('\n\n')
const STREAM_CHUNKS = 60
const STREAM_CHUNK_MS = 120
// A reader counts as "at the bottom" within this many pixels of it (the app's threshold is 50).
const AT_BOTTOM_PX = 50

// API calls the fake backend does not know; checked after every test so a new endpoint fails loudly.
const unmockedCalls: string[] = []

type ApiMessage = { id: string; role: 'user' | 'assistant'; content: string }

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const json = (route: Route, body: unknown): Promise<void> =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * Serves `answer` as a chunked text/event-stream, calling beforeEnd() just before closing the stream.
 */
async function startStreamServer(answer: string, beforeEnd: () => void): Promise<{ url: string; close: () => void }> {
  const size = Math.ceil(answer.length / STREAM_CHUNKS)
  const chunks = Array.from({ length: STREAM_CHUNKS }, (_, i) => answer.slice(i * size, (i + 1) * size)).filter(Boolean)
  const server = createServer(async (req, res) => {
    req.resume()
    // A client that aborts mid-stream must not surface as an unhandled error in the Playwright worker.
    res.on('error', () => {})
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    for (const chunk of chunks) {
      if (res.writableEnded || res.destroyed) return
      res.write(chunk)
      await sleep(STREAM_CHUNK_MS)
    }
    if (res.writableEnded || res.destroyed) return
    beforeEnd()
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://localhost:${port}/stream`, close: () => server.close() }
}

type MockOptions = {
  // Delays the thread fetch so the opening spinner can be observed.
  threadLatencyMs?: number
  // Streams the answer in chunks instead of returning it in one response.
  streamed?: boolean
}

/**
 * Installs a stateful fake backend: a long thread that gains a question/answer pair when a message is posted.
 * Returns a cleanup function.
 */
async function mockBackend(
  page: Page,
  { threadLatencyMs = 0, streamed = false }: MockOptions = {},
): Promise<() => void> {
  unmockedCalls.length = 0
  const messages: ApiMessage[] = Array.from({ length: 30 }, (_, i) => ({
    id: uuid(i),
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Seed message ${i + 1}. ${'Some earlier conversation text. '.repeat(10)}`,
  }))
  const answer = streamed ? STREAM_ANSWER : ANSWER
  // The real backend persists the turn before closing the stream.
  const persistTurn = (): void => {
    messages.push(
      { id: uuid(messages.length), role: 'user', content: QUESTION },
      { id: uuid(messages.length + 1), role: 'assistant', content: answer },
    )
  }
  const stream = streamed ? await startStreamServer(answer, persistTurn) : null

  // Nothing may leave the machine: abort everything that is not the app itself.
  await page.route(
    (url) => url.hostname !== 'localhost',
    (route) => route.abort(),
  )

  await page.route('**/api/v2/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v2', '')
    const method = request.method()

    if (method === 'GET' && path === '/users/me') {
      return json(route, { user_id: 'e2e-user', first_name: 'E2E', last_name: 'User', email: 'e2e@example.com' })
    }
    if (method === 'GET' && path === '/threads') {
      await sleep(THREAD_LIST_LATENCY_MS)
      return json(route, [{ thread_id: 1, thread_name: 'Long thread', updated_at: '2026-01-01T00:00:00Z' }])
    }
    if (method === 'GET' && path === `/threads/${THREAD_ID}`) {
      await sleep(threadLatencyMs)
      return json(route, { thread_name: 'Long thread', messages })
    }
    if (method === 'POST' && path === `/threads/${THREAD_ID}`) {
      await sleep(ANSWER_LATENCY_MS)
      if (stream) return route.continue({ url: stream.url })
      persistTurn()
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ANSWER })
    }
    unmockedCalls.push(`${method} ${path}`)
    return route.fulfill({ status: 501 })
  })
  return () => stream?.close()
}

/**
 * Signs the browser in by seeding the tokens the app reads from AsyncStorage (localStorage on web).
 */
async function authenticate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('ac-at', 'e2e-access-token')
    window.localStorage.setItem('ac-rt', 'e2e-refresh-token')
  })
}

test.afterEach(() => {
  expect(unmockedCalls, 'the app called API routes the fake backend does not mock').toEqual([])
})

type ProbeResult = { spinnerSeen: boolean; listUnmounted: boolean; minScrollTop: number; finalScrollTop: number }

test('sending a message keeps the message list mounted and its scroll position', async ({ page }) => {
  await mockBackend(page)
  await authenticate(page)

  await page.goto(`/chat/${THREAD_ID}`)
  const list = page.getByTestId('message-list-scroll')
  await expect(list.getByText('Seed message 30.')).toBeVisible()
  // Let the initial thread-list fetch settle so the test only observes the send flow.
  await expect(page.getByTestId('message-list-loading')).toHaveCount(0)
  await page.waitForTimeout(THREAD_LIST_LATENCY_MS * 2)
  await expect(list).toBeVisible()

  await page.locator('textarea').fill(QUESTION)
  await page.locator('textarea').press('Enter')
  await expect(list.getByText(QUESTION)).toBeVisible()

  // While the answer is pending, scroll down like a reader would and start sampling every frame.
  const scrolledTo = await page.evaluate(() => {
    const getList = (): HTMLElement | null => document.querySelector('[data-testid="message-list-scroll"]')
    const list = getList()!
    // Find whichever element really scrolls: the list itself on the live chat, or an ancestor if it is not bounded.
    let scroller: HTMLElement = list
    while (
      scroller.parentElement &&
      !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)
    ) {
      scroller = scroller.parentElement
    }
    scroller.scrollTop = scroller.scrollHeight
    const probe = {
      spinnerSeen: false,
      listUnmounted: false,
      minScrollTop: scroller.scrollTop,
      finalScrollTop: scroller.scrollTop,
    }
    ;(window as any).__scrollProbe = probe
    const sample = (): void => {
      if (document.querySelector('[data-testid="message-list-loading"]')) probe.spinnerSeen = true
      if (getList() !== list) probe.listUnmounted = true
      probe.minScrollTop = Math.min(probe.minScrollTop, scroller.scrollTop)
      probe.finalScrollTop = scroller.scrollTop
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    return scroller.scrollTop
  })
  expect(scrolledTo).toBeGreaterThan(1000) // the thread must actually be long enough to scroll

  await expect(page.getByText(ANSWER_END)).toBeAttached({ timeout: 15_000 })
  await page.waitForTimeout(OBSERVATION_WINDOW_MS)

  const probe: ProbeResult = await page.evaluate(() => (window as any).__scrollProbe)
  expect.soft(probe.spinnerSeen, 'a full-screen spinner replaced the message list').toBe(false)
  expect.soft(probe.listUnmounted, 'the message list ScrollView was remounted').toBe(false)
  expect.soft(probe.minScrollTop, 'the scroll offset was reset towards the top').toBeGreaterThanOrEqual(scrolledTo - 5)
  expect
    .soft(probe.finalScrollTop, 'the list ended up scrolled away from where the reader was')
    .toBeGreaterThanOrEqual(scrolledTo - 5)
})

test('opening a thread still shows a spinner until the thread has loaded', async ({ page }) => {
  await mockBackend(page, { threadLatencyMs: 1000 })
  await authenticate(page)

  await page.goto(`/chat/${THREAD_ID}`)
  await expect(page.getByTestId('message-list-loading')).toBeVisible()
  await expect(page.getByTestId('message-list-scroll').getByText('Seed message 30.')).toBeVisible()
  await expect(page.getByTestId('message-list-loading')).toHaveCount(0)
})

/**
 * Starts sampling the real scroller every frame into window.__streamProbe: the list itself on the live chat,
 * or whichever ancestor really scrolls if it is not bounded.
 */
async function startStreamProbe(page: Page): Promise<void> {
  await page.evaluate((streamEnd) => {
    let scroller = document.querySelector('[data-testid="message-list-scroll"]') as HTMLElement
    while (
      scroller.parentElement &&
      !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)
    ) {
      scroller = scroller.parentElement
    }
    const probe = { heights: [] as number[], maxGap: 0, startHeight: scroller.scrollHeight, done: false }
    ;(window as any).__scroller = scroller
    ;(window as any).__streamProbe = probe
    const sample = (): void => {
      if (probe.done) return
      const height = scroller.scrollHeight
      if (probe.heights[probe.heights.length - 1] !== height) probe.heights.push(height)
      probe.maxGap = Math.max(probe.maxGap, height - scroller.scrollTop - scroller.clientHeight)
      // textContent, not innerText: innerText forces a layout on every frame of the stream.
      if (document.body.textContent?.includes(streamEnd)) probe.done = true
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, STREAM_END)
}

const gapToBottom = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const s = (window as any).__scroller as HTMLElement
    return s.scrollHeight - s.scrollTop - s.clientHeight
  })

/**
 * Where the jump button sits: its horizontal offset from the chat column's centre, and the gaps from its
 * bottom edge to the composer's top and to the viewport's bottom.
 */
const jumpButtonPlacement = (page: Page): Promise<{ offCentre: number; aboveComposer: number; aboveFold: number }> =>
  page.evaluate(() => {
    const button = document.querySelector('[data-testid="scroll-to-bottom-button"]')!.getBoundingClientRect()
    const list = document.querySelector('[data-testid="message-list-scroll"]')!.getBoundingClientRect()
    const composer = document.querySelector('textarea')!.getBoundingClientRect()
    return {
      offCentre: button.left + button.width / 2 - (list.left + list.width / 2),
      aboveComposer: composer.top - button.bottom,
      aboveFold: window.innerHeight - button.bottom,
    }
  })

async function openLongThread(page: Page): Promise<void> {
  await authenticate(page)
  await page.goto(`/chat/${THREAD_ID}`)
  await expect(page.getByTestId('message-list-scroll').getByText('Seed message 30.')).toBeVisible()
  await expect(page.getByTestId('message-list-loading')).toHaveCount(0)
  await page.waitForTimeout(THREAD_LIST_LATENCY_MS * 2)
}

async function send(page: Page): Promise<void> {
  await page.locator('textarea').fill(QUESTION)
  await page.locator('textarea').press('Enter')
}

test('a reader at the bottom follows a streamed answer to its end', async ({ page }) => {
  const cleanup = await mockBackend(page, { streamed: true })
  try {
    await openLongThread(page)
    await send(page)

    // Sending scrolls the new question into view.
    await expect(page.getByTestId('message-list-scroll').getByText(QUESTION)).toBeInViewport()
    await startStreamProbe(page)
    await expect(page.getByText('Streamed paragraph 1.')).toBeAttached({ timeout: 15_000 })
    await expect(page.getByTestId('scroll-to-bottom-button')).toBeHidden()

    await expect(page.getByText(STREAM_END)).toBeAttached({ timeout: 20_000 })
    const probe = await page.evaluate(() => (window as any).__streamProbe)
    // Guard against a quiet pass: the answer must really have arrived in many steps and overflowed the view.
    expect(probe.heights.length, 'the answer did not stream in chunks').toBeGreaterThan(10)
    expect(probe.heights[probe.heights.length - 1] - probe.startHeight).toBeGreaterThan(800)

    expect(probe.maxGap, 'the newest text fell below the fold while streaming').toBeLessThanOrEqual(AT_BOTTOM_PX * 2)
    await expect(page.getByText(STREAM_END)).toBeInViewport()
    await page.waitForTimeout(OBSERVATION_WINDOW_MS)
    expect(await gapToBottom(page), 'the view drifted off the bottom after the stream').toBeLessThanOrEqual(
      AT_BOTTOM_PX,
    )
    await expect(page.getByTestId('scroll-to-bottom-button')).toBeHidden()
  } finally {
    cleanup()
  }
})

test('the composer stays put while a followed answer streams', async ({ page }) => {
  // Issue #182: the composer sat in the page's scroll flow, so every chunk pushed it down a frame before the
  // follow logic scrolled it back, and it visibly bounced for the whole stream.
  const cleanup = await mockBackend(page, { streamed: true })
  try {
    await openLongThread(page)
    await send(page)
    await expect(page.getByTestId('message-list-scroll').getByText(QUESTION)).toBeInViewport()
    await startStreamProbe(page)
    await page.evaluate((streamEnd) => {
      const composer = document.querySelector('textarea')!
      const probe = { tops: [] as number[], frames: 0, done: false }
      ;(window as any).__composerProbe = probe
      const sample = (): void => {
        if (probe.done) return
        probe.frames += 1
        probe.tops.push(composer.getBoundingClientRect().top)
        if (document.body.textContent?.includes(streamEnd)) probe.done = true
        else requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, STREAM_END)

    await expect(page.getByText(STREAM_END)).toBeAttached({ timeout: 20_000 })
    const stream = await page.evaluate(() => (window as any).__streamProbe)
    const composer = await page.evaluate(() => (window as any).__composerProbe)
    // Guard against a quiet pass: the answer must really have streamed and been followed.
    expect(stream.heights.length, 'the answer did not stream in chunks').toBeGreaterThan(10)
    expect(stream.maxGap, 'the view did not follow the stream').toBeLessThanOrEqual(AT_BOTTOM_PX * 2)
    expect(composer.frames, 'the composer was not sampled across the stream').toBeGreaterThan(60)
    const drift = Math.max(...composer.tops) - Math.min(...composer.tops)
    expect(drift, 'the composer moved while the answer streamed').toBeLessThanOrEqual(1)
    await expect(page.locator('textarea')).toBeInViewport()
  } finally {
    cleanup()
  }
})

test('a reader who scrolls up mid-stream is not moved, and the jump button brings them back', async ({ page }) => {
  const cleanup = await mockBackend(page, { streamed: true })
  try {
    await openLongThread(page)
    await send(page)
    await startStreamProbe(page)
    await expect(page.getByText('Streamed paragraph 3.')).toBeAttached({ timeout: 15_000 })

    // Scroll up like a reader would; the stream must not pull them back down.
    const parked = await page.evaluate(() => {
      const s = (window as any).__scroller as HTMLElement
      s.scrollTop = s.scrollTop - 800
      return s.scrollTop
    })
    await expect(page.getByTestId('scroll-to-bottom-button')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeInViewport()
    // Centred over the chat and floating just above the composer, which stays in view below the list (#182).
    const parkedPlacement = await jumpButtonPlacement(page)
    expect(Math.abs(parkedPlacement.offCentre), 'the jump button is not centred over the chat').toBeLessThanOrEqual(2)
    expect(parkedPlacement.aboveComposer, 'the jump button overlaps the composer').toBeGreaterThan(0)
    expect(parkedPlacement.aboveComposer, 'the jump button is not just above the composer').toBeLessThanOrEqual(60)
    expect(parkedPlacement.aboveFold).toBeGreaterThan(0)
    const heightBefore = await page.evaluate(() => (window as any).__scroller.scrollHeight)
    await page.waitForTimeout(1500)
    const held = await page.evaluate(() => {
      const s = (window as any).__scroller as HTMLElement
      return { scrollTop: s.scrollTop, height: s.scrollHeight }
    })
    expect(held.height, 'the stream stopped growing while the reader was scrolled up').toBeGreaterThan(heightBefore)
    expect(Math.abs(held.scrollTop - parked), 'the scrolled-up reader was moved').toBeLessThanOrEqual(1)

    // Scrolled up only a little, the button still floats just above the composer.
    await page.evaluate(() => {
      const s = (window as any).__scroller as HTMLElement
      s.scrollTop = s.scrollHeight - s.clientHeight - 120
    })
    await expect(page.getByTestId('scroll-to-bottom-button')).toBeVisible()
    const nearPlacement = await jumpButtonPlacement(page)
    expect(Math.abs(nearPlacement.offCentre)).toBeLessThanOrEqual(2)
    expect(nearPlacement.aboveComposer, 'the jump button overlaps the composer').toBeGreaterThan(0)
    expect(nearPlacement.aboveComposer, 'the jump button is not just above the composer').toBeLessThanOrEqual(60)

    // One tap returns them to the bottom and following re-engages for the rest of the stream.
    await page.getByTestId('scroll-to-bottom-button').click()
    await expect.poll(() => gapToBottom(page)).toBeLessThanOrEqual(AT_BOTTOM_PX)
    await expect(page.getByTestId('scroll-to-bottom-button')).toBeHidden()
    await expect(page.getByText(STREAM_END)).toBeAttached({ timeout: 20_000 })
    await expect(page.getByText(STREAM_END)).toBeInViewport()
    await page.waitForTimeout(OBSERVATION_WINDOW_MS)
    expect(await gapToBottom(page)).toBeLessThanOrEqual(AT_BOTTOM_PX)
  } finally {
    cleanup()
  }
})

test('opening a long thread lands at the top with the jump button visible', async ({ page }) => {
  await mockBackend(page)
  await openLongThread(page)
  const position = await page.evaluate(() => {
    let scroller = document.querySelector('[data-testid="message-list-scroll"]') as HTMLElement
    while (
      scroller.parentElement &&
      !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)
    ) {
      scroller = scroller.parentElement
    }
    return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
  })
  expect(position.scrollHeight - position.clientHeight, 'the thread must be long enough to scroll').toBeGreaterThan(
    1000,
  )
  expect(position.scrollTop, 'opening a thread moved the reader').toBe(0)
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeInViewport()
  const placement = await jumpButtonPlacement(page)
  expect(Math.abs(placement.offCentre)).toBeLessThanOrEqual(2)
})
