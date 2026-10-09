import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReplyComment, ReplyCommentsDraft } from '../types'
import { buildPrompt, lastReply } from './lib'
import type { ReaderPost } from './reader'

const PANE = 'reply-comments'
const COMMAND = 'annotate'

const EMPTY: ReplyCommentsDraft = { reply: '', comments: [], overall: '', rev: 0 }
const draft = atom({ plugin: 'reply-comments', key: 'draft' } as const, EMPTY)

type $ = EngineInterface

function isComment(v: unknown): v is ReplyComment {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.start === 'number' &&
    typeof c.end === 'number' &&
    typeof c.quote === 'string' &&
    typeof c.text === 'string'
  )
}

function asPost(data: unknown): ReaderPost | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.comments) || !d.comments.every(isComment) || typeof d.overall !== 'string') {
    return undefined
  }
  const action = d.action === 'send' || d.action === 'fill' || d.action === 'close' ? d.action : undefined
  return { comments: d.comments, overall: d.overall, action }
}

async function clearDraft($: $) {
  await update($, draft, d => ({ ...d, comments: [], overall: '', rev: d.rev + 1 }))
}

async function send($: $) {
  const d = await read($, draft)
  if (d.comments.length === 0 && !d.overall.trim()) {
    $.ui.toast('reply-comments: nothing to send yet')
    return
  }
  const text = buildPrompt(d.comments, d.overall)
  await $.ui.close({ id: PANE })
  await clearDraft($)
  void $.prompt.submit({ text, asUser: true }).catch(() => {
    $.ui.toast('reply-comments: the prompt could not be sent')
  })
}

async function fill($: $) {
  const d = await read($, draft)
  if (d.comments.length === 0 && !d.overall.trim()) {
    $.ui.toast('reply-comments: nothing to put in the prompt yet')
    return
  }
  const filled = await $.prompt.fill({ text: buildPrompt(d.comments, d.overall) })
  if (!filled.isFilled) {
    $.ui.toast('reply-comments: the prompt box did not take the text; your comments are kept')
    return
  }
  await $.ui.close({ id: PANE })
  await clearDraft($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: "Comment on parts of Claude's last reply, then send the comments as one prompt",
    })

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const messages = await $.session.messages()
    const reply = Array.isArray(messages) ? lastReply(messages) : ''
    if (!reply) return { text: 'There is no reply to annotate yet.' }

    const before = await read($, draft)
    const isResumed = before.reply === reply && (before.comments.length > 0 || before.overall.trim() !== '')
    await update($, draft, d =>
      d.reply === reply ? { ...d, rev: d.rev + 1 } : { reply, comments: [], overall: '', rev: d.rev + 1 },
    )
    await $.ui.open({ id: PANE, title: 'Annotate reply', focus: true, holdToasts: true, rows: 30 })

    return {
      text: isResumed
        ? `Picked up your ${before.comments.length} unsent comment(s). Click the reply to take the keyboard, ? for keys.`
        : 'Click the reply to take the keyboard, then drag or press v to select. ? shows the keys.',
    }
  })

  on('ui.message', { requestId: PANE }, async ($, e) => {
    const post = asPost(e.data)
    if (!post) return {}

    await update($, draft, d => ({ ...d, comments: post.comments, overall: post.overall }))
    if (post.action === 'send') await send($)
    if (post.action === 'fill') await fill($)
    if (post.action === 'close') await $.ui.close({ id: PANE })

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const d = await read($, draft)
    const count = d.comments.length + (d.overall.trim() ? 1 : 0)
    const hasAny = count > 0

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Box, Button, Client } = $.ui.resolve(e)
      const readerRows = Math.max(4, e.props.scroll.bodyRows - 1)

      return (
        <Box flexDirection="column">
          <Client
            key="reader"
            module="./reader.tsx"
            props={{ reply: d.reply, comments: d.comments, overall: d.overall, rev: d.rev }}
            width="100%"
            height={readerRows}
          />
          <Box flexDirection="row" gap={1}>
            <Button key="send" hotkey="s" variant="primary" onPress={() => send($)}>
              {hasAny ? `Send ${count}` : 'Send'}
            </Button>
            <Button key="fill" hotkey="f" onPress={() => fill($)}>
              To prompt
            </Button>
            <Button key="clear" hotkey="c" onPress={() => clearDraft($)}>
              Clear
            </Button>
            <Button key="close" hotkey="q" role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
              Close
            </Button>
          </Box>
        </Box>
      )
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>Selecting spans needs the terminal or the desktop app.</Text>
        <Markdown text={d.reply} />
      </Box>
    )
  })
}
