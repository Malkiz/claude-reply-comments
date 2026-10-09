# claude-reply-comments

A Claude Code mod for commenting inline on parts of Claude's last reply, the way a PR review or Notion comments work. All the comments then go back to Claude as one prompt.

Requires Claude Code with mods (function hooks): 2.1.286 or later. Built for the terminal (tmux on macOS), and it also draws in the desktop Code tab.

## Use

`/annotate` opens a pane with Claude's last reply. Click the text to give it the keyboard.

| Do | How |
| --- | --- |
| Select with the mouse | Drag over the text. A comment draft opens. |
| Move | `h j k l` / arrows, `w b`, `0 $`, `{ }`, `g G`, `ctrl+d/u` |
| Select with the keyboard | `v` selects characters, `V` selects lines. Then `c` or Enter to comment. |
| Comment a paragraph | `p` |
| Write the comment | Type, then Enter to save. Backspace on an empty draft cancels. |
| Overall comment | `o` |
| Edit / delete a comment | `e` / `x` on the comment. `n`/`N` jump between comments. |
| Send all as one prompt | `s` (or the Send button) |
| Put the prompt in the prompt box | `f` |
| Close (keeps the draft) | `q` |
| Show the keys | `?` |

The prompt quotes each selected span, with its comment under it, in reply order.

## Install

Load the folder as a plugin:

```sh
claude --plugin-dir ~/malkiz/github/claude-reply-comments
```

To load it in every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the `/annotate` command, the pane, sending and filling the prompt.
- `hooks/reader.tsx`: the `Client` surface module that draws the reply and handles mouse and keys.
- `hooks/lib.ts`: wrapping, selection and prompt building.
- `types/index.d.ts`: the `$.state` contract.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which Claude Code writes when it loads the mod. That folder is gitignored.
