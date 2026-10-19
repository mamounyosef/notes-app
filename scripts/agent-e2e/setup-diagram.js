// A page with one cell holding a drawn flowchart and a bar chart with known
// content, to check how well view_image describes figures.
(async () => {
  const S = __notesDebug.useStore
  const nb = await S.getState().addNode('notebook', null)
  S.getState().renameNode(nb, 'Tests')
  const sec = await S.getState().addNode('section', nb)
  const pg = await S.getState().addNode('page', sec)
  S.getState().setPageTitle('Diagram')
  await new Promise((r) => setTimeout(r, 300))
  const c = document.createElement('canvas')
  c.width = 900
  c.height = 620
  const g = c.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, 900, 620)
  g.font = '20px Arial'
  g.lineWidth = 2
  const box = (x, y, w, h, label, fill) => {
    g.fillStyle = fill
    g.fillRect(x, y, w, h)
    g.strokeStyle = '#222'
    g.strokeRect(x, y, w, h)
    g.fillStyle = '#111'
    g.fillText(label, x + 14, y + h / 2 + 7)
  }
  const arrow = (x1, y1, x2, y2, label, dashed) => {
    g.setLineDash(dashed ? [8, 6] : [])
    g.strokeStyle = '#222'
    g.beginPath()
    g.moveTo(x1, y1)
    g.lineTo(x2, y2)
    g.stroke()
    g.setLineDash([])
    const a = Math.atan2(y2 - y1, x2 - x1)
    g.beginPath()
    g.moveTo(x2, y2)
    g.lineTo(x2 - 14 * Math.cos(a - 0.4), y2 - 14 * Math.sin(a - 0.4))
    g.lineTo(x2 - 14 * Math.cos(a + 0.4), y2 - 14 * Math.sin(a + 0.4))
    g.closePath()
    g.fillStyle = '#222'
    g.fill()
    if (label) {
      g.font = '16px Arial'
      g.fillText(label, (x1 + x2) / 2 - 30, (y1 + y2) / 2 - 10)
      g.font = '20px Arial'
    }
  }
  box(30, 60, 130, 60, 'Tokens', '#e8f0ff')
  box(240, 60, 150, 60, 'Encoder', '#dff5e1')
  box(470, 60, 150, 60, 'Decoder', '#dff5e1')
  box(700, 60, 160, 60, 'Softmax', '#fff3d6')
  arrow(160, 90, 240, 90, 'embed')
  arrow(390, 90, 470, 90, 'context')
  arrow(620, 90, 700, 90, 'logits')
  arrow(780, 120, 545, 200, '', true)
  g.font = '16px Arial'
  g.fillText('teacher forcing', 620, 190)
  arrow(545, 200, 545, 120, '', true)
  // bar chart
  g.font = '18px Arial'
  g.fillStyle = '#111'
  g.fillText('Accuracy by model (%)', 300, 290)
  g.strokeStyle = '#222'
  g.beginPath()
  g.moveTo(120, 560)
  g.lineTo(820, 560)
  g.moveTo(120, 560)
  g.lineTo(120, 320)
  g.stroke()
  const bars = [['RNN', 62, '#7c9cff'], ['LSTM', 71, '#7c9cff'], ['Transformer', 88, '#e06c75']]
  bars.forEach(([name, v, col], i) => {
    const x = 190 + i * 210
    const h = (v / 100) * 230
    g.fillStyle = col
    g.fillRect(x, 560 - h, 110, h)
    g.fillStyle = '#111'
    g.fillText(name, x, 585)
    g.fillText(String(v), x + 35, 552 - h)
  })
  ;[0, 50, 100].forEach((t) => g.fillText(String(t), 80, 566 - (t / 100) * 230))
  S.getState().addCell({ x: 40, y: 120, w: 820, title: 'Model diagram', html: `<p><img src="${c.toDataURL('image/png')}" width="800"></p>` })
  await S.getState().save()
  return pg
})()
