// A blank page plus a K-map cell made through create_cells (no model needed):
// wrap-around loops that reach over the row labels, as in Example 9.
(async () => {
  const S = __notesDebug.useStore
  const nb = await S.getState().addNode('notebook', null)
  const sec = await S.getState().addNode('section', nb)
  await S.getState().addNode('page', sec)
  S.getState().setPageTitle('K-map colors')
  await new Promise((r) => setTimeout(r, 300))
  const D = __notesDebug
  const env = { rec: new D.TurnRecorder(), attachments: new Map(), model: 'test', ask: async () => '' }
  const content = '### Example 9\n\n```kmap\n{ vars: ["a","b","c"], ones: [0,2,4,6,7], groups: "auto", expression: true }\n```'
  const r = await D.runTool('create_cells', { cells: [{ title: 'K-map colors', content, w: 600, x: 40, y: 120 }] }, env)
  S.getState().setSelection([])
  await S.getState().save()
  return String(r.content || r).slice(0, 300)
})()
