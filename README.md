# Notes

A fast, OneNote style notes app that is yours: notebooks, sections and pages on
the left, a free canvas of movable cells on the right, and every note stored as
a plain file in a folder you choose.

## Install (two clicks)

1. Download **Notes Setup.exe** from the
   [latest release](https://github.com/mamounyosef/notes-app/releases/latest).
2. Double click it. If Windows SmartScreen shows a warning, click
   **More info**, then **Run anyway** (the app is not code signed).

Notes appears on the desktop and in the start menu.

## Setup from source (one click)

1. Clone or copy this folder to the machine.
2. Double click **setup.bat**. It installs Node.js LTS with winget if it is
   missing.

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

## Syncing computers (Supabase)

Each computer keeps its own notes folder and syncs it through a free Supabase
project. Offline edits wait and upload later. A copy that is out of date
never replaces newer notes: the cloud is pulled and merged first, and a save
only lands on top of the latest version.

1. Create a project at supabase.com.
2. SQL Editor: paste `supabase/schema.sql` and run it.
3. Authentication, Users: add one user (email + password). Then turn off
   new sign ups under Authentication, Sign In / Providers.
4. In the app on every computer: **Settings, Storage, Cloud sync**. Enter the
   project URL, the publishable (anon) key (Project Settings, API) and your
   email and password.

Do not also keep the folder in OneDrive or Google Drive: let only one thing sync it.
Old versions of every note stay in the `doc_history` table for 30 days.

The database also guards itself against a sync loop, even from an old copy of
the app: an upload that changes nothing writes nothing, one note, file or chat
written more than 1200 times in an hour is refused for that hour, and more
than 10000 writes in a day are refused until the next day. A refused upload
stays saved on the computer and the sync button shows why. A nightly job
deletes history older than 30 days. After updating the app, run
`supabase/schema.sql` again to get these.

## Assistant

A chat panel on the right (**Ctrl+J**, or the Assistant button) that can do
anything in the app: add, edit, style, move and delete cells, create and
rename pages, sections and notebooks, change settings and colors. It runs on
Gemma 4 31B through Ollama Cloud.

- **Setup:** Settings, AI. Paste your Ollama API key (ollama.com, Settings,
  Keys). It is stored encrypted on that computer only, so enter it on each one.
- **It sees what you see:** every message carries the open page and its full
  content, the cells and the exact lines on screen, your selection, the caret
  and the mouse position, plus the whole notebook tree.
- **Undo:** each reply that changed something has an **Undo changes** button
  that puts back everything that reply did.
- **Attach:** paste images with Ctrl+V, drop or pick images, PDFs, Word and
  text files. Click an image to view and zoom it. Photos of handwritten notes
  can be turned into a page.
- **Point at things:** type @ to name a page, section or notebook. Select text
  or cells and press **Ctrl+L** (or right click a cell) to ask about them.
- **Voice typing:** the mic button starts Windows voice typing (Win+H).
- **Voice mode:** a real spoken conversation (see below).
- **Context meter:** the ring in the header shows how full the 256K token
  window is. Click it to see the breakdown, the system prompt, the tools and
  exactly what the assistant sees right now.
- **Chats sync** between computers through cloud sync (table `agent_chats`
  in `supabase/schema.sql`).

## Voice mode

Talk with the assistant out loud and hear it answer. Start it with the
waveform button in the assistant (or "Talk instead" on an empty chat), or
**Ctrl+Shift+Space** from anywhere.

- **The orb** shows who is talking: blue while it listens (rippling with your
  voice), violet while it thinks, orange with sparks while it speaks, grey
  when muted. A green ring bursts out when a reply changed your notes.
- **Everything is written down:** what you are saying appears live at the end
  of the chat, every spoken message stays as a normal message, and the
  sentence being spoken lights up in the reply.
- **Talk naturally:** fast, messy, with "um" and corrections ("blue, no,
  green" means green). It asks one short question out loud when something is
  unclear, and reads a question card out so you can answer by voice.
- **Cut in** any time and it stops to listen (a quick "mm-hm" does not stop
  it). Say **"undo that"** to take the last change back.
- **Math is read aloud** as words ("x squared over two"), never as LaTeX.
- **Keys:** Esc ends, M mutes, Space stops it talking, Enter sends now.
- **Settings, Voice:** 23 English voices with previews, speed, volume, how
  long a pause ends your turn, talking over it, follow along, soft sounds,
  and the **voice model**, picked separately from the chat's model and kept
  per computer. "Think before answering" is a separate switch (off by
  default: much faster to start). Each model shows how many seconds it takes
  to start talking, measured by **Test speed** and by every real voice reply.

**Free, local, no API key.** Hearing (Whisper) and speaking (Kokoro) run on
this computer's GPU through the weekly planner's speech engine
(`speech-server.py` and its `.venv-speech`): Notes uses it when the planner
already started it, and starts it otherwise. It finds the planner folder next
to Notes on its own; if not, pick it in Settings, Voice. Only the words go to
the model. Engine log: `speech-server.log` in the Notes app data folder.
While the engine runs, the title bar shows it with its graphics memory; click
it (or Settings, Voice, Turn off) to free the GPU, e.g. before gaming. On a
computer without a GPU it runs on the processor with a smaller Whisper:
slower, still free and local (that computer needs the planner folder with
`.venv-speech` and `speech-models` too).

Code: `electron/voice.ts` (finds and starts the engine), `src/voice/`
(audio session, conversation, speech text, prefs, speed test),
`src/components/voice/` (dock, orb, settings). The voice prompt is
`voicePrompt()` in `src/agent/prompt.ts`.

Test bench without a mic or GPU: `npx vite build`, then
`node scripts/voice-bench/serve.mjs` and open http://127.0.0.1:5198: a fake
speech engine, a scripted model and notes in the browser's storage.
`window.__fakeMic("what is on this page")` makes the mic say something.
`npm run test:voice` tests the speech text helpers.

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
