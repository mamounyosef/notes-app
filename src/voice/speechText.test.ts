// Run: node --experimental-strip-types src/voice/speechText.test.ts
import { SentenceSplitter, askSpeech, isUndoCommand, mathSpeech, speakable } from './speechText.ts'

let failed = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`)
}

// Math
eq('square', mathSpeech('x^2'), 'x squared')
eq('frac', mathSpeech('\\frac{a+b}{2}'), 'a plus b, over 2')
eq('sqrt', mathSpeech('\\sqrt{x}'), 'the square root of x')
eq('greek + sub', mathSpeech('\\alpha_t \\cdot \\nabla L'), 'alpha sub t times nabla L')
eq('relation', mathSpeech('E = mc^2'), 'E equals mc squared')
eq('power n', mathSpeech('2^{n}'), '2 to the power of n')
eq('leq', mathSpeech('0 \\leq p \\leq 1'), '0 is less than or equal to p is less than or equal to 1')

// Speakable
eq('inline math', speakable('The loss is $\\frac{1}{n}$ times the sum.'), 'The loss is 1 over n times the sum.')
eq('note link', speakable('You wrote it in [Learning rate](note:abc#def).'), 'You wrote it in Learning rate.')
eq('markdown', speakable('**Done**: made the *key terms* bold.'), 'Done: made the key terms bold.')
eq('list', speakable('- one\n- two'), 'one two')
eq('code gone', speakable('Here:\n```mermaid\ngraph TD\nA-->B\n```\nThat is it.'), 'Here: That is it.')
eq('arrow', speakable('A -> B'), 'A to B')
eq('highlight', speakable('==important== stuff'), 'important stuff')

// Splitter
{
  const sp = new SentenceSplitter()
  const parts: string[] = []
  const full = 'Done, I bolded the terms. The formula $a. b$ stays. Anything else?'
  for (let i = 1; i <= full.length; i++) parts.push(...sp.push(full.slice(0, i)))
  parts.push(...sp.finish(full))
  eq('splitter', parts, ['Done, I bolded the terms.', 'The formula a. b stays.', 'Anything else?'])
}
{
  const sp = new SentenceSplitter()
  const full = 'I drew it:\n```mermaid\ngraph TD\nA-->B. C\n```\nTake a look.'
  const parts: string[] = []
  for (let i = 1; i <= full.length; i++) parts.push(...sp.push(full.slice(0, i)))
  parts.push(...sp.finish(full))
  eq('splitter skips code', parts, ['I drew it:', 'Take a look.'])
}
{
  const sp = new SentenceSplitter()
  const full = '3.5 is the answer. Dr. Smith agrees.'
  eq('abbrev', [...sp.push(full), ...sp.finish(full)], ['3.5 is the answer.', 'Dr. Smith agrees.'])
}

eq('ask', askSpeech({ question: 'Which page', options: ['Notes (Recommended)', 'Summary', 'Both'] }), 'Which page? Notes, Summary, or Both?')
eq('undo yes', ['undo that', 'Undo.', 'okay take it back', 'undo the last change please'].map(isUndoCommand), [true, true, true, true])
eq('undo no', ['undo the bold on the title', 'how do I undo', 'can you undo the second cell and make it red'].map(isUndoCommand), [false, false, false])

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall passed')
