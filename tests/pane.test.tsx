import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { LEGEND, buildPrompt, lastReply, legendLines, selectionRange, wrap } from '../hooks/lib'

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
  opens: { focus: boolean; closeOnEscape: boolean }[]
  closed: number
  toasts: string[]
  clock: MockClock
}

/** Answers the engine nouns the mod reaches beneath it, and records what it did. */
function engine(on: On, messages: SessionMessage[] = MESSAGES): Sent {
  const sent: Sent = { submitted: [], filled: [], opens: [], closed: 0, toasts: [], clock: mock.clock(on) }
  mock.store(on)
  on('session.messages', () => ({ value: messages }))
  on('ui.open', (_$, e) => {
    const o = e as { focus?: true; closeOnEscape?: true }
    sent.opens.push({ focus: o.focus === true, closeOnEscape: o.closeOnEscape === true })
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
  on('ui.focus', () => ({}))
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

type Ui = Awaited<ReturnType<typeof openPane>>['ui']

async function openPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyRows = 20) {
  const ran = await $.command.run(ANNOTATE)
  const ui = await $.ui.mount({
    plugin: 'reply-comments',
    surface,
    component: 'Pane',
    requestId: 'reply-comments',
    props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows } } as never,
    viewport: { columns: 60, rows: 40 },
  })
  await ui.resize({ columns: 40, rows: 11, in: 'reader' })
  return { ran, ui }
}

/** Types into the pane's key field, one key at a time, as the person does. */
async function keys(ui: Ui, typed: string) {
  for (const ch of typed) {
    const field = await ui.find({ key: 'keys' })
    if (!field) throw new Error(`no key field when typing ${JSON.stringify(ch)}`)
    await ui.input({ key: 'keys', text: (field.text ?? '') + ch, kind: 'change' })
  }
}

/** Fills the pane's field (comment, search or command) and presses Enter. */
async function field(ui: Ui, text: string) {
  await ui.input({ key: 'field', text })
}

const fieldText = (found: { text?: string } | undefined) => found?.text?.replace(/[\u200b\u200c\u200d\u2060]/g, '')

const status = async (ui: Ui, text: string | RegExp) => ui.find({ in: 'reader', text })

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

  test('selections trim whitespace and V takes whole lines', () => {
    expect(selectionRange('ab cd', 4, 2, false)).toEqual({ start: 3, end: 5 })
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

  test('the legend wraps within the width and keeps every group', () => {
    for (const width of [40, 60, 100]) {
      const rows = legendLines(width)
      for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(Math.max(10, width - 9) + 40)
      expect(rows.filter(r => r.group).map(r => r.group)).toEqual(LEGEND.map(g => g.group))
    }
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
    expect(ran.text).toContain('? shows them all')
    expect(sent.opens).toEqual([{ focus: false, closeOnEscape: true }])
    await sent.clock.advance(300)
    expect(sent.opens).toEqual([
      { focus: false, closeOnEscape: true },
      { focus: true, closeOnEscape: true },
    ])
  })

  test('the legend is hidden until ? toggles it', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    expect(await ui.find({ type: 'Text', text: 'Move' })).toBeUndefined()
    expect((await ui.find({ key: 'keys' }))?.text).toBeDefined()
    await keys(ui, '?')
    expect(await ui.find({ type: 'Text', text: /^Move/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gg G/ })).toBeDefined()
    await keys(ui, '?')
    expect(await ui.find({ type: 'Text', text: /^Move/ })).toBeUndefined()
    await ui.unmount()
  })

  test('the reader always fills the pane exactly, legend or not', async ($, on) => {
    engine(on)
    const { ui } = await openPane($, 'terminal', 15)
    const height = async () => {
      const tree = (await ui.drawn()) as { children: { props: { height?: number } }[] }
      return tree.children[0]!.props.height
    }
    expect(await height()).toBe(14)
    await keys(ui, '?')
    expect(await height()).toBe(14 - legendLines(60).length)
    await ui.unmount()
  })

  test('vim keys from the key field: j G gg, then vip c, a comment, s', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)

    await keys(ui, 'j')
    expect(await status(ui, '· 2/')).toBeDefined()
    await keys(ui, 'G')
    expect(await status(ui, /· (\d+)\/\1/)).toBeDefined()
    await keys(ui, 'gg')
    expect(await status(ui, '· 1/')).toBeDefined()

    await keys(ui, 'vip')
    expect(await status(ui, 'VISUAL')).toBeDefined()
    await keys(ui, 'c')
    expect(await ui.find({ key: 'field' })).toBeDefined()
    expect(await ui.find({ key: 'keys' })).toBeUndefined()
    await field(ui, 'too vague')
    expect(await ui.find({ key: 'keys' })).toBeDefined()
    expect(await status(ui, '1 comment')).toBeDefined()

    await keys(ui, 's')
    expect(sent.submitted).toEqual([
      'I left a comment on part of your last reply:\n\n1. On this part:\n> First paragraph about the plan.\n\ntoo vague',
    ])
    expect(sent.closed).toBe(1)
    await ui.unmount()
  })

  test('ciw from the key field, then :p puts the prompt in the box', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await keys(ui, 'wciw')
    expect(fieldText(await ui.find({ key: 'field' }))).toBe('')
    await field(ui, 'which one?')
    await keys(ui, ':')
    expect(await ui.find({ key: 'field' })).toBeDefined()
    await field(ui, 'p')
    expect(sent.filled).toEqual(['I left a comment on part of your last reply:\n\n1. On this part:\n> paragraph\n\nwhich one?'])
    await ui.unmount()
  })

  test('a cancelled input leaves nothing behind in the next one', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await keys(ui, 'ciw')
    const first = (await ui.find({ key: 'field' }))?.text ?? ''
    await ui.input({ key: 'field', text: `${first}half typed`, kind: 'change' })
    // ctrl+c on the reader runs the same escape as Esc does through the pane
    await ui.key({ key: 'c', ctrl: true, in: 'reader' })
    expect(await status(ui, 'Cancelled')).toBeDefined()
    await keys(ui, 'ciw')
    const second = (await ui.find({ key: 'field' }))?.text ?? ''
    expect(second).not.toBe(first)
    expect(fieldText({ text: second })).toBe('')
    await field(ui, `${second}kept`)
    await keys(ui, 's')
    expect(sent.submitted[0]).toContain('\n\nkept')
    await ui.unmount()
  })

  test('/ search moves the cursor; n repeats', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await keys(ui, '/')
    await field(ui, 'paragraph')
    expect(await status(ui, '· 1/')).toBeDefined()
    await keys(ui, 'n')
    expect(await status(ui, '· 3/')).toBeDefined()
    await ui.unmount()
  })

  test('Enter in the key field reaches the reader', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await keys(ui, 'v$')
    await ui.input({ key: 'keys', text: (await ui.find({ key: 'keys' }))?.text ?? '' })
    expect(await ui.find({ key: 'field' })).toBeDefined()
    await ui.unmount()
  })

  test('keys typed faster than the field clears are each counted once', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    const drawn = (await ui.find({ key: 'keys' }))?.text ?? ''
    await ui.input({ key: 'keys', text: `${drawn}j`, kind: 'change' })
    await ui.input({ key: 'keys', text: `${drawn}jj`, kind: 'change' })
    expect(await status(ui, '· 3/')).toBeDefined()
    await ui.unmount()
  })

  test('with the reader clicked: keys go to it directly, the comment is typed in place', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    for (const key of ['v', 'e', 'c', 'n', 'o', 'p', 'e']) await ui.key({ key, in: 'reader' })
    expect(await status(ui, '> nope█')).toBeDefined()
    await ui.key({ key: 'return', in: 'reader' })
    await ui.key({ key: 's', in: 'reader' })
    expect(sent.submitted[0]).toContain('> First\n\nnope')
    await ui.unmount()
  })

  test('mouse: drag across a span opens a comment on it', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await ui.pointer({ type: 'down', x: 6, y: 0, button: 'left', in: 'reader' })
    await ui.pointer({ type: 'move', x: 10, y: 0, button: 'left', in: 'reader' })
    await ui.pointer({ type: 'up', x: 14, y: 0, button: 'left', in: 'reader' })
    expect(await status(ui, 'COMMENT')).toBeDefined()
    for (const key of ['o', 'k']) await ui.key({ key, in: 'reader' })
    await ui.key({ key: 'return', in: 'reader' })
    await keys(ui, 's')
    expect(sent.submitted[0]).toContain('> paragraph\n\nok')
    await ui.unmount()
  })

  test('unsent comments survive closing and reopening; :clear drops them', async ($, on) => {
    const sent = engine(on)
    const first = await openPane($)
    await keys(first.ui, 'cip')
    await field(first.ui, 'keep me')
    await keys(first.ui, 'q')
    expect(sent.closed).toBe(1)
    await first.ui.unmount()

    const again = await openPane($)
    expect(again.ran.text).toContain('Picked up your 1 unsent')
    expect(await status(again.ui, '1 comment')).toBeDefined()
    await keys(again.ui, ':')
    await field(again.ui, 'clear')
    expect(await status(again.ui, '0 comments')).toBeDefined()
    await again.ui.unmount()
  })

  test('nothing to send stays put', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await keys(ui, 's')
    expect(await status(ui, 'Nothing to send yet')).toBeDefined()
    expect(sent.submitted).toHaveLength(0)
    await ui.unmount()
  })

  test('the desktop draws the same reader', async ($, on) => {
    engine(on)
    const { ui } = await openPane($, 'desktop')
    expect(await status(ui, 'NORMAL')).toBeDefined()
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
