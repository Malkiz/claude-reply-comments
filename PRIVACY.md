# Privacy

claude-reply-comments is a Claude Code mod that runs entirely inside your own Claude Code session. Its author collects nothing.

- **What it reads:** the current conversation, through Claude Code's hooks API, so it can show it in the pane. That conversation may contain anything you or Claude wrote, including personal data.
- **What it keeps:** your unsent comments and the pane's state, in Claude Code's session state. They're gone when the session ends. Nothing is written to disk by the mod, and nothing is kept across sessions.
- **What it sends:** only the prompt you send with `s` (or `:w`), to Claude in the same session, exactly like a prompt you type. It contains the parts you selected, quoted, with your comments. See [What it reads and runs](README.md#what-it-reads-and-runs) for the exact contents.
- **What it doesn't do:** make network requests, call a model, read or write files, run commands, or send anything to the author or any third party.

What happens to the prompt after you send it is governed by your Claude account and Anthropic's privacy policy, as with any prompt.

Questions: open an issue at https://github.com/Malkiz/claude-reply-comments/issues.
