// One empty page, opened: University > Embedded Systems > Lecture 3.
(async () => {
  const S = __notesDebug.useStore
  const nb = await S.getState().addNode('notebook', null)
  S.getState().renameNode(nb, 'University')
  const sec = await S.getState().addNode('section', nb)
  S.getState().renameNode(sec, 'Embedded Systems')
  const pg = await S.getState().addNode('page', sec)
  S.getState().setPageTitle('Lecture 3')
  await new Promise((r) => setTimeout(r, 300))
  S.getState().setSelection([])
  await S.getState().save()
  return pg
})()
