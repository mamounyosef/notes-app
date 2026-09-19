# Exports the whole OneNote hierarchy plus every page's XML into a folder,
# so the importer can work offline and be re-run safely.
#
#   powershell -ExecutionPolicy Bypass -File scripts\export-onenote.ps1 -Out .onenote-export
#
# Images and other attachments are written next to the XML as real files.
param(
  [string]$Out = '.onenote-export',
  # Folder holding the .one notebooks. Every notebook in it is opened first,
  # because OneNote only exposes notebooks that are currently open.
  [string]$NotebookRoot = '',
  [switch]$NoBinary
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $root $Out }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$pagesDir = Join-Path $Out 'pages'
$filesDir = Join-Path $Out 'files'
New-Item -ItemType Directory -Force -Path $pagesDir, $filesDir | Out-Null

$on = New-Object -ComObject OneNote.Application

# Open every notebook found under the root so closed ones are exported too.
if (-not $NotebookRoot) {
  $guess = Join-Path $env:USERPROFILE 'OneDrive\Documents\OneNote Notebooks'
  if (Test-Path -LiteralPath $guess) { $NotebookRoot = $guess }
}
if ($NotebookRoot -and (Test-Path -LiteralPath $NotebookRoot)) {
  # A notebook is opened by its folder, not by the .onetoc2 file inside it.
  $books = Get-ChildItem -LiteralPath $NotebookRoot -Recurse -Filter '*.onetoc2' -File |
    Where-Object { $_.DirectoryName -notlike '*OneNote_RecycleBin*' } |
    ForEach-Object { $_.DirectoryName } | Sort-Object -Unique
  foreach ($book in $books) {
    try {
      $id = ''
      $on.OpenHierarchy($book, '', [ref]$id, 0)
      Write-Host "Opened notebook: $(Split-Path -Leaf $book)"
    } catch {
      Write-Warning "Could not open $book : $($_.Exception.Message)"
    }
  }
  # Give OneNote a moment to load what it just opened.
  Start-Sleep -Seconds 3
}

$xml = ''
$on.GetHierarchy('', 4, [ref]$xml)
[System.IO.File]::WriteAllText((Join-Path $Out 'hierarchy.xml'), $xml, [System.Text.Encoding]::UTF8)
$hier = [xml]$xml
$ns = New-Object System.Xml.XmlNamespaceManager($hier.NameTable)
$ns.AddNamespace('one', $hier.DocumentElement.NamespaceURI)

$pages = $hier.SelectNodes('//one:Page', $ns)
Write-Host "Exporting $($pages.Count) pages to $Out"

$i = 0
foreach ($p in $pages) {
  $i++
  $safe = ($p.ID -replace '[^0-9A-Za-z]', '')
  $content = ''
  try {
    # 1 = piBinaryData, so images and ink come with their bytes.
    $level = if ($NoBinary) { 0 } else { 1 }
    $on.GetPageContent($p.ID, [ref]$content, $level)
  } catch {
    Write-Warning "Could not read page '$($p.name)': $($_.Exception.Message)"
    continue
  }
  [System.IO.File]::WriteAllText((Join-Path $pagesDir "$safe.xml"), $content, [System.Text.Encoding]::UTF8)
  Write-Progress -Activity 'Exporting OneNote' -Status $p.name -PercentComplete (100 * $i / [Math]::Max(1, $pages.Count))
}

Write-Progress -Activity 'Exporting OneNote' -Completed
Write-Host "Done. $i pages written."
