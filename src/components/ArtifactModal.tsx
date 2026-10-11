import React, { useEffect, useRef, useState } from 'react'
import { useActiveEditor } from '../editor/activeEditor'
import { storage, type ArtifactItem } from '../lib/storage'
import { useStore } from '../store'
import { ArtifactI, Folder, File as FileIcon, ArrowLeft, X } from './Icons'

export default function ArtifactModal({ onClose }: { onClose(): void }) {
  const editor = useActiveEditor((s) => s.editor)
  const isDesktop = storage.isDesktop

  const [currentDir, setCurrentDir] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [title, setTitle] = useState('')
  const [isFolder, setIsFolder] = useState(false)
  const [isExisting, setIsExisting] = useState(false)
  const [items, setItems] = useState<ArtifactItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const titleInputRef = useRef<HTMLInputElement>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)

  // Load existing selection if cursor is on an artifact link
  useEffect(() => {
    if (editor) {
      const existingHref = editor.getAttributes('link').href || ''
      const { from, to, empty } = editor.state.selection
      const selectedText = empty ? '' : editor.state.doc.textBetween(from, to)

      const hasLink = Boolean(editor.isActive('link'))
      if (hasLink && existingHref.startsWith('artifact:')) {
        setIsExisting(true)
        let rel = existingHref.replace(/^artifact:\/\//i, '')
        if (rel.toLowerCase().startsWith('local/')) rel = rel.slice(6)
        rel = decodeURIComponent(rel)
        setSelectedPath(rel)
        setTitle(selectedText || rel.split(/[\\/]/).pop() || '')
        // Open parent directory if any
        if (rel.includes('/')) {
          setCurrentDir(rel.slice(0, rel.lastIndexOf('/')))
        }
      } else {
        if (selectedText) setTitle(selectedText)
      }
    }
  }, [editor])

  // Load items from the artifacts directory for currentDir
  const loadArtifacts = async (dir: string, isSearch: boolean) => {
    setLoading(true)
    try {
      // If searching, search recursively; otherwise list current directory
      const list = await storage.listArtifacts(dir, isSearch)
      setItems(list)
    } catch (err) {
      console.error('Failed to list artifacts:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const isSearching = Boolean(filter.trim())
    // When searching, search from currentDir (or root if currentDir is empty)
    loadArtifacts(currentDir, isSearching)
  }, [currentDir, filter])

  const handlePickFile = async () => {
    const res = await storage.pickArtifactFile(currentDir)
    if (res) {
      setSelectedPath(res.relativePath)
      setIsFolder(false)
      if (!title.trim() || title === selectedPath) {
        setTitle(res.name)
      }
      titleInputRef.current?.focus()
    }
  }

  const handlePickDirectory = async () => {
    const res = await storage.pickArtifactDirectory(currentDir)
    if (res) {
      setSelectedPath(res.relativePath)
      setIsFolder(true)
      if (!title.trim() || title === selectedPath) {
        setTitle(res.name)
      }
      titleInputRef.current?.focus()
    }
  }

  const handleSelectItem = (item: ArtifactItem) => {
    setSelectedPath(item.relativePath)
    setIsFolder(item.isDirectory)
    if (!title.trim() || title === selectedPath) {
      setTitle(item.name)
    }
  }

  const handleOpenFolder = async () => {
    await storage.revealArtifact(selectedPath || currentDir || '')
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    const rel = selectedPath.trim()

    if (!rel) {
      if (isExisting && editor) {
        editor.chain().focus().unsetLink().run()
      }
      onClose()
      return
    }

    // Format uniform relative URI
    const cleanRel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
    const finalUrl = 'artifact://local/' + encodeURI(cleanRel)
    const displayText = title.trim() || cleanRel.split('/').pop() || cleanRel

    if (editor) {
      const { from, to, empty } = editor.state.selection
      const selectedText = empty ? '' : editor.state.doc.textBetween(from, to)

      if (empty) {
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: displayText,
            marks: [{ type: 'link', attrs: { href: finalUrl } }],
          })
          .run()
      } else {
        if (displayText && displayText !== selectedText) {
          editor
            .chain()
            .focus()
            .insertContent({
              type: 'text',
              text: displayText,
              marks: [{ type: 'link', attrs: { href: finalUrl } }],
            })
            .run()
        } else {
          editor.chain().focus().setLink({ href: finalUrl }).run()
        }
      }
    } else {
      const st = useStore.getState()
      if (st.page) {
        st.addCell({
          html: `<p><a href="${finalUrl}" target="_blank" rel="noopener noreferrer">${displayText}</a></p>`,
        })
      }
    }

    onClose()
  }

  const handleRemove = () => {
    if (editor) {
      editor.chain().focus().unsetLink().run()
    }
    onClose()
  }

  const pathSegments = currentDir ? currentDir.split('/') : []

  const filteredItems = items.filter((it) => {
    if (!filter.trim()) return true
    return (
      it.name.toLowerCase().includes(filter.trim().toLowerCase()) ||
      it.relativePath.toLowerCase().includes(filter.trim().toLowerCase())
    )
  })

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal artifact-modal" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head">
          <ArtifactI size={18} />
          <h2>{isExisting ? 'Edit artifact' : 'Insert artifact'}</h2>
          <div className="spacer" />
          <button className="tb-btn" onClick={onClose}><X /></button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          <div className="artifact-actions-bar">
            {isDesktop && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={handlePickDirectory}
                  title="Browse this folder for a subfolder"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <Folder size={15} /> Select Folder...
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handlePickFile}
                  title="Browse this folder for a file"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                >
                  <FileIcon size={15} /> Select File...
                </button>
                <div className="spacer" />
                <button
                  type="button"
                  className="btn secondary-subtle"
                  onClick={handleOpenFolder}
                  title="Open the current folder in Windows File Explorer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
                >
                  Open in Explorer
                </button>
              </>
            )}
          </div>

          <div className="artifact-picker-container">
            <div className="artifact-picker-head">
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-faint)' }}>
                Artifacts Folder
              </span>
              <input
                type="text"
                className="artifact-filter-input"
                placeholder="Search files/folders..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>

            {/* Breadcrumb Navigation Bar */}
            <div className="artifact-breadcrumbs">
              <button
                type="button"
                className={`breadcrumb-item ${currentDir === '' ? 'active' : ''}`}
                onClick={() => setCurrentDir('')}
                title="Go to root artifacts folder"
              >
                <Folder size={13} /> artifacts
              </button>
              {pathSegments.map((seg, idx) => {
                const segPath = pathSegments.slice(0, idx + 1).join('/')
                const isLast = idx === pathSegments.length - 1
                return (
                  <React.Fragment key={segPath}>
                    <span className="breadcrumb-separator">/</span>
                    <button
                      type="button"
                      className={`breadcrumb-item ${isLast ? 'active' : ''}`}
                      onClick={() => setCurrentDir(segPath)}
                      title={`Go to ${seg}`}
                    >
                      {seg}
                    </button>
                  </React.Fragment>
                )
              })}
              {currentDir !== '' && (
                <button
                  type="button"
                  className="select-folder-pill"
                  title={`Use "${currentDir}" as the linked folder`}
                  onClick={() => {
                    setSelectedPath(currentDir)
                    setIsFolder(true)
                    const name = currentDir.split('/').pop() || currentDir
                    setTitle(name)
                  }}
                >
                  Link this folder
                </button>
              )}
            </div>

            <div className="artifact-list">
              {/* Up to parent row if inside subfolder and not searching */}
              {currentDir !== '' && !filter.trim() && (
                <div
                  className="artifact-item-row up-row"
                  onClick={() => {
                    const parent = currentDir.includes('/')
                      ? currentDir.slice(0, currentDir.lastIndexOf('/'))
                      : ''
                    setCurrentDir(parent)
                  }}
                  title="Go to parent folder"
                >
                  <span className="artifact-item-icon" style={{ color: 'var(--text-faint)' }}>
                    <ArrowLeft size={14} />
                  </span>
                  <span className="artifact-item-name" style={{ fontStyle: 'italic', color: 'var(--text-faint)' }}>
                    .. (Parent folder)
                  </span>
                </div>
              )}

              {loading ? (
                <div className="artifact-empty-hint">Loading folder contents...</div>
              ) : filteredItems.length === 0 ? (
                <div className="artifact-empty-hint">
                  {filter ? 'No matching artifacts found.' : 'This folder is empty.'}
                </div>
              ) : (
                filteredItems.map((it) => {
                  const isSelected = selectedPath === it.relativePath
                  return (
                    <div
                      key={it.relativePath}
                      className={`artifact-item-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleSelectItem(it)}
                      onDoubleClick={() => {
                        if (it.isDirectory) {
                          setCurrentDir(it.relativePath)
                        } else {
                          handleSelectItem(it)
                          setTimeout(() => handleSubmit(), 50)
                        }
                      }}
                      title={`${it.name} (${it.isDirectory ? 'Double-click to open folder' : 'Double-click to insert file'})`}
                    >
                      <span className="artifact-item-icon" style={{ color: it.isDirectory ? '#ffd000' : 'var(--text-faint)' }}>
                        {it.isDirectory ? <Folder size={16} /> : <FileIcon size={16} />}
                      </span>
                      <span className="artifact-item-name">
                        {filter ? it.relativePath : it.name}
                      </span>
                      {it.isDirectory ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button
                            type="button"
                            className="artifact-enter-btn"
                            title="Open and view inside this folder"
                            onClick={(e) => {
                              e.stopPropagation()
                              setCurrentDir(it.relativePath)
                            }}
                          >
                            Open ➜
                          </button>
                          <span className="artifact-item-badge">Folder</span>
                        </div>
                      ) : (
                        <span className="artifact-item-badge">File</span>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="link-field" style={{ marginTop: 12 }}>
            <label>Selected artifact path (relative to artifacts folder)</label>
            <input
              ref={pathInputRef}
              className="link-input"
              placeholder="e.g. CNNs Architicutres or CNNs Architicutres/pages/convnext/convnext_base_architecture.html"
              value={selectedPath}
              onChange={(e) => setSelectedPath(e.target.value)}
            />
          </div>

          <div className="link-field">
            <label>Text to display in note (defaults to file/folder title)</label>
            <input
              ref={titleInputRef}
              className="link-input"
              placeholder="Display text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
              Links appear in your note as editable text, styled in yellow. Click to open in File Explorer or browser.
            </div>
          </div>

          <div className="link-modal-actions">
            {isExisting && (
              <button
                type="button"
                className="btn danger"
                onClick={handleRemove}
                style={{ marginRight: 'auto' }}
              >
                Remove artifact
              </button>
            )}
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!selectedPath.trim()}>
              {isExisting ? 'Save' : 'Insert'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
