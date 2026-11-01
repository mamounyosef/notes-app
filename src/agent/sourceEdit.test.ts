// Run: npm run test:source
// With a file path after the command, also runs the edits on that real source.
import { readFileSync } from 'node:fs'
import { applySourceEdits, keptIndex, keptStub, outlineSource, searchSource, sourceProblems, sourceVersion, suspiciousRewrite, visibleText } from './sourceEdit.ts'

let failed = 0
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`}`)
}
const yes = (name: string, v: unknown) => eq(name, Boolean(v), true)

const round = (n: number) => `<div class="round"><b>ROUND ${n}: uses K<sub>${n}</sub></b><table><tr><td>L<sub>${n - 1}</sub> &oplus; F</td></tr></table></div>\n`
const doc = `<div style="margin:0"><h1>DES &rarr; rounds</h1>\n${round(1)}${round(2)}${round(3)}<script>if (a<b) x("<div>")</script></div>`
const v = sourceVersion(doc)
const next = (edits: any[], given?: string) => {
  const r = applySourceEdits(doc, edits, given)
  return r.ok ? r.next : r.errors.join(' | ')
}

// Version
eq('version repeats', sourceVersion(doc), v)
yes('version changes', sourceVersion(`${doc} `) !== v)

// Stand-in
eq('stand-in names its drawing', keptIndex(keptStub(3, 500)), 3)
eq('other text is no stand-in', keptIndex('<div>x</div>'), null)

// Outline
const big = `<div style="margin:0">${Array.from({ length: 30 }, (_, i) => round(i + 1)).join('')}</div>`
const line = outlineSource(big, 'html').join('\n')
yes('outline shows a round with what it says', line.includes('ROUND 2: uses K2'))
yes('outline offsets slice to that element', (() => {
  const m = /\[(\d+)-(\d+)\] <div\.round> "ROUND 2:/.exec(line)!
  return big.slice(+m[1], +m[2]).startsWith('<div class="round"><b>ROUND 2:') && big.slice(+m[1], +m[2]).endsWith('</div>')
})())
yes('outline of a one line page opens it up', outlineSource(big.replace(/\n/g, ''), 'html').length > 3)
yes('outline of plain text works', outlineSource('line\n'.repeat(4000), 'tikz').length > 3)
eq('broken html still gets an outline', outlineSource('<div><p>never closed', 'html').length > 0, true)
eq('scripts are not read as tags', visibleText('<p>a</p><script>"<b>no</b>"</script><p>c</p>').text, 'ac')
eq('entities become what is seen', visibleText('<b>a &rarr; &#9660;</b>').text, 'a → ▼')

// Search
eq('finds source text', searchSource(doc, 'ROUND 2').total, 1)
const seen = searchSource(doc, 'uses K2')
eq('finds text as seen on screen', [seen.where, seen.total], ['visible text', 1])
eq('a screen hit points at the source', doc.slice(seen.hits[0].at, seen.hits[0].end), 'uses K<sub>2')
eq('search stays in its range', searchSource(doc, 'ROUND', { from: doc.indexOf('ROUND 2'), caseSensitive: true }).total, 2)
eq('regex search', searchSource(doc, 'ROUND \\d', { regex: true }).total, 3)
eq('case insensitive by default', searchSource(doc, 'round 3').total, 1)

// Edits
yes('unique find', next([{ find: 'ROUND 2', replace: 'Round two' }]).includes('Round two'))
yes('ambiguous find asks which', next([{ find: 'uses K', replace: 'x' }]).includes('Found 3 times'))
yes('all replaces every one', !next([{ find: 'uses K', replace: 'key K', all: true }]).includes('uses K'))
yes('occurrence picks one', next([{ find: 'uses K', replace: 'key K', occurrence: 2 }]).includes('ROUND 2: key K'))
yes('missing occurrence fails', next([{ find: 'uses K', replace: 'x', occurrence: 9 }]).includes('does not exist'))
yes('says where the text differs', next([{ find: 'ROUND 2: uses Q<sub>', replace: 'x' }]).includes('then the source has'))
yes('forgives spacing', next([{ find: 'ROUND 2:   uses', replace: 'R2 uses' }]).includes('R2 uses'))
yes('forgives quotes', next([{ find: "<div class='round'><b>ROUND 2", replace: '<div class="round"><b>Round 2' }]).includes('<b>Round 2'))
yes('an edit changing nothing is refused', next([{ find: 'ROUND 2', replace: 'ROUND 2' }]).includes('changes nothing'))
yes('all or nothing', !next([{ find: 'ROUND 1', replace: 'A' }, { find: 'absent text here', replace: 'B' }]).includes('<b>A'))
eq('edits do not shift each other', next([{ find: 'ROUND 1', replace: 'A very long replacement' }, { find: 'ROUND 3', replace: 'C' }]), doc.replace('ROUND 1', 'A very long replacement').replace('ROUND 3', 'C'))
yes('overlapping edits are refused', next([{ find: 'ROUND 1', replace: 'A' }, { find: 'ROUND 1: uses', replace: 'B' }]).includes('overlap'))
yes('regex with groups', next([{ find: 'ROUND (\\d)', replace: 'Step $1', regex: true, all: true }]).includes('Step 3'))
yes('bad regex is an error, not a crash', next([{ find: '(', replace: 'x', regex: true }]).includes('Bad regex'))

// Offsets
const r2 = doc.indexOf('<div class="round"><b>ROUND 2')
const r3 = doc.indexOf('<div class="round"><b>ROUND 3')
yes('offsets need the version', next([{ from: r2, to: r3, replace: '' }]).includes('need the current version'))
yes('a stale version is refused', next([{ from: r2, to: r3, replace: '' }], 'vold').includes('source changed'))
eq('range delete', next([{ from: r2, to: r3, replace: '' }], v), doc.slice(0, r2) + doc.slice(r3))
eq('insert at offset', next([{ from: r3, replace: '<hr>' }], v), `${doc.slice(0, r3)}<hr>${doc.slice(r3)}`)
yes('find inside a range', next([{ find: 'K<sub>', replace: 'Q<sub>', all: true, from: r2, to: r3 }], v).includes('uses K<sub>3'))
yes('range past the end fails', next([{ from: 0, to: 1e9, replace: '' }], v).includes('outside'))

// Copy a part without resending it
const copy = next([{ from: r3, copy_of: { from: r2, to: r3, map: [{ find: 'ROUND 2', replace: 'ROUND 9' }, { find: '<sub>2</sub>', replace: '<sub>9</sub>' }] } }], v)
yes('copy with renames', copy.includes('ROUND 9: uses K<sub>9</sub>') && copy.includes('ROUND 2'))
yes('copy rename that hits nothing fails', next([{ from: r3, copy_of: { from: r2, to: r3, map: [{ find: 'ROUND 7', replace: 'x' }] } }], v).includes('not in the copied part'))

// Safety
yes('catches an unclosed tag', sourceProblems(doc, doc.replace('</table>', ''), 'html').join().includes('<table>'))
yes('catches an extra close', sourceProblems(doc, `${doc}</div>`, 'html').join().includes('extra closing'))
eq('tags inside a script do not count', sourceProblems(doc, doc.replace('"<div>"', '"<span>"'), 'html'), [])
eq('an already broken source can still change', sourceProblems('<div><p>a', '<div><p>b', 'html'), [])
yes('catches a lazy placeholder', sourceProblems(doc, doc.replace('ROUND 2', '<!-- ... rest unchanged -->'), 'html').length)
yes('catches broken JSON', sourceProblems('{"a":1}', '{"a":', 'chart').length)
eq('no problem with a clean edit', sourceProblems(doc, doc.replace('ROUND 2', 'Round 2'), 'html'), [])
yes('a much smaller rewrite needs saying so', suspiciousRewrite('x'.repeat(20000), 'y'.repeat(500)))
eq('a small drawing can shrink freely', suspiciousRewrite('x'.repeat(500), 'y'), '')

// A real big file: every edit must land exactly and leave the rest byte for byte.
const path = process.argv[2]
if (path) {
  const real = readFileSync(path, 'utf8')
  const rv = sourceVersion(real)
  console.log(`\n${real.length} chars, ${outlineSource(real, 'html').length} outline lines`)
  console.log(outlineSource(real, 'html').slice(0, 14).join('\n'))
  const hit = searchSource(real, 'ROUND 2: uses key K2')
  eq('real: finds the title as seen', hit.total, 1)
  const start = real.lastIndexOf('<div style="border:2px solid #B4B2A9', hit.hits[0].at)
  const stop = real.indexOf('<div style="text-align:center;color:#5F5E5A;font-size:13px', hit.hits[0].at)
  const r = applySourceEdits(real, [
    { find: 'DES encryption: full view, 16 rounds', replace: 'DES encryption, all 16 rounds' },
    { find: 'font-size:12px;">function F', replace: 'font-size:13px;">function F' },
    { find: 'only reorders the bits', replace: 'only moves the bits around', from: 0, to: start },
    { from: stop, copy_of: { from: start, to: stop, map: [{ find: 'ROUND 2', replace: 'ROUND 2B' }] } },
  ], rv)
  eq('real: all edits applied', r.ok, true)
  if (r.ok) {
    eq('real: nothing broken', sourceProblems(real, r.next, 'html'), [])
    const undone = r.next
      .replace('DES encryption, all 16 rounds', 'DES encryption: full view, 16 rounds')
      .replace('font-size:13px;">function F', 'font-size:12px;">function F')
      .replace('only moves the bits around', 'only reorders the bits')
    const same = undone.replace(real.slice(start, stop).split('ROUND 2').join('ROUND 2B'), '') === real
    eq('real: the rest is byte for byte', same, true)
  }
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
