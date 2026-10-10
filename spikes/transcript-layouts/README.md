# Spike: transcript layouts (Claude Code 2.1.286)

Throwaway mod used on 2026-10-10 to test where an annotation UI can live. Not part of the mod; kept so the same tests can be rerun on a newer Claude Code. The findings are in the vault note `Projects/ClaudeReplyComments/layout-approaches.md`.

```sh
claude --plugin-dir spikes/transcript-layouts   # run in the fullscreen layout, 120+ columns
```

| Command | Tests |
| --- | --- |
| `/tcursor` | A vim cursor drawn on transcript messages (`ui.render` on `AssistantMessage` / `UserMessage`). Keys from the band above the prompt (after `ctrl+x tab`) and from the prompt box (`prompt.edit`). The band row shows the message index, the last keys and their route (`b:` band, `p:` prompt box), redraw time and whether `$.ui.scroll` was allowed. `q` turns it off. |
| `/tkeys` | A docked pane that only catches keys (asks for `columns: 30`), driving the same transcript cursor. |
| `/tfull` | A pane asking for `columns: 500`; prints the width it got. |
| `/tover` | Toggles a full-viewport overlay: a `position="absolute"` Box drawn from the command's own output row. |
