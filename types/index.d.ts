export type ReplyComment = {
  /** Offset of the first selected character in the reply text. */
  start: number
  /** Offset just past the last selected character. */
  end: number
  /** The selected text, trimmed. */
  quote: string
  /** What the person wrote about it. */
  text: string
}

export type ReplyCommentsDraft = {
  /** The reply being annotated. */
  reply: string
  comments: ReplyComment[]
  overall: string
  /** Bumped whenever the hooks module replaces the draft, so the reader resets. */
  rev: number
}

declare module 'claude-code' {
  interface PluginState {
    'reply-comments': { draft: ReplyCommentsDraft }
  }
}
