/**
 * Demo notes for testing builds (VITE_DEMO=1) in the emulator without a real
 * account: a small notebook tree with every kind of content. Never in the
 * builds that are published.
 */
import * as idb from './sync/idb'

const now = Date.now()
const node = (id: string, kind: string, title: string, children: any[] = [], color?: string) => ({
  id,
  kind,
  title,
  children,
  createdAt: now,
  updatedAt: now,
  ...(color ? { color } : {}),
})

const cell = (id: string, x: number, y: number, w: number, h: number, title: string, html: string) => ({
  id,
  kind: 'text',
  x,
  y,
  w,
  h,
  z: 1,
  title,
  showTitle: true,
  html,
  autoHeight: true,
  createdAt: now,
  updatedAt: now,
})

const lorem =
  'Gradient descent moves the weights a small step against the gradient of the loss. The learning rate decides how big that step is; too big and it overshoots, too small and it crawls.'

function pages() {
  const out: Record<string, any> = {}
  out.p1 = {
    id: 'p1',
    title: 'Lecture 3: Optimization',
    gridSize: 20,
    strokes: [{ color: '#e06c75', size: 3, points: [620, 140, 660, 170, 700, 150, 740, 190] }],
    createdAt: now,
    updatedAt: now,
    cells: [
      cell('c1', 40, 120, 560, 200, 'Key idea', `<p>${lorem}</p><p>Update rule: <span data-latex="w \\leftarrow w - \\eta \\nabla L(w)"></span></p>`),
      cell(
        'c2',
        620,
        220,
        420,
        220,
        'To do',
        '<ul data-type="taskList"><li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Watch the recording</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Solve problem set 3</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Read chapter 8</p></div></li></ul>',
      ),
      cell(
        'c3',
        40,
        360,
        560,
        260,
        'Comparison',
        '<table><tbody><tr><th><p>Method</p></th><th><p>Memory</p></th><th><p>Speed</p></th></tr><tr><td><p>SGD</p></td><td><p>Low</p></td><td><p>Slow</p></td></tr><tr><td><p>Adam</p></td><td><p>2x</p></td><td><p>Fast</p></td></tr></tbody></table><div data-latex="\\hat m_t = \\frac{m_t}{1-\\beta_1^t}"></div>',
      ),
      cell('c4', 620, 480, 420, 180, '', '<h2>Code</h2><pre><code class="language-python">for x, y in loader:\n    loss = model(x, y)\n    loss.backward()\n    opt.step()</code></pre>'),
      cell(
        'c5',
        40,
        660,
        560,
        160,
        'Links',
        '<ul><li><p><a href="https://example.com">A web link</a></p></li><li><p><strong>Bold</strong>, <em>italic</em>, <mark data-color="#ffd75e" style="background-color: #ffd75e">highlight</mark>, <span style="color: #61afef">color</span></p></li></ul>',
      ),
    ],
  }
  out.p2 = {
    id: 'p2',
    title: 'Shopping list',
    gridSize: 20,
    strokes: [],
    createdAt: now,
    updatedAt: now,
    cells: [
      cell('d1', 40, 120, 480, 200, 'Groceries', '<ul data-type="taskList"><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Milk</p></div></li><li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Bread</p></div></li></ul>'),
    ],
  }
  for (let i = 3; i <= 14; i++) {
    out[`p${i}`] = {
      id: `p${i}`,
      title: `Week ${i - 2} notes`,
      gridSize: 20,
      strokes: [],
      createdAt: now,
      updatedAt: now - i * 86400000,
      cells: Array.from({ length: 6 }, (_, k) => cell(`w${i}-${k}`, 40, 120 + k * 220, 560, 200, `Topic ${k + 1}`, `<p>${lorem}</p><ol><li><p>First point about week ${i - 2}</p></li><li><p>Second point</p></li></ol>`)),
    }
  }
  return out
}

export async function seedDemo() {
  const tree = [
    node('nb1', 'notebook', 'University', [
      node('s1', 'section', 'Machine Learning', [node('p1', 'page', 'Lecture 3: Optimization'), ...Array.from({ length: 12 }, (_, i) => node(`p${i + 3}`, 'page', `Week ${i + 1} notes`))]),
    ], '#61afef'),
    node('nb2', 'notebook', 'Personal', [node('s2', 'section', 'Home', [node('p2', 'page', 'Shopping list')])], '#98c379'),
  ]
  await idb.put('docs', 'workspace:', { version: 1, tree, favorites: ['p2'], recent: [] })
  for (const [id, p] of Object.entries(pages())) await idb.put('docs', `page:${id}`, p)
  localStorage.setItem('notes:demo', '1')
}

export const demoAllowed = import.meta.env.VITE_DEMO === '1'
export const inDemo = () => demoAllowed && localStorage.getItem('notes:demo') === '1'
