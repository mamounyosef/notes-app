/**
 * Merge rules for syncing the notes folder between computers (Google Drive,
 * OneDrive, Dropbox: anything that copies files around).
 *
 * Every cell, tree node and the page itself carries a version vector `vv`
 * ({ deviceId: counter }). A device bumps its own counter when it changes
 * something, so when two copies of a file meet we can tell, for every single
 * cell, whether one copy is simply newer (take it) or both laptops changed it
 * since they last saw each other (a real conflict: keep both versions).
 *
 * Deleted cells and nodes leave a tombstone (their last version vector), so a
 * deletion beats an older copy but never an edit the deleting laptop had not
 * seen yet.
 *
 * Pure functions only: no files, no DOM. Used by the Electron main process,
 * the browser server and the renderer.
 */

/* ------------------------------------------------------------------ *
 * Basics
 * ------------------------------------------------------------------ */

/** Deterministic JSON: object keys sorted, undefined values dropped. */
export function stable(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : stable(v))).join(',')}]`
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`
}

/** 64 bit FNV-1a as 16 hex chars. Same result in Node and the browser. */
export function hash(str) {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
    h2 = (h2 ^ (h2 >>> 15)) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

function omit(obj, skip) {
  const out = {}
  for (const k of Object.keys(obj || {})) if (!skip.has(k)) out[k] = obj[k]
  return out
}

/* ------------------------------------------------------------------ *
 * Version vectors
 * ------------------------------------------------------------------ */

/** 'equal', 'a' (a is newer), 'b' (b is newer) or 'concurrent'. */
export function vvCompare(a, b) {
  a = a || {}
  b = b || {}
  let aBig = false
  let bBig = false
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[k] || 0
    const bv = b[k] || 0
    if (av > bv) aBig = true
    else if (bv > av) bBig = true
  }
  if (aBig && bBig) return 'concurrent'
  if (aBig) return 'a'
  if (bBig) return 'b'
  return 'equal'
}

export function vvJoin(a, b) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) out[k] = Math.max(out[k] || 0, v || 0)
  return out
}

export function vvBump(vv, device) {
  const out = { ...(vv || {}) }
  out[device] = (out[device] || 0) + 1
  return out
}

function joinMaps(a, b) {
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b || {})) out[k] = vvJoin(out[k], v)
  return out
}

/** A tombstone deletes a cell or node only when it is strictly newer. */
function buried(tomb, vv) {
  return Boolean(tomb) && vvCompare(tomb, vv) === 'a'
}

/* ------------------------------------------------------------------ *
 * Cells
 * ------------------------------------------------------------------ */

/** What the person wrote or drew. Two different versions of this conflict. */
const CELL_CONTENT = ['html', 'title', 'strokes']
/** Where the cell sits. Can change on its own (auto height, reflow). */
const CELL_LAYOUT = new Set(['x', 'y', 'w', 'h', 'z'])
const CELL_META = new Set(['vv', 'updatedAt'])
const CELL_NOT_ATTR = new Set([...CELL_META, ...CELL_LAYOUT])

const cellBody = (c) => stable(omit(c, CELL_META))
const cellContent = (c) => stable(CELL_CONTENT.map((k) => c[k] ?? null))
const cellAttrs = (c) => stable(omit(c, CELL_NOT_ATTR))

export function sameCell(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return cellBody(a) === cellBody(b)
}

/** Fixed order for two concurrent versions, identical on every laptop. */
function newerFirst(a, b) {
  const ta = a.updatedAt || 0
  const tb = b.updatedAt || 0
  if (ta !== tb) return ta > tb ? [a, b] : [b, a]
  return hash(cellBody(a)) >= hash(cellBody(b)) ? [a, b] : [b, a]
}

const COPY_GAP = 20

/**
 * The losing side of a real conflict becomes a new cell right below the
 * winner. Its id comes from the content, so both laptops make the very same
 * copy and it never doubles up.
 */
export function conflictCopy(loser, winner) {
  const of = winner.id
  return {
    ...omit(loser, new Set(['vv', 'conflict'])),
    id: `cf${hash(`${of}|${cellContent(loser)}`).slice(0, 14)}`,
    x: winner.x,
    y: (winner.y || 0) + (winner.collapsed ? 40 : winner.h || 0) + COPY_GAP,
    z: winner.z,
    conflict: { of, reason: 'edited-both', at: loser.updatedAt || 0 },
    vv: {},
  }
}

/** Merge two versions of the same cell. Returns the cell and maybe a copy. */
function mergeCell(a, b, primary) {
  const cmp = vvCompare(a.vv, b.vv)
  if (cmp === 'a') return { cell: a }
  if (cmp === 'b') return { cell: b }
  // Same version but different text means someone edited without versions
  // (an older copy of this app). Treat it like a concurrent edit: keep both.
  if (cmp === 'equal' && cellContent(a) === cellContent(b)) return { cell: primary === 'a' ? a : b }

  const vv = vvJoin(a.vv, b.vv)
  if (cellBody(a) === cellBody(b)) return { cell: { ...(primary === 'a' ? a : b), vv } }
  const [win, lose] = newerFirst(a, b)
  if (cellContent(a) === cellContent(b)) {
    // Only position, size or look differ: the newer one wins, nothing is lost.
    return { cell: { ...win, vv } }
  }
  return { cell: { ...win, vv }, copy: conflictCopy(lose, win) }
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

const PAGE_META_KEYS = ['title', 'strokes', 'gridSize', 'needsReflow']
const pageMeta = (p) => stable(PAGE_META_KEYS.map((k) => p?.[k] ?? null))

/** True when two pages show exactly the same thing (versions ignored). */
export function samePageContent(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (pageMeta(a) !== pageMeta(b)) return false
  if ((a.cells || []).length !== (b.cells || []).length) return false
  const mb = new Map((b.cells || []).map((c) => [c.id, c]))
  for (const c of a.cells || []) if (!sameCell(c, mb.get(c.id))) return false
  return true
}

/**
 * Turn local edits into versions. `base` is the version the edits started
 * from, `touched` lists the cells the person moved or resized on purpose.
 * Layout changes the app made by itself (auto height, tidy) do not count as
 * edits, so two laptops with different screens never fight over them.
 *
 * Returns { page, bumped }. bumped is false when nothing worth syncing changed.
 */
export function stampPage(base, cur, device, touched, now) {
  const all = Boolean(touched?.all) || !base
  const touchedCells = new Set(touched?.cells || [])
  const baseCells = new Map((base?.cells || []).map((c) => [c.id, c]))
  const tomb = joinMaps(base?.tombstones, cur.tombstones)
  let bumped = false

  const cells = (cur.cells || []).map((c) => {
    const b = baseCells.get(c.id)
    if (b) {
      const vv = vvJoin(b.vv, c.vv)
      if (cellBody(b) === cellBody(c)) return { ...c, vv }
      const meant = all || touchedCells.has(c.id) || cellAttrs(b) !== cellAttrs(c)
      if (!meant) return { ...c, vv }
      bumped = true
      return { ...c, vv: vvBump(vv, device), updatedAt: Math.max(c.updatedAt || 0, now) }
    }
    bumped = true
    return { ...c, vv: vvBump(vvJoin(c.vv, tomb[c.id]), device), updatedAt: Math.max(c.updatedAt || 0, now) }
  })

  const ids = new Set(cells.map((c) => c.id))
  for (const b of base?.cells || []) {
    if (ids.has(b.id)) continue
    tomb[b.id] = vvBump(vvJoin(b.vv, tomb[b.id]), device)
    bumped = true
  }

  let metaVV = vvJoin(base?.metaVV, cur.metaVV)
  if (!base) {
    metaVV = vvBump(metaVV, device)
    bumped = true
  } else if (pageMeta(base) !== pageMeta(cur)) {
    const meant =
      all ||
      Boolean(touched?.meta) ||
      (base.title ?? '') !== (cur.title ?? '') ||
      stable(base.strokes || []) !== stable(cur.strokes || [])
    if (meant) {
      metaVV = vvBump(metaVV, device)
      bumped = true
    }
  }

  return { page: { ...cur, cells, tombstones: tomb, metaVV, syncV: 1 }, bumped }
}

function unionStrokes(a, b) {
  const seen = new Set()
  const out = []
  for (const s of [...(a || []), ...(b || [])]) {
    const k = stable(s)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}

/**
 * Merge two copies of a page. `primary` ('a' or 'b') breaks exact ties, which
 * only ever happen for layout the app measured by itself.
 */
export function mergePages(a, b, primary = 'a') {
  if (!a) return b
  if (!b) return a
  const tomb = joinMaps(a.tombstones, b.tombstones)
  const A = new Map((a.cells || []).map((c) => [c.id, c]))
  const B = new Map((b.cells || []).map((c) => [c.id, c]))
  const merged = new Map()
  const copies = []

  for (const id of new Set([...A.keys(), ...B.keys()])) {
    const ca = A.get(id)
    const cb = B.get(id)
    const { cell, copy } = ca && cb ? mergeCell(ca, cb, primary) : { cell: ca || cb }
    if (copy) copies.push(copy)
    merged.set(id, cell)
  }
  for (const copy of copies) {
    const have = merged.get(copy.id)
    merged.set(copy.id, have ? mergeCell(have, copy, 'a').cell : copy)
  }

  const cells = []
  for (const [id, cell] of merged) {
    const t = tomb[id]
    if (!t) {
      cells.push(cell)
      continue
    }
    if (buried(t, cell.vv)) continue
    if (vvCompare(t, cell.vv) === 'concurrent') {
      // Deleted on one laptop while edited on the other: keep it and say so.
      cells.push({
        ...cell,
        vv: vvJoin(cell.vv, t),
        conflict: cell.conflict || { reason: 'deleted-elsewhere', at: cell.updatedAt || 0 },
      })
    } else cells.push(cell)
  }
  cells.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))

  // Page level fields: title, page ink, grid size.
  const cmp = vvCompare(a.metaVV, b.metaVV)
  let meta
  if (cmp === 'a') meta = a
  else if (cmp === 'b') meta = b
  else if (cmp === 'equal') meta = primary === 'a' ? a : b
  else {
    const [win] = (a.updatedAt || 0) === (b.updatedAt || 0)
      ? (hash(pageMeta(a)) >= hash(pageMeta(b)) ? [a] : [b])
      : (a.updatedAt || 0) > (b.updatedAt || 0) ? [a] : [b]
    meta = { ...win, strokes: unionStrokes(a.strokes, b.strokes) }
  }

  const out = {
    ...(primary === 'a' ? a : b),
    id: a.id || b.id,
    title: meta.title,
    strokes: meta.strokes || [],
    gridSize: meta.gridSize,
    needsReflow: meta.needsReflow,
    cells,
    tombstones: tomb,
    metaVV: vvJoin(a.metaVV, b.metaVV),
    createdAt: Math.min(...[a.createdAt, b.createdAt].filter((t) => typeof t === 'number' && t > 0), Date.now()),
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    syncV: 1,
  }
  if (out.needsReflow === undefined) delete out.needsReflow
  if (out.gridSize === undefined) delete out.gridSize
  return out
}

/**
 * A file written by an older version of this app has no versions. Anything in
 * it that differs from what we last knew (`ref`) gets a fresh version from a
 * pseudo device, so it counts as a concurrent edit and is kept, not dropped.
 */
export function adoptLegacyPage(disk, ref, now) {
  if (!disk || disk.syncV || !ref) return disk
  const stamp = { legacy: now }
  const refCells = new Map((ref.cells || []).map((c) => [c.id, c]))
  const cells = (disk.cells || []).map((c) => {
    const r = refCells.get(c.id)
    if (r && cellBody(r) === cellBody(c)) return { ...c, vv: r.vv || {} }
    return { ...c, vv: vvJoin(r?.vv, stamp), updatedAt: Math.max(c.updatedAt || 0, now) }
  })
  const ids = new Set(cells.map((c) => c.id))
  const tombstones = { ...(ref.tombstones || {}) }
  for (const r of ref.cells || []) if (!ids.has(r.id)) tombstones[r.id] = vvJoin(r.vv, stamp)
  const metaVV = pageMeta(disk) === pageMeta(ref) ? ref.metaVV || {} : vvJoin(ref.metaVV, stamp)
  return { ...disk, cells, tombstones, metaVV }
}

/**
 * Edits made while a save was in flight are moved onto the saved result.
 * `cur` is the page now, `sent` what was saved, `result` what came back.
 */
export function rebasePage(cur, sent, result) {
  const S = new Map((sent.cells || []).map((c) => [c.id, c]))
  const R = new Map((result.cells || []).map((c) => [c.id, c]))
  const out = []
  const seen = new Set()

  for (const c of cur.cells || []) {
    seen.add(c.id)
    const s = S.get(c.id)
    const r = R.get(c.id)
    if (s && c === s) {
      if (r) out.push(r) // untouched here: take the saved version
      continue // gone in the result: deleted elsewhere
    }
    if (!s) {
      out.push(r ? mergeCell({ ...c, vv: r.vv }, r, 'a').cell : c) // new here
      continue
    }
    // Edited here during the save.
    if (!r || sameCell(r, s)) {
      out.push(r ? { ...c, vv: r.vv } : c)
    } else {
      // Changed elsewhere too: keep ours, the other version becomes a copy.
      out.push({ ...c, vv: r.vv })
      const copy = conflictCopy(r, c)
      if (!R.has(copy.id) && !seen.has(copy.id)) {
        out.push(copy)
        seen.add(copy.id)
      }
    }
  }
  for (const [id, r] of R) {
    if (seen.has(id)) continue
    if (S.has(id)) continue // deleted here during the save
    out.push(r)
  }

  const metaChangedHere = PAGE_META_KEYS.some((k) => cur[k] !== sent[k])
  return {
    ...result,
    ...(metaChangedHere ? Object.fromEntries(PAGE_META_KEYS.map((k) => [k, cur[k]])) : {}),
    cells: out,
  }
}

/* ------------------------------------------------------------------ *
 * Workspace (the notebook / section / page tree)
 * ------------------------------------------------------------------ */

export const RECOVERED_NOTEBOOK = '__recovered_nb'
export const RECOVERED_SECTION = '__recovered_sec'

const NODE_META = new Set(['vv', 'updatedAt'])
const nodeBody = (r) => stable(omit(r, NODE_META))

/** Tree to records: { id, kind, title, color, archived, createdAt, updatedAt, parentId, index, vv }. */
export function flattenTree(tree) {
  const out = new Map()
  const visit = (nodes, parentId) => {
    nodes.forEach((n, index) => {
      const rec = {
        id: n.id,
        kind: n.kind,
        title: n.title,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        parentId,
        index,
        vv: n.vv || {},
      }
      if (n.color) rec.color = n.color
      if (n.archived) rec.archived = true
      out.set(n.id, rec)
      visit(n.children || [], n.id)
    })
  }
  visit(tree || [], null)
  return out
}

function recoveredNode(id) {
  return id === RECOVERED_NOTEBOOK
    ? { id, kind: 'notebook', title: 'Recovered', color: '#e5c07b', createdAt: 0, updatedAt: 0, parentId: null, index: 1e9, vv: {} }
    : { id, kind: 'section', title: 'Recovered', createdAt: 0, updatedAt: 0, parentId: RECOVERED_NOTEBOOK, index: 1e9, vv: {} }
}

/** Records back to a tree. Nodes whose parent is gone land in "Recovered". */
export function buildTree(records) {
  const recs = new Map(records)
  const fallbackFor = (r) => {
    if (r.kind === 'notebook') return null
    if (r.kind === 'section') return RECOVERED_NOTEBOOK
    return RECOVERED_SECTION
  }
  const ensure = (id) => {
    if (!recs.has(id)) recs.set(id, recoveredNode(id))
    if (id === RECOVERED_SECTION) ensure(RECOVERED_NOTEBOOK)
  }

  // Missing parents.
  for (const r of [...recs.values()]) {
    if (r.parentId && !recs.has(r.parentId)) {
      const fb = fallbackFor(r)
      if (fb) ensure(fb)
      recs.set(r.id, { ...r, parentId: fb })
    }
  }
  // Cycles (two laptops moved two nodes into each other).
  for (const r of [...recs.values()]) {
    const seen = new Set([r.id])
    let p = recs.get(r.id).parentId
    while (p) {
      if (seen.has(p)) {
        const fb = fallbackFor(r)
        if (fb) ensure(fb)
        recs.set(r.id, { ...recs.get(r.id), parentId: fb })
        break
      }
      seen.add(p)
      p = recs.get(p)?.parentId ?? null
    }
  }

  const kids = new Map()
  for (const r of recs.values()) {
    const k = r.parentId || ''
    if (!kids.has(k)) kids.set(k, [])
    kids.get(k).push(r)
  }
  const make = (parentKey) =>
    (kids.get(parentKey) || [])
      .sort((x, y) => x.index - y.index || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .map((r) => {
        const n = { id: r.id, kind: r.kind, title: r.title, children: make(r.id), createdAt: r.createdAt, updatedAt: r.updatedAt, vv: r.vv }
        if (r.color) n.color = r.color
        if (r.archived) n.archived = true
        return n
      })
  const tree = make('')
  // An empty recovery folder is just noise.
  const prune = (nodes) =>
    nodes
      .filter((n) => !((n.id === RECOVERED_NOTEBOOK || n.id === RECOVERED_SECTION) && pruneEmpty(n)))
      .map((n) => ({ ...n, children: prune(n.children) }))
  const pruneEmpty = (n) => n.children.every((c) => (c.id === RECOVERED_NOTEBOOK || c.id === RECOVERED_SECTION) && pruneEmpty(c))
  return prune(tree)
}

/** Strip what each laptop keeps for itself and add versions to local edits. */
export function stampWorkspace(base, cur, device, now) {
  const B = flattenTree(base?.tree)
  const C = flattenTree(cur.tree)
  const tomb = joinMaps(base?.tombstones, cur.tombstones)
  let bumped = false
  const out = new Map()
  for (const [id, c] of C) {
    const b = B.get(id)
    if (b) {
      const vv = vvJoin(b.vv, c.vv)
      if (nodeBody(b) === nodeBody(c)) out.set(id, { ...c, vv })
      else {
        bumped = true
        out.set(id, { ...c, vv: vvBump(vv, device), updatedAt: Math.max(c.updatedAt || 0, now) })
      }
    } else {
      bumped = true
      out.set(id, { ...c, vv: vvBump(vvJoin(c.vv, tomb[id]), device) })
    }
  }
  for (const [id, b] of B) {
    if (C.has(id)) continue
    tomb[id] = vvBump(vvJoin(b.vv, tomb[id]), device)
    bumped = true
  }
  let favVV = vvJoin(base?.favVV, cur.favVV)
  if (!base || stable(base.favorites || []) !== stable(cur.favorites || [])) {
    favVV = vvBump(favVV, device)
    bumped = true
  }
  return {
    workspace: { version: 1, syncV: 1, tree: buildTree(out), favorites: cur.favorites || [], favVV, tombstones: tomb },
    bumped,
  }
}

export function mergeWorkspaces(a, b, primary = 'a') {
  if (!a) return b
  if (!b) return a
  const A = flattenTree(a.tree)
  const B = flattenTree(b.tree)
  const tomb = joinMaps(a.tombstones, b.tombstones)
  const out = new Map()
  for (const id of new Set([...A.keys(), ...B.keys()])) {
    const ra = A.get(id)
    const rb = B.get(id)
    let r
    if (ra && rb) {
      const cmp = vvCompare(ra.vv, rb.vv)
      if (cmp === 'a') r = ra
      else if (cmp === 'b') r = rb
      else if (cmp === 'equal') r = primary === 'a' ? ra : rb
      else {
        const ta = ra.updatedAt || 0
        const tb = rb.updatedAt || 0
        const win = ta !== tb ? (ta > tb ? ra : rb) : hash(nodeBody(ra)) >= hash(nodeBody(rb)) ? ra : rb
        r = { ...win, vv: vvJoin(ra.vv, rb.vv) }
      }
    } else r = ra || rb
    const t = tomb[id]
    if (t && buried(t, r.vv)) continue
    if (t && vvCompare(t, r.vv) === 'concurrent') r = { ...r, vv: vvJoin(r.vv, t) }
    out.set(id, r)
  }

  const fcmp = vvCompare(a.favVV, b.favVV)
  let favorites
  if (fcmp === 'a') favorites = a.favorites || []
  else if (fcmp === 'b') favorites = b.favorites || []
  else if (fcmp === 'equal') favorites = (primary === 'a' ? a : b).favorites || []
  else favorites = [...new Set([...(a.favorites || []), ...(b.favorites || [])])]
  favorites = favorites.filter((id) => out.has(id))

  return {
    version: 1,
    syncV: 1,
    tree: buildTree(out),
    favorites,
    favVV: vvJoin(a.favVV, b.favVV),
    tombstones: tomb,
  }
}

export function adoptLegacyWorkspace(disk, ref, now) {
  if (!disk || disk.syncV || !ref) return disk
  const stamp = { legacy: now }
  const R = flattenTree(ref.tree)
  const D = flattenTree(disk.tree)
  const recs = new Map()
  for (const [id, d] of D) {
    const r = R.get(id)
    if (r && nodeBody({ ...r, vv: undefined }) === nodeBody({ ...d, vv: undefined })) recs.set(id, { ...d, vv: r.vv })
    else recs.set(id, { ...d, vv: vvJoin(r?.vv, stamp) })
  }
  const tombstones = { ...(ref.tombstones || {}) }
  for (const [id, r] of R) if (!D.has(id)) tombstones[id] = vvJoin(r.vv, stamp)
  const favVV = stable(disk.favorites || []) === stable(ref.favorites || []) ? ref.favVV || {} : vvJoin(ref.favVV, stamp)
  return { ...disk, tree: buildTree(recs), tombstones, favVV }
}

export function sameWorkspaceContent(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  const A = flattenTree(a.tree)
  const B = flattenTree(b.tree)
  if (A.size !== B.size) return false
  for (const [id, r] of A) {
    const o = B.get(id)
    if (!o || nodeBody(r) !== nodeBody(o)) return false
  }
  return stable(a.favorites || []) === stable(b.favorites || [])
}

/** Edits to the tree made while a save was in flight, moved onto the result. */
export function rebaseWorkspace(cur, sent, result) {
  const C = flattenTree(cur.tree)
  const S = flattenTree(sent.tree)
  const R = flattenTree(result.tree)
  const out = new Map()
  for (const [id, c] of C) {
    const s = S.get(id)
    const r = R.get(id)
    if (s && nodeBody(s) === nodeBody(c)) {
      if (r) out.set(id, r)
    } else out.set(id, r ? { ...c, vv: r.vv } : c)
  }
  for (const [id, r] of R) if (!out.has(id) && !S.has(id)) out.set(id, r)
  const favChanged = stable(cur.favorites || []) !== stable(sent.favorites || [])
  return { ...result, tree: buildTree(out), favorites: favChanged ? cur.favorites : result.favorites }
}

/* ------------------------------------------------------------------ *
 * Settings: the newest change to each setting wins.
 * ------------------------------------------------------------------ */

export function stampSettings(base, cur, now) {
  const t = { ...(base?._t || {}), ...(cur._t || {}) }
  let bumped = !base
  for (const k of Object.keys(cur)) {
    if (k === '_t') continue
    if (!base || stable(cur[k]) !== stable(base[k])) {
      t[k] = now
      bumped = true
    }
  }
  return { settings: { ...cur, _t: t }, bumped }
}

export function mergeSettings(a, b, primary = 'a') {
  if (!a) return b
  if (!b) return a
  const out = { _t: {} }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === '_t') continue
    const ta = a._t?.[k] || 0
    const tb = b._t?.[k] || 0
    const pickA = ta !== tb ? ta > tb : primary === 'a'
    const src = pickA ? (k in a ? a : b) : (k in b ? b : a)
    out[k] = src[k]
    out._t[k] = Math.max(ta, tb)
  }
  return out
}

export function rebaseSettings(cur, sent, result) {
  const out = { ...result }
  for (const k of Object.keys(cur)) {
    if (k === '_t') continue
    if (stable(cur[k]) !== stable(sent[k])) out[k] = cur[k]
  }
  return out
}
