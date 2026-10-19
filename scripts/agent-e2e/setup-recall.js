// Two notebooks: a Gradient Descent page (opened) and an Activations page whose
// cell holds an image of text, for the recall and view_image scenario.
(async () => {
  const S = __notesDebug.useStore
  const nb = await S.getState().addNode('notebook', null)
  S.getState().renameNode(nb, 'University')
  const sec = await S.getState().addNode('section', nb)
  S.getState().renameNode(sec, 'Machine Learning')
  const act = await S.getState().addNode('page', sec)
  S.getState().setPageTitle('Activations')
  await new Promise((r) => setTimeout(r, 300))
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 200
  const g = c.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, 640, 200)
  g.fillStyle = '#111'
  g.font = '28px Arial'
  g.fillText('ReLU(x) = max(0, x)', 30, 60)
  g.fillText('Sigmoid squashes values into (0, 1)', 30, 110)
  g.fillText('Tanh outputs values in (-1, 1)', 30, 160)
  S.getState().addCell({ x: 40, y: 120, w: 600, title: 'Activation functions', html: `<p><img src="${c.toDataURL('image/png')}" width="560"></p>` })
  await S.getState().save()
  const pg = await S.getState().addNode('page', sec)
  S.getState().setPageTitle('Gradient Descent')
  await new Promise((r) => setTimeout(r, 300))
  S.getState().addCell({ x: 40, y: 120, w: 560, title: 'Learning rate', html: '<p>Too large: the loss diverges. Too small: training is slow.</p>' })
  await S.getState().save()
  return { act, pg }
})()
