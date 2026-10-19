(async () => {
  const S = __notesDebug.useStore
  const nb = await S.getState().addNode('notebook', null)
  S.getState().renameNode(nb, 'University')
  const sec = await S.getState().addNode('section', nb)
  S.getState().renameNode(sec, 'Machine Learning')
  const pg = await S.getState().addNode('page', sec)
  S.getState().setPageTitle('Gradient Descent')
  await new Promise((r) => setTimeout(r, 300))
  S.getState().addCell({ x: 40, y: 120, w: 560, title: 'Definition', html: '<p>Gradient descent is an optimization algorithm that minimizes a loss function by moving the parameters in the direction of the negative gradient.</p><p>Update rule: <span data-latex="\\theta \\leftarrow \\theta - \\eta \\nabla L(\\theta)"></span></p>' })
  S.getState().addCell({ x: 40, y: 320, w: 560, title: 'Learning rate', html: '<ul><li><p>Too large: the loss diverges or oscilates.</p></li><li><p>Too small: training is very slow.</p></li><li><p>Common values: 0.1, 0.01, 0.001</p></li></ul>' })
  S.getState().addCell({ x: 640, y: 120, w: 420, title: 'Variants', html: '<ol><li><p>Batch gradient descent</p></li><li><p>Stochastic gradient descent (SGD)</p></li><li><p>Mini-batch gradient descent</p></li></ol>' })
  S.getState().setSelection([])
  await S.getState().save()
  return pg
})()
