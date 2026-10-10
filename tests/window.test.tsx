import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

// Far more text than a Client's props may carry (100,000 characters serialized).
const PARA = 'word '.repeat(200)
const MESSAGES: SessionMessage[] = []
for (let i = 0; i < 120; i++) {
  MESSAGES.push({ role: 'user', text: `prompt ${i} ${PARA}`, toolUses: [] })
  MESSAGES.push({ role: 'assistant', text: `reply ${i} **b** ${PARA}`, toolUses: [] })
}

function engine(on: On) {
  const submitted: string[] = []
  mock.clock(on)
  mock.store(on)
  on('session.messages', () => ({ value: MESSAGES }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  return submitted
}

describe('a long conversation', () => {
  test('is handed to the reader a window at a time; gg reaches the very start', async ($, on) => {
    const submitted = engine(on)
    await $.command.run({ command: 'annotate', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const ui = await $.ui.mount({
      plugin: 'reply-comments',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'reply-comments',
      props: { title: 'x', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as never,
      viewport: { columns: 120, rows: 40 },
    })
    const keys = async (typed: string) => {
      for (const ch of typed) {
        const field = await ui.find({ key: 'keys' })
        await ui.input({ key: 'keys', text: (field?.text ?? '') + ch, kind: 'change' })
      }
    }

    // opens on the last reply
    expect(await ui.find({ in: 'reader', text: /reply 119/ })).toBeDefined()
    expect(await ui.find({ in: 'reader', text: /prompt 0 / })).toBeUndefined()

    await keys('gg')
    expect(await ui.find({ in: 'reader', text: /prompt 0 / })).toBeDefined()

    await keys('vipc')
    const field = await ui.find({ key: 'field1' })
    await ui.input({ key: 'field1', text: `${field?.text ?? ''}first ask` })
    await keys('G')
    expect(await ui.find({ in: 'reader', text: /reply 119/ })).toBeDefined()
    expect(await ui.find({ in: 'reader', text: '1 comment' })).toBeDefined()

    await keys('s')
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain('On this part of my message "prompt 0 word')
    expect(submitted[0]).toContain('> prompt 0 word word')
    expect(submitted[0]).toContain('first ask')
    await ui.unmount()
  })
})
