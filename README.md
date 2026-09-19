# Notes

A fast, OneNote style notes app that is yours: notebooks, sections and pages on
the left, a free canvas of movable cells on the right, and every note stored as
a plain file in a folder you choose.

## Setup on a new machine (one click)

1. Install [Node.js LTS](https://nodejs.org) if it is not there yet.
2. Copy this folder to the machine.
3. Double click **setup.bat**.

It installs everything, builds the app, and puts a **Notes** icon on your
desktop and in the start menu. Launch it from there, or from `run-notes.bat`.

### In a browser too

Run **serve-notes.bat** and open `http://localhost:5299`. It serves the same
notes folder, so the app window and the browser tab show the same notes.

## Where notes are stored

```
MyNotes/
  workspace.json     the notebook, section and page tree
  settings.json      your settings
  pages/<id>.json    one file per page, holding its cells
  assets/            pasted and imported images
  .trash/            deleted pages, kept just in case
```

Default location is `Documents\MyNotes`. Change it in **Settings, Storage**.
To keep a laptop and a desktop in step, point both at the same folder inside
OneDrive, Google Drive or Dropbox.

## Bringing OneNote notes across

Double click **migrate-from-onenote.bat**. It asks where your notebooks are
and where the imported notes should go, then does three things:

1. reads every notebook through OneNote's own interface,
2. converts each page into notes,
3. checks the result against OneNote page by page, word by word.

**OneNote is only ever read.** Nothing there is created, changed or deleted,
and the import is written into a new folder, so your existing notes are safe
too. The one visible side effect is that notebooks which were closed in
OneNote get opened so they can be read; right click and Close Notebook puts
that back.

What comes across:

| OneNote | Notes |
|---|---|
| Notebook, section group, section | Notebook, nested sections |
| Page and subpage | Page and nested page |
| Note container, with its position and width | Cell in the same place |
| Bold, italic, underline, colors, fonts, sizes, alignment | The same |
| Bullet and numbered lists, including nesting | Real lists |
| To do tags | Checklists, keeping what was ticked |
| Tables | Real tables |
| Images | Files in the assets folder |
| Equations | LaTeX, rendered live and editable |
| Handwriting and ink | **Not imported**, a marker is left in its place |

Pages in the OneNote recycle bin are skipped. After the run,
`import-report.json` in the output folder lists everything that happened,
and `npm run onenote:verify -- --out "<folder>"` can be re-run at any time.

Then open Notes, go to **Settings, Storage, Change**, and pick the folder it
wrote.

## Using it

**Structure.** Notebooks hold sections, sections nest inside sections, pages
nest inside pages. Right click anything in the side panes for new, rename,
color, favorite, export and delete. Drag rows to reorder or to nest them.
Drag the divider to resize a pane, double click the divider to hide it,
Ctrl+1 and Ctrl+2 toggle them.

**Cells.** Double click empty space for a new cell. Every cell starts with a
bold title line, then its body. Drag the strip at the top to move it, drag any
edge or the corner to resize, and it grows by itself as you type. Select
several with a rubber band or Ctrl+click, then move, align, stack, duplicate
or delete them together.

**Insert space.** Press S or pick the arrows tool, then drag down on the page.
Everything below the line you started from moves down by the same amount,
including ink. Drag up to pull the content back.

**Writing.** Markdown shortcuts as you type: `#` heading, `-` bullet,
`1.` numbered, `[]` checklist, `>` quote, ``` code block, `---` line.
LaTeX with `$x^2$` and `$$...$$`, click any formula to edit it.

**Pasting from an AI chat.** Paste Markdown and it arrives as real formatting:
headings, lists, tables, code blocks, and LaTeX in `$...$`, `$$...$$`,
`\( ... \)` and `\[ ... \]`. Images paste straight into the note and are saved
into the assets folder. Change this in Settings, Editing.

**Drawing.** P for pen, H for highlighter, E for eraser, V back to select.
Color and thickness sit next to the tools and in Settings.

**Finding things.** Ctrl+F searches every page and every cell.

**Settings.** Ctrl+, covers themes and accent, fonts and default sizes and
colors, cell defaults, grid size and snapping, pen defaults, paste behaviour,
autosave, and the notes folder.

Press **F1** in the app for the full list of keys.

## Developing

```
npm run dev     app plus live reload
npm run build   build the renderer and the Electron files
npm start       run the built app
npm run serve   browser mode on port 5299
npm run icon    redraw build/icon.ico
npm run dist    optional Windows installer (needs Windows developer mode on,
                otherwise use setup.bat, which needs no admin rights)
```
