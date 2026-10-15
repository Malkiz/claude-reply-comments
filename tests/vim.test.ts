import { describe, expect, test } from 'claude-code/testing'

import { textObject, wordBackward, wordEnd, wordEndBackward, wordForward } from '../hooks/lib'
import { escape, initialState, scrollBy, step, submitInput } from '../hooks/vim'
import type { Action, VimState } from '../hooks/vim'

const LAYOUT = { columns: 40, rows: 5 }

function start(text: string, cursor = 0): VimState {
  return { ...initialState(text, [], '', 1), cursor }
}

/** Types `keys` one at a time from the pane's key field; `<Esc>` and `<CR>` name those keys. */
function run(s0: VimState, keys: string): { s: VimState; actions: Action[] } {
  let s = s0
  const actions: Action[] = []
  for (const part of keys.split(/(<Esc>|<CR>)/)) {
    if (part === '<Esc>') s = escape(s)
    else if (part === '<CR>') s = step(s, { key: 'return' }, 'pane', LAYOUT).state
    else {
      for (const ch of part) {
        const r = step(s, { key: ch }, 'pane', LAYOUT)
        s = r.state
        if (r.action) actions.push(r.action)
      }
    }
  }
  return { s, actions }
}

const at = (text: string, keys: string, from = 0) => run(start(text, from), keys).s.cursor

describe('words', () => {
  const t = 'foo bar.baz  qux'

  test('w W b B e E ge like vim', () => {
    expect([1, 2, 3, 4].map(n => at(t, 'w'.repeat(n)))).toEqual([4, 7, 8, 13])
    expect([1, 2].map(n => at(t, 'W'.repeat(n)))).toEqual([4, 13])
    expect([1, 2, 3, 4].map(n => at(t, 'e'.repeat(n)))).toEqual([2, 6, 7, 10])
    expect([1, 2].map(n => at(t, 'E'.repeat(n)))).toEqual([2, 10])
    expect(at(t, 'b', 13)).toBe(8)
    expect(at(t, 'B', 13)).toBe(4)
    expect(at(t, 'ge', 13)).toBe(10)
    expect(at(t, 'ge', 8)).toBe(7)
    expect(at(t, 'gE', 13)).toBe(10)
  })

  test('counts repeat a motion', () => {
    expect(at(t, '3w')).toBe(8)
    expect(at(t, '2e')).toBe(6)
    expect(at(t, '3l')).toBe(3)
  })

  test('w stops on an empty line', () => {
    expect(wordForward('ab\n\nxy', 0, false)).toBe(3)
    expect(wordBackward('ab\n\nxy', 4, false)).toBe(3)
    expect(wordEnd('ab cd', 1, false)).toBe(4)
    expect(wordEndBackward('ab cd', 3, false)).toBe(1)
  })
})

describe('lines and the text', () => {
  const t = '  indented line\nsecond\nthird line'

  test('0 ^ $ act on the source line', () => {
    expect(at(t, '$', 5)).toBe(14)
    expect(at(t, '0', 5)).toBe(0)
    expect(at(t, '^', 9)).toBe(2)
    expect(at(t, '2$', 0)).toBe(21)
  })

  test('gg and G, with and without a count', () => {
    expect(at(t, 'G', 0)).toBe(23)
    expect(at(t, 'gg', 25)).toBe(2)
    expect(at(t, '2G', 0)).toBe(16)
    expect(at(t, '3gg', 0)).toBe(23)
  })

  test('j and k keep the column', () => {
    expect(at(t, 'j', 4)).toBe(20)
    expect(at(t, 'jj', 4)).toBe(27)
    expect(at(t, 'jjk', 12)).toBe(21)
  })

  test('{ and } move between empty lines', () => {
    const p = 'one\ntwo\n\nthree\n\nfour'
    expect(at(p, '}')).toBe(8)
    expect(at(p, '}}')).toBe(15)
    expect(at(p, '{', 17)).toBe(15)
    expect(at(p, '{{', 17)).toBe(8)
  })

  test('f t F T ; , find on the line', () => {
    const c = 'a,b,c,d'
    expect(at(c, 'f,')).toBe(1)
    expect(at(c, 'f,;')).toBe(3)
    expect(at(c, 'f,;,')).toBe(1)
    expect(at(c, 'F,', 6)).toBe(5)
    const d = 'ab,cd,ef'
    expect(at(d, 't,')).toBe(1)
    expect(at(d, 't,;')).toBe(4)
    expect(at(d, 'T,', 7)).toBe(6)
    expect(at(d, 't,', 1)).toBe(1)
    expect(at(c, '2f,')).toBe(3)
    expect(at(c, 'fz')).toBe(0)
  })

  test('H M L and zz zt work on the screen', () => {
    const long = Array.from({ length: 20 }, (_, i) => `row${i}`).join('\n')
    const s = run(start(long), 'G').s
    expect(s.top).toBe(15)
    expect(run(s, 'H').s.cursor).toBe(long.indexOf('row15'))
    expect(run(s, 'L').s.cursor).toBe(long.indexOf('row19'))
    expect(run(s, 'M').s.cursor).toBe(long.indexOf('row17'))
    const mid = run(start(long), '10G').s
    expect(run(mid, 'zt').s.top).toBe(9)
    expect(run(mid, 'zz').s.top).toBe(7)
  })
})

describe('selections', () => {
  const t = 'Say (hello there) and "quoted words" end.\n\nNext paragraph here.'

  test('v extends with motions, o swaps ends, Esc leaves', () => {
    const { s } = run(start(t), 've')
    expect(s.mode).toBe('visual')
    expect([s.anchor, s.cursor]).toEqual([0, 2])
    expect(run(s, 'o').s.cursor).toBe(0)
    expect(run(s, '<Esc>').s.mode).toBe('normal')
  })

  test('text objects select words, brackets, quotes and paragraphs', () => {
    expect(textObject(t, 7, false, 'w')).toEqual({ start: 5, end: 10 })
    expect(textObject(t, 7, false, '(')).toEqual({ start: 5, end: 16 })
    expect(textObject(t, 7, true, ')')).toEqual({ start: 4, end: 17 })
    expect(textObject(t, 25, false, '"')).toEqual({ start: 23, end: 35 })
    expect(textObject(t, 0, false, '(')).toEqual({ start: 5, end: 16 })
    expect(textObject('a (b)\nx (d)', 6, false, '(')).toEqual({ start: 9, end: 10 })
    expect(textObject('a (b)\nx', 6, false, '(')).toBeUndefined()
    const { s } = run(start(t, 7), 'vi(')
    expect([s.anchor, s.cursor]).toEqual([5, 15])
    const p = run(start(t, 50), 'vip').s
    expect(t.slice(p.anchor, p.cursor + 1)).toBe('Next paragraph here.')
  })

  test('c on a selection opens a comment on exactly that text', () => {
    const { s } = run(start(t, 7), 'viwc')
    expect(s.mode).toBe('input')
    expect(s.inputKind).toBe('comment')
    expect(s.target).toEqual({ start: 5, end: 10 })
    const saved = submitInput(s, 'greeting', LAYOUT).state
    expect(saved.comments).toEqual([{ start: 5, end: 10, quote: 'hello', text: 'greeting' }])
    expect(saved.mode).toBe('normal')
  })

  test('V selects whole lines', () => {
    const { s } = run(start(t, 50), 'Vc')
    expect(s.target).toEqual({ start: 43, end: 63 })
  })
})

describe('c as an operator', () => {
  const t = 'Say (hello there) and "quoted words" end.\n\nNext paragraph here.'
  const target = (keys: string, from = 0) => {
    const s = run(start(t, from), keys).s
    return s.target && 'start' in s.target ? t.slice(s.target.start, s.target.end) : undefined
  }

  test('cip ciw ci( ci" cc c$ cw ce', () => {
    expect(target('cip', 50)).toBe('Next paragraph here.')
    expect(target('ciw', 7)).toBe('hello')
    expect(target('ci(', 7)).toBe('hello there')
    expect(target('ci"', 25)).toBe('quoted words')
    expect(target('cc', 3)).toBe(t.split('\n')[0])
    expect(target('c$', 18)).toBe('and "quoted words" end.')
    expect(target('cw', 5)).toBe('hello')
    expect(target('c2e', 5)).toBe('hello there')
  })

  test('an unknown key drops a half-typed command', () => {
    const s = run(start(t), 'c').s
    expect(s.pending).toBe('c')
    expect(run(s, 'Q').s.pending).toBe('')
    expect(run(start(t), 'g<Esc>').s.pending).toBe('')
  })
})

describe('comments, search and commands', () => {
  const t = 'alpha beta gamma\n\nbeta again'

  test(']m [m jump between messages, with counts', () => {
    const convo = 'ask one\n\nreply one\nmore\n\nask two\n\nreply two'
    const starts = [0, 9, 24, 33]
    const s = { ...start(convo), starts }
    expect(run(s, ']m').s.cursor).toBe(9)
    expect(run(s, ']m]m').s.cursor).toBe(24)
    expect(run(s, '3]m').s.cursor).toBe(33)
    expect(run({ ...s, cursor: 33 }, ']m').s.cursor).toBe(33)
    // [m from inside a message goes to its start, then to the one before
    expect(run({ ...s, cursor: 15 }, '[m').s.cursor).toBe(9)
    expect(run({ ...s, cursor: 15 }, '[m[m').s.cursor).toBe(0)

  })

  test('o r x ]c [c', () => {
    let s = run(start(t), 'ciw').s
    s = submitInput(s, 'first', LAYOUT).state
    s = run(s, 'G').s
    s = submitInput(run(s, 'ciw').s, 'second', LAYOUT).state
    expect(s.comments.map(c => c.quote)).toEqual(['alpha', 'beta'])

    expect(run(s, 'gg]c').s.cursor).toBe(18)
    expect(run(s, '[c').s.cursor).toBe(0)

    const revising = run(s, 'r').s
    expect(revising.draft).toBe('second')
    s = submitInput(revising, 'second, revised', LAYOUT).state
    expect(s.comments[1]!.text).toBe('second, revised')

    s = run(s, 'x').s
    expect(s.comments.map(c => c.quote)).toEqual(['alpha'])

    s = run(s, 'o').s
    expect(s.target).toEqual({ overall: true })
    s = submitInput(s, 'nice', LAYOUT).state
    expect(s.overall).toBe('nice')
  })

  test('/ searches with smartcase, n and N wrap', () => {
    let s = run(start(t), '/').s
    expect(s.inputKind).toBe('search')
    s = submitInput(s, 'beta', LAYOUT).state
    expect(s.cursor).toBe(6)
    expect(run(s, 'n').s.cursor).toBe(18)
    expect(run(s, 'nn').s.cursor).toBe(6)
    expect(run(s, 'N').s.cursor).toBe(18)
    expect(submitInput(run(start(t), '/').s, 'BETA', LAYOUT).state.flash).toBe('Not found: BETA')
  })

  test(': commands and ? and q; s alone sends nothing', () => {
    const withComment = submitInput(run(start(t), 'ciw').s, 'x', LAYOUT).state
    const cmd = (s: VimState, text: string) => submitInput(run(s, ':').s, text, LAYOUT)
    expect(cmd(withComment, 's').action).toBe('send')
    expect(cmd(withComment, 'w').action).toBe('send')
    expect(cmd(withComment, 'p').action).toBe('fill')
    expect(cmd(withComment, 'q').action).toBe('close')
    expect(cmd(withComment, 'clear').action).toBe('clear')
    expect(cmd(withComment, '3').state.cursor).toBe(18)
    expect(cmd(withComment, 'nope').state.flash).toBe('Not a command: :nope')
    expect(cmd(start(t), 'w').state.flash).toBe('Nothing to send yet')
    expect(run(withComment, '?').actions).toEqual(['legend'])
    expect(run(withComment, 's').actions).toEqual([])
    expect(run(withComment, 'q').actions).toEqual(['close'])
  })

  test('C comments from the cursor to the end of the line, as c$', () => {
    const text = 'alpha beta gamma\nnext line'
    const s = run(start(text), 'wC').s
    expect(s.mode).toBe('input')
    expect(s.target).toEqual({ start: 6, end: 16 })
    // 2C takes the next line too
    expect(run(start(text), 'w2C').s.target).toEqual({ start: 6, end: text.length })
  })

  test('Esc cancels an input and keeps what was saved', () => {
    const s = run(start(t), 'ciw<Esc>').s
    expect(s.mode).toBe('normal')
    expect(s.comments).toEqual([])
  })

  test('keys typed in the reader itself write the input in place', () => {
    let s = run(start(t), 'ciw').s
    for (const key of ['h', 'i']) s = step(s, { key }, 'reader', LAYOUT).state
    expect(s.draft).toBe('hi')
    s = step(s, { key: 'return' }, 'reader', LAYOUT).state
    expect(s.comments[0]!.text).toBe('hi')
  })

  test('the wheel scrolls the text and keeps the cursor on screen', () => {
    const long = Array.from({ length: 20 }, (_, i) => `row${i}`).join('\n')
    const down = scrollBy(start(long), LAYOUT, 3)
    expect(down.top).toBe(3)
    expect(down.cursor).toBe(long.indexOf('row3'))
    const back = scrollBy(down, LAYOUT, -1)
    expect(back.top).toBe(2)
    expect(back.cursor).toBe(long.indexOf('row3'))
    expect(scrollBy(start(long), LAYOUT, 99).top).toBe(15)
    expect(scrollBy(start(long), LAYOUT, -5).top).toBe(0)
    const short = scrollBy(start('just one line'), LAYOUT, 2)
    expect([short.top, short.cursor]).toEqual([0, 0])
  })

  test('typing in place takes a whole word that arrives as one key (a paste), and drops named keys', () => {
    const s = { ...start('some reply text'), mode: 'input' as const, inputKind: 'comment' as const, via: 'reader' as const, draft: '' }
    const pasted = step(s, { key: 'hello' }, 'reader', LAYOUT).state
    expect(pasted.draft).toBe('hello')
    expect(step(pasted, { key: 'tab' }, 'reader', LAYOUT).state.draft).toBe('hello')
  })

  test('ctrl-f moves a screen down and ctrl-u half a screen up', () => {
    const long = Array.from({ length: 20 }, (_, i) => `row${i}`).join('\n')
    const s = step(start(long), { key: 'f', ctrl: true }, 'reader', LAYOUT).state
    expect(s.cursor).toBeGreaterThan(0)
    const back = step(s, { key: 'u', ctrl: true }, 'reader', LAYOUT).state
    expect(back.cursor).toBeLessThan(s.cursor)
  })
})
