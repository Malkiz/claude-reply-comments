import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { buildPrompt, lastReply, paragraphAt, selectionRange, wrap } from '../hooks/lib'

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
  bodyColumns: 40,
  placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

type Sent = { submitted: string[]; filled: string[]; opened: number; closed: number; toasts: string[] }

/** Answers the engine nouns the mod reaches beneath it, and records prompts. */
function engine(on: On, messages: SessionMessage[] = MESSAGES): Sent {
  const sent: Sent = { submitted: [], filled: [], opened: 0, closed: 0, toasts: [] }
  on('session.messages', () => ({ value: messages }))
  on('ui.open', () => {
    sent.opened++
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
    viewport: { columns: 40, rows: 40 },
  })
  await ui.resize({ columns: 40, rows: 11, in: 'reader' })
  return { ran, ui }
}

async function type(ui: { key: (e: { key: string; in?: string }) => Promise<void> }, text: string) {
  for (const ch of text) await ui.key({ key: ch === ' ' ? 'space' : ch, in: 'reader' })
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
})

describe('annotate', () => {
  test('says so when there is no reply yet', async ($, on) => {
    engine(on, [{ role: 'user', text: 'hello', toolUses: [] }])
    const ran = await $.command.run(ANNOTATE)
    expect(ran.text).toContain('no reply')
  })

  test('keyboard: select with v, comment, send one prompt', async ($, on) => {
    const sent = engine(on)
    const { ran, ui } = await openPane($)
    expect(ran.text).toContain('Click the reply')
    expect(await ui.find({ in: 'reader', text: 'NORMAL' })).toBeDefined()

    // select "First" (cursor on F, v, 4 x l), then comment it
    await type(ui, 'vllll')
    expect(await ui.find({ in: 'reader', text: 'VISUAL' })).toBeDefined()
    await ui.key({ key: 'c', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: 'COMMENT' })).toBeDefined()
    await type(ui, 'too vague')
    await ui.key({ key: 'return', in: 'reader' })

    expect(await ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()
    expect((await ui.find({ key: 'send' }))?.text).toBe('Send 1')

    await ui.key({ key: 's', in: 'reader' })
    expect(sent.submitted).toEqual(['I left a comment on part of your last reply:\n\n1. On this part:\n> First\n\ntoo vague'])
    expect(sent.closed).toBe(1)
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

    await ui.press({ key: 'send' })
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

  test('paragraph comment, overall comment, edit and delete, then fill the prompt box', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)

    await type(ui, '}p')
    await type(ui, 'split this')
    await ui.key({ key: 'return', in: 'reader' })

    await type(ui, 'o')
    await type(ui, 'nice overall')
    await ui.key({ key: 'return', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: '1 comment + overall' })).toBeDefined()

    // back on the commented paragraph: edit it
    await type(ui, 'ge')
    expect(await ui.find({ in: 'reader', text: 'No comment under the cursor' })).toBeDefined()
    await type(ui, '}e')
    await ui.key({ key: 'backspace', in: 'reader' })
    await type(ui, 'S')
    await ui.key({ key: 'return', in: 'reader' })

    // a comment on "Third." then removed again
    await type(ui, 'Gp')
    await type(ui, 'drop me')
    await ui.key({ key: 'return', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: '2 comments' })).toBeDefined()
    await type(ui, 'x')
    expect(await ui.find({ in: 'reader', text: '1 comment + overall' })).toBeDefined()

    await type(ui, 'f')
    expect(sent.filled).toHaveLength(1)
    expect(sent.filled[0]).toContain('> Second paragraph that is quite')
    expect(sent.filled[0]).toContain('split thiS')
    expect(sent.filled[0]).toContain('Overall: nice overall')
    expect(sent.submitted).toHaveLength(0)
    await ui.unmount()
  })

  test('backspace on an empty draft cancels; nothing to send stays put', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await type(ui, 'p')
    await ui.key({ key: 'backspace', in: 'reader' })
    expect(await ui.find({ in: 'reader', text: 'Comment cancelled' })).toBeDefined()
    await type(ui, 's')
    expect(await ui.find({ in: 'reader', text: 'Nothing to send yet' })).toBeDefined()
    expect(sent.submitted).toHaveLength(0)
    await ui.unmount()
  })

  test('unsent comments survive closing and reopening the pane', async ($, on) => {
    engine(on)
    const first = await openPane($)
    await type(first.ui, 'p')
    await type(first.ui, 'keep me')
    await first.ui.key({ key: 'return', in: 'reader' })
    await first.ui.unmount()

    const again = await openPane($)
    expect(again.ran.text).toContain('Picked up your 1 unsent')
    expect(await again.ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()
    await again.ui.unmount()
  })

  test('help opens with ? and closes on any key', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await type(ui, '?')
    expect(await ui.find({ in: 'reader', text: /Finish/ })).toBeDefined()
    await type(ui, 'j')
    expect(await ui.find({ in: 'reader', text: 'NORMAL' })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop draws the same reader', async ($, on) => {
    engine(on)
    const { ui } = await openPane($, 'desktop')
    expect(await ui.find({ in: 'reader', text: 'NORMAL' })).toBeDefined()
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

describe('pane', () => {
  test('Clear drops every comment, and the reader follows', async ($, on) => {
    engine(on)
    const { ui } = await openPane($)
    await type(ui, 'p')
    await type(ui, 'one')
    await ui.key({ key: 'return', in: 'reader' })
    expect((await ui.find({ key: 'send' }))?.text).toBe('Send 1')

    await ui.press({ key: 'clear' })
    expect((await ui.find({ key: 'send' }))?.text).toBe('Send')
    expect(await ui.find({ in: 'reader', text: '0 comments' })).toBeDefined()
    await ui.unmount()
  })

  test('Send with nothing written toasts and keeps the pane', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await ui.press({ key: 'send' })
    expect(sent.submitted).toHaveLength(0)
    expect(sent.closed).toBe(0)
    expect(sent.toasts.join()).toContain('nothing to send')
    await ui.unmount()
  })

  test('q closes the pane and keeps the draft', async ($, on) => {
    const sent = engine(on)
    const { ui } = await openPane($)
    await type(ui, 'p')
    await type(ui, 'later')
    await ui.key({ key: 'return', in: 'reader' })
    await type(ui, 'q')
    expect(sent.closed).toBe(1)
    expect(sent.submitted).toHaveLength(0)
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
    await type(ui, 'G')
    expect(await ui.find({ in: 'reader', text: 'line 60' })).toBeDefined()
    expect(await ui.find({ in: 'reader', text: 'line 60/60' })).toBeDefined()
    await ui.key({ key: 'u', ctrl: true, in: 'reader' })
    expect(await ui.find({ in: 'reader', text: 'line 56/60' })).toBeDefined()
    await ui.unmount()
  })
})
