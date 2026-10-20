// A wide, tall page with cells spread out, scrolled to the middle, for the page map.
(async () => {
  const S = __notesDebug.useStore
  const nb = await S.getState().addNode('notebook', null)
  S.getState().renameNode(nb, 'University')
  const sec = await S.getState().addNode('section', nb)
  S.getState().renameNode(sec, 'Embedded Systems')
  await S.getState().addNode('page', sec)
  S.getState().setPageTitle('Big page')
  const spots = [
    [40, 120, 600, 300], [700, 120, 420, 500], [40, 480, 500, 260], [1300, 300, 500, 400],
    [200, 1000, 800, 350], [1500, 1100, 600, 300], [2200, 200, 400, 900], [900, 1600, 700, 300],
  ]
  for (const [x, y, w, h] of spots) S.getState().addCell({ x, y, w, h, title: `Cell at ${x},${y}`, showTitle: true })
  await new Promise((r) => setTimeout(r, 400))
  S.getState().setSelection([])
  const wrap = document.querySelector('.canvas-wrap')
  wrap.scrollTo({ left: 600, top: 500 })
  await S.getState().save()
  return { w: wrap.scrollWidth, h: wrap.scrollHeight }
})()
