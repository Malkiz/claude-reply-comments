import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { GROUP_COLUMN, LEGEND, buildPrompt, lastReply, legendRows, paragraphAt, selectionRange, wrap } from '../hooks/lib'

const REPLY = [
  'First paragraph about the plan.',
  '',
  'Second paragraph that is quite a bit longer and has to wrap on a narrow pane.',
  '',
  'Third.',
].join('\n')

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'old prompt', toolUses: [] },
  { role: 'assistant', text: 'old answer', toolUses: [] },
  { role: 'user', text: 'explain the plan', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false, result: null } as never] },
  { role: 'assistant', text: REPLY, toolUses: [] },
]

const ANNOTATE = {
  command: 'annotate',
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
}

const PANE_PROPS = {
  title: 'Annotate reply',
  isFocused: true,
  bodyColumns: 60,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

type Sent = {
  submitted: string[]
  filled: string[]
  opens: { focus?: boolean }[]
  closed: number
  toasts: string[]
  focused: string[]
  clock: MockClock
}

/** Answers the engine nouns the mod reaches beneath it, and records what it did. */
function engine(on: On, messages: SessionMessage[] = MESSAGES): Sent {
  const sent: Sent = { submitted: [], filled: [], opens: [], closed: 0, toasts: [], focused: [], clock: mock.clock(on) }
  on('session.messages', () => ({ value: messages }))
  on('ui.open', (_$, e) => {
    sent.opens.push({ focus: (e as { focus?: true }).focus === true })
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => {
    sent.closed++
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    sent.toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.focus', (_$, e) => {
    const w = e as { key?: string; element?: string }
    const target = w.key ?? w.element
    if (target) sent.focused.push(target)
    return {}
  })
  on('prompt.submit', (_$, e) => {
    sent.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('prompt.fill', (_$, e) => {
    sent.filled.push(e.text)
    return { isFilled: true } as never
  })
  return sent
}

async function openPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  const ran = await $.command.run(ANNOTATE)
  const ui = await $.ui.mount({
    plugin: 'reply-comments',
    surface,
    component: 'Pane',
    requestId: 'reply-comments',
    props: PANE_PROPS as never,
    viewport: { columns: 60, rows: 40 },
  })
  await ui.resize({ columns: 40, rows: 11, in: 'reader' })
  return { ran, ui }
}

type Keys = { key: (e: { key: string; ctrl?: true; in?: string }) => Promise<void> }

/** Keys pressed with the reader holding the keyboard (after a click). */
async function type(ui: Keys, text: string) {
  for (const ch of text) await ui.key({ key: ch === ' ' ? 'space' : ch, in: 'reader' })
}

/** Keys pressed on the pane's legend, as its hotkeys do. */
async function legend(ui: { press: (t: { key: string }) => Promise<unknown> }, keys: string) {
  for (const k of keys) await ui.press({ key: `key-${k}` })
}

describe('lib', () => {
  test('lastReply joins the turn and stops at the prompt', () => {
    expect(lastReply(MESSAGES)).toBe(REPLY)
    expect(lastReply([{ role: 'user', text: 'hi' }])).toBe('')
    expect(
      lastReply([
        { role: 'user', text: 'q', toolUses: [] },
        { role: 'assistant', text: 'part one', toolUses: [] },
        { role: 'user', text: '', toolUses: [], toolResults: [{} as never] },
        { role: 'assistant', text: 'part two', toolUses: [] },
        { role: 'user', text: '<command-name>/annotate</command-name>', toolUses: [] },
      ]),
    ).toBe('part one\n\npart two')
  })

  test('wrap keeps rows within the width and covers every character', () => {
    const lines = wrap(REPLY, 20)
    for (const l of lines) expect(l.end - l.start).toBeLessThanOrEqual(20)
    const shown = lines.map(l => REPLY.slice(l.start, l.end)).join('')
    expect(shown.replace(/\s/g, '')).toBe(REPLY.replace(/\s/g, ''))
  })

  test('selections and paragraphs trim whitespace', () => {
    expect(selectionRange('ab cd', 4, 2, false)).toEqual({ start: 3, end: 5 })
    const p = paragraphAt(REPLY, REPLY.indexOf('quite'))
    expect(REPLY.slice(p.start, p.end)).toBe(
      'Second paragraph that is quite a bit longer and has to wrap on a narrow pane.',
    )
    const v = selectionRange('one\ntwo\nthree', 5, 5, true)
    expect('one\ntwo\nthree'.slice(v.start, v.end)).toBe('two')
  })

  test('buildPrompt quotes each span above its comment, in reply order', () => {
    const text = buildPrompt(
      [
        { start: 10, end: 15, quote: 'later\nline', text: 'second' },
        { start: 0, end: 5, quote: 'first', text: 'one' },
      ],
      'looks good',
    )
    expect(text).toBe(
      'I left 2 comments on parts of your last reply:\n\n' +
        '1. On this part:\n> first\n\none\n\n' +
        '2. On this part:\n> later\n> line\n\nsecond\n\n' +
        'Overall: looks good',
    )
    expect(buildPrompt([], 'just this')).toBe('just this')
  })

  test('the legend uses distinct hotkeys a Button takes, and its rows fit', () => {
    const keys = LEGEND.flatMap(g => g.keys.map(k => k.key))
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]$/)
    for (const compact of [false, true]) {
      for (const width of [40, 60, 100]) {
        const rows = legendRows(width, compact)
        const placed = rows.flat().flatMap(item => ('key' in item ? [item.key.key] : []))
        expect(placed).toEqual(keys)
        for (const row of rows) {
          const cells = row.reduce(
            (n, item) =>
              n +
              ('group' in item
                ? compact
                  ? item.group.length + 2
                  : GROUP_COLUMN
                : item.key.key.length + 2 + (compact ? item.key.short : item.key.label).length + 2),
            0,
          )
          expect(row.length <= 2 || cells <= width).toBe(true)
        }
      }
    }
    expect(legendRows(100, true).length).toBeLessThan(legendRows(100).length)
  })
})

describe('annotate', () => {
  test('says so when there is no reply yet', async ($, on) => {
    engine(on, [{ role: 'user', text: 'hello', toolUses: [] }])
    const ran = await $.command.run(ANNOTATE)
    expect(ran.text).toContain('no reply')
  })

  test('opens the pane, then asks for the keyboard once the command is done', async ($, on) => {
    const sent = engine(on)
    const ran = await $.command.run(ANNOTATE)
    expect(ran.text).toContain('keys are listed at the bottom')
    expect(sent.opens).toEqual([{ focus: false }])
    await sent.clock.advance(300)
    expect(sent.opens).toEqual([{ focus: false }, { focus: true }])
  })

  test('the legend lists every key at the bottom of the pane', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    for (const { keys } of LEGEND) {
      for (const k of keys) expect((await ui.find({ key: `key-${k.key}` }))?.text).toBe(k.label)
    }
    expect(await ui.find({ type: 'Text', text: 'Move' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Finish' })).toBeDefined()
    await ui.unmount()
  })

  test('a short pane gets the compact legend, still every key', async ($, on) => {
    engine(on)
    await $.command.run(ANNOTATE)
    const ui = await $.ui.mount({
      plugin: 'reply-comments',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'reply-comments',
      props: { ...PANE_PROPS, bodyColumns: 98, scroll: { offset: 0, bodyRows: 10 } } as never,
    })
    for (const { keys } of LEGEND) {
      for (const k of keys) expect((await ui.find({ key: `key-${k.key}` }))?.text).toBe(k.short)
    }
    await ui.unmount()
  })

  test('keyboard only: legend keys move, select, comment in the field, send', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)

    await legend(ui, 'j')
    expect(await ui.find({ in: 'reader', text: 'line 2/' })).toBeDefined()
    await legend(ui, 'g')

    // select "First" with v and four steps right, then comment
    await legend(ui, 'vllll')
    expect(await ui.find({ in: 'reader', text: 'VISUAL' })).toBeDefined()
    await legend(ui, 'c')
    expect(await ui.find({ key: 'comment' })).toBeDefined()
    expect(await ui.find({ key: 'key-j' })).toBeUndefined()

    await ui.input({ key: 'comment', text: 'too vague' })
    expect(await ui.find({ key: 'comment' })).toBeUndefined()
    expect(await ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()

    await legend(ui, 's')
    expect(sent.submitted).toEqual(['I left a comment on part of your last reply:\n\n1. On this part:\n> First\n\ntoo vague'])
    expect(sent.closed).toBe(1)
    await ui.unmount()
  })

  test('keyboard only: paragraph select, overall comment, revise, delete, to prompt', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)

    await legend(ui, 'nac')
    await ui.input({ key: 'comment', text: 'split this' })

    await legend(ui, 'o')
    expect((await ui.find({ key: 'comment' }))?.text).toBe('')
    await ui.input({ key: 'comment', text: 'nice overall' })
    expect(await ui.find({ in: 'reader', text: '1 comment + overall' })).toBeDefined()

    await legend(ui, 'gr')
    expect(await ui.find({ in: 'reader', text: 'No comment under the cursor' })).toBeDefined()
    await legend(ui, 'm')
    expect(await ui.find({ in: 'reader', text: 'split this' })).toBeDefined()
    await legend(ui, 'r')
    expect((await ui.find({ key: 'comment' }))?.text).toBe('split this')
    await ui.input({ key: 'comment', text: 'split in two' })

    // a comment on "Third." with c on its paragraph, then removed again
    await legend(ui, 'ec')
    await ui.input({ key: 'comment', text: 'drop me' })
    expect(await ui.find({ in: 'reader', text: '2 comments' })).toBeDefined()
    await legend(ui, 'x')
    expect(await ui.find({ in: 'reader', text: '1 comment + overall' })).toBeDefined()

    await legend(ui, 'f')
    expect(sent.filled).toHaveLength(1)
    expect(sent.filled[0]).toContain('> Second paragraph that is quite')
    expect(sent.filled[0]).toContain('split in two')
    expect(sent.filled[0]).toContain('Overall: nice overall')
    expect(sent.submitted).toHaveLength(0)
    await ui.unmount()
  })

  test('an empty comment from the field cancels', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await legend(ui, 'c')
    await ui.input({ key: 'comment', text: '' })
    expect(await ui.find({ in: 'reader', text: 'Empty comment discarded' })).toBeDefined()
    expect(await ui.find({ in: 'reader', text: '0 comments' })).toBeDefined()
    expect(await ui.find({ key: 'key-j' })).toBeDefined()
    await ui.unmount()
  })

  test('with the reader clicked: v, c, type in place, s sends', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)

    await type(ui, 'vllllc')
    expect(await ui.find({ in: 'reader', text: 'comment>' })).toBeDefined()
    expect(await ui.find({ key: 'comment' })).toBeUndefined()
    await type(ui, 'too vague')
    await ui.key({ key: 'return', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()

    await type(ui, 's')
    expect(sent.submitted).toEqual(['I left a comment on part of your last reply:\n\n1. On this part:\n> First\n\ntoo vague'])
    await ui.unmount()
  })

  test('mouse: drag across a span opens a comment on it', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)

    // row 0 is "First paragraph about the plan."; drag over "paragraph"
    await ui.pointer({ type: 'down', x: 6, y: 0, button: 'left', in: 'reader' })
    await ui.pointer({ type: 'move', x: 10, y: 0, button: 'left', in: 'reader' })
    await ui.pointer({ type: 'up', x: 14, y: 0, button: 'left', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: 'COMMENT' })).toBeDefined()
    await type(ui, 'rename')
    await ui.key({ key: 'return', in: 'reader' })

    await legend(ui, 's')
    expect(sent.submitted[0]).toContain('> paragraph\n\nrename')
    await ui.unmount()
  })

  test('a click without a drag only moves the cursor', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await ui.pointer({ type: 'down', x: 3, y: 0, button: 'left', in: 'reader' })
    await ui.pointer({ type: 'up', x: 3, y: 0, button: 'left', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: 'NORMAL' })).toBeDefined()
    await ui.unmount()
  })

  test('backspace on an empty draft cancels; nothing to send stays put', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await type(ui, 'c')
    await ui.key({ key: 'backspace', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: 'Comment cancelled' })).toBeDefined()
    await type(ui, 's')
    expect(await ui.find({ in: 'reader', text: 'Nothing to send yet' })).toBeDefined()
    await legend(ui, 's')
    expect(sent.toasts.join()).toContain('nothing to send')
    expect(sent.submitted).toHaveLength(0)
    expect(sent.closed).toBe(0)
    await ui.unmount()
  })

  test('unsent comments survive closing and reopening the pane', async ($, on) => {
    const sent = engine(on)
    const first = await openPane($)
    await legend(first.ui, 'c')
    await first.ui.input({ key: 'comment', text: 'keep me' })
    await legend(first.ui, 'q')
    expect(sent.closed).toBe(1)
    await first.ui.unmount()

    const again = await openPane($)
    expect(again.ran.text).toContain('Picked up your 1 unsent')
    expect(await again.ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()
    await again.ui.unmount()
  })

  test('z clears every comment, and the reader follows', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await legend(ui, 'c')
    await ui.input({ key: 'comment', text: 'one' })
    expect(await ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()
    await legend(ui, 'z')
    expect(await ui.find({ in: 'reader', text: '0 comments' })).toBeDefined()
    await ui.unmount()
  })

  test('a long reply scrolls with the cursor', async ($, on) => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    engine(on, [
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: long, toolUses: [] },
    ])
    const { ui } = await openPane($)
    expect(await ui.find({ in: 'reader', text: 'line 1/60 ↓' })).toBeDefined()
    expect(await ui.find({ in: 'reader', text: 'line 30' })).toBeUndefined()
    await legend(ui, 'e')
    expect(await ui.find({ in: 'reader', text: 'line 60/60' })).toBeDefined()
    await legend(ui, 'u')
    expect(await ui.find({ in: 'reader', text: 'line 51/60' })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop draws the same reader and legend', async ($, on) => {
    engine(on)
    const { ui } = await openPane($, 'desktop')
    expect(await ui.find({ in: 'reader', text: 'NORMAL' })).toBeDefined()
    expect(await ui.find({ key: 'key-s' })).toBeDefined()
    await ui.unmount()
  })

  test('mobile, which has no Client, shows the reply as Markdown', async ($, on) => {
    engine(on)
    await $.command.run(ANNOTATE)
    const ui = await $.ui.mount({
      plugin: 'reply-comments',
      surface: 'mobile',
      component: 'Pane',
      requestId: 'reply-comments',
      props: PANE_PROPS as never,
    })
    expect(await ui.find({ type: 'Markdown', text: /Third/ })).toBeDefined()
    await ui.unmount()
  })
})
