# The README's demo GIF. Re-record with: vhs docs/demo.tape
# Needs the mod installed (or claude started with --plugin-dir) and a
# trusted /tmp/rc-demo folder. Claude's reply differs from run to run, so
# check that the comments land on step 1, step 3 and the first question.

Output docs/demo.gif

Set Shell "zsh"
Set FontSize 15
Set Width 1600
Set Height 860
Set Padding 12
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful

Hide
# unset whatever a parent Claude Code session exported, so this one starts clean
Type "for v in ${(k)parameters[(I)CLAUDE*]} AI_AGENT; do unset $v; done; mkdir -p /tmp/rc-demo && cd /tmp/rc-demo && clear && claude --model haiku"
Enter
Wait+Screen@30s /for shortcuts/
Sleep 1s
Show

# Claude writes a long reply with several points and questions
Type "We're adding dark mode to our web app. Give me your plan as 4 numbered steps, two sentences each, a blank line between steps. Then 2 short questions, one about our CSS setup and one about browser support, each on its own line starting with Q:. No headings, no horizontal rules, no tools."
Sleep 500ms
Enter
Wait+Screen@90s /for \d+s · done/
Sleep 2s

# Open the pane: the whole conversation, cursor on the reply
Type "/annotate"
Sleep 400ms
Enter
Sleep 2.5s

# Step 1: select the paragraph, comment on it
Type "vip"
Sleep 900ms
Type "c"
Sleep 1s
Type "Follow the OS setting by default; a toggle can come later."
Sleep 600ms
Enter
Sleep 1.2s

# Step 3: move the cursor down, a paragraph at a time
Type "}"
Sleep 450ms
Type "j"
Sleep 450ms
Type "}"
Sleep 450ms
Type "j"
Sleep 450ms
Sleep 500ms
Type "vip"
Sleep 900ms
Type "c"
Sleep 1s
Type "We already set data-theme for brand themes, so reuse it."
Sleep 600ms
Enter
Sleep 1.2s

# Answer the first question: on past step 4
Type "}"
Sleep 450ms
Type "j"
Sleep 450ms
Type "}"
Sleep 450ms
Type "j"
Sleep 450ms
Sleep 500ms
Type "V"
Sleep 700ms
Type "c"
Sleep 1s
Type "Plain CSS with CSS variables."
Sleep 600ms
Enter
Sleep 1.5s

# Send all three as one prompt, and Claude answers each
Type "s"
# the first turn's "done" line is still on screen, so wait a fixed time
Sleep 20s
