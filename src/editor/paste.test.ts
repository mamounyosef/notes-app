// Run: npm run test:paste
import { classifyPaste, looksLikeHtmlFragment, looksLikeSvgDrawing, proseRatio } from './pasteClassify.ts'
import { extractMath } from './mathExtract.ts'

let failed = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`)
}
const kind = (text: string, htmlIsCode = false) => classifyPaste(text, htmlIsCode).kind

// A Claude answer: prose, math and one inline code span. Was pasted as one code block.
const answer = `## Note 1: ETH (Exponential Time Hypothesis)

**The puzzle (3-SAT)**
You have switches that are on or off, and rules like "A is on OR B is off OR C is on." Question: can you set all switches so every rule is satisfied?

**How many settings?**
Each switch has 2 options, so $n$ switches give $2^n$ settings.

For 3 switches (A, B, C):
$$2 \\times 2 \\times 2 = 2^3 = 8 \\text{ settings}$$

Here they are (0 = off, 1 = on):
\`000, 001, 010, 011, 100, 101, 110, 111\`

The example rule "A on OR B off OR C on" fails only for A off, B on, C off (\`010\`). The other 7 settings pass.

**If ETH were false**
A big shortcut exists. It would not automatically prove P = NP.

---

## Note 2: P = NP?

- $P$ = **Polynomial time**: problems that can be *solved* quickly (time grows like $n^2$ or $n^3$).
- $NP$ = **Nondeterministic Polynomial time**: problems whose answer can be *checked* quickly.

Status: unsolved. It is a Millennium Prize problem worth $1 million. Most experts believe $P \\neq NP$.`

// Styled HTML with no <html> around it renders; a snippet showing tags stays code.
const box = '<div style="padding:4px"><b>x</b></div>\n'
eq('styled fragment renders', looksLikeHtmlFragment(`<div style="margin:0">\n${box}${box}${box}</div>`), true)
eq('style block fragment renders', looksLikeHtmlFragment('<style>.a{color:red}</style>\n<div class="a"><p>one</p><p>two</p><p>three</p><p>four</p></div>'), true)
eq('tag snippet stays code', looksLikeHtmlFragment('<div class="card">\n  <h2>Title</h2>\n  <p>Text</p>\n</div>'), false)
const svg = '<svg viewBox="0 0 10 10"\n  fill="none">\n  <!-- a -->\n  <path d="M0,0 H5"/>\n  <text x="1" y="2">a &gt; b</text>\n</svg>'
eq('raw svg is a drawing', looksLikeSvgDrawing(svg), true)
eq('svg with xml prolog is a drawing', looksLikeSvgDrawing(`<?xml version="1.0"?>\n${svg}`), true)
eq('svg then prose is not a drawing', looksLikeSvgDrawing(`${svg}\nthat is it`), false)
eq('text after the markup is not a fragment', looksLikeHtmlFragment(`<div style="a">${box}${box}${box}</div>\nthat is the layout`), false)

eq('claude answer is markdown', kind(answer), 'markdown')
eq('claude answer is markdown even with code-styled html', kind(answer, true), 'markdown')

const python = `# Load the data
import pandas as pd

def load(path: str):
    df = pd.read_csv(path)
    return df.dropna()

if __name__ == "__main__":
    print(load("data.csv"))`
eq('python', classifyPaste(python), { kind: 'code', language: 'python' })

const js = `/**
 * Adds two numbers together and returns the result to the caller.
 * This comment is long and reads like a sentence on purpose.
 */
export function add(a, b) {
  return a + b
}`
eq('js with prose doc comment', classifyPaste(js), { kind: 'code', language: 'javascript' })

eq('fenced block keeps only its inside', classifyPaste('```ts\nconst x: number = 1\nconsole.log(x)\n```'), {
  kind: 'code',
  language: 'ts',
  code: 'const x: number = 1\nconsole.log(x)',
})
eq('prose then fence is markdown', kind('Run this:\n\n```bash\nnpm install\n```\n\nThen start it.'), 'markdown')
eq('shell commands', classifyPaste('npm install\nnpm run dev'), { kind: 'code', language: 'bash' })
eq('code from an editor (html) without language', kind('foo = 1\nbar = 2', true), 'code')
eq('plain prose', kind('Just a sentence.\nAnd another one here.'), 'plain')
eq('markdown list', kind('- one\n- two'), 'markdown')
eq('markdown notes with python-like comment heading', kind('# Shopping list\n\nWe need to buy eggs and milk before the weekend.\nRemember that x = 5 is the budget in dollars today.'), 'markdown')
eq('prose ratio of code is low', proseRatio(python) < 0.3, true)

// Math extraction
const ex = (s: string) => {
  const r = extractMath(s)
  return [r.text, r.math.map((m) => (m.display ? `[${m.latex}]` : `(${m.latex})`)).join(' ')]
}
eq('inline + display', ex('a $x$ b\n$$y$$\nc'), ['a xx0math0xx0 b\n\n\nxx0math1xx0\n\n\nc', '(x) [y]'])
eq('prices stay', ex('costs $5 and $7'), ['costs $5 and $7', ''])
eq('million stays, later math found', ex('worth $1 million. Experts believe $P \\neq NP$.')[1], '(P \\neq NP)')
eq('unclosed backtick does not hide later math', ex('a ` b $x$')[1], '(x)')
eq('double backtick span with a backtick inside', ex('``a ` $b$`` $c$')[1], '(c)')
eq('escaped dollar', ex('\\$5 and $x$'), ['\\$5 and xx0math0xx0', '(x)'])
eq('indented fence in a list skipped', ex('- item\n  ```\n  $notmath$\n  ```\n- $y$')[1], '(y)')
eq('unclosed fence runs to the end', ex('```\n$a$\n')[1], '')
eq('stray $$ does not cross paragraphs', ex('price $$ here\n\nnext para $z$')[1], '(z)')
eq('\\( \\) and \\[ \\]', ex('\\(a\\) and \\[b\\]')[1], '(a) [b]')
eq('environment', ex('\\begin{pmatrix}1\\\\2\\end{pmatrix}')[1], '[\\begin{pmatrix}1\\\\2\\end{pmatrix}]')

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
