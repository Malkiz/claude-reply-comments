export type ReplyComment = {
  /** Offset of the first selected character in the conversation text. */
  start: number
  /** Offset just past the last selected character. */
  end: number
  /** The selected text, trimmed. */
  quote: string
  /** What the person wrote about it. */
  text: string
}

/** One message of the conversation, where it sits in the annotated text. */
export type ReplyCommentsPart = {
  /** The person's prompt, a block of Claude's reply text, or one tool call. */
  role: 'user' | 'assistant' | 'tool'
  start: number
  end: number
  /** A tool call that ended in an error. */
  isError?: true
}

/** A styled span of the annotated text: markdown drawn, a tool name, a result line. */
export type ReplyCommentsMark = {
  start: number
  end: number
  style: 'bold' | 'heading' | 'code' | 'dim'
}

export type ReplyCommentsDraft = {
  /** The conversation being annotated, as one text. */
  reply: string
  /** Where each message sits in `reply`. */
  parts: ReplyCommentsPart[]
  marks: ReplyCommentsMark[]
  comments: ReplyComment[]
  overall: string
  /** Bumped whenever the hooks module replaces the draft, so the reader resets. */
  rev: number
}

/** One key typed in the pane's key field, handed on to the reader. */
export type ReplyCommentsRelayed = {
  seq: number
  key: string
  /** The text of a field, for the `submit` key; the rows, for the `wheel` key. */
  text?: string
}

/** What the reader reports about itself, so the pane draws around it. */
export type ReplyCommentsView = {
  mode: 'normal' | 'visual' | 'vline' | 'input'
  /** In input mode: a comment, a `/` search or a `:` command. */
  inputKind?: 'comment' | 'search' | 'command'
  /** Where the input is typed: the pane's field, or the reader itself. */
  via: 'pane' | 'reader'
  /** What a comment is about. */
  target: 'comment' | 'edit' | 'overall'
  /** The text the field starts with. */
  draft: string
  /** Keys typed toward a command not yet complete (`g`, `ci`, `3`). */
  pending: string
}

declare module 'claude-code' {
  interface PluginState {
    'reply-comments': {
      draft: ReplyCommentsDraft
      relay: ReplyCommentsRelayed[]
      view: ReplyCommentsView
      /** Whether the key legend is shown. */
      legend: boolean
      /** What the key field holds as drawn: '' or a zero-width space, alternating so each draw clears it. */
      keysDrawn: string
      /** The zero-width mark the field (comment, search, command) starts with, new for each input. */
      fieldMark: string
    }
  }
}
