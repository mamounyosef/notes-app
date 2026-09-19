# Dumps the raw XML of one OneNote page so the importer can be written
# against the real shape of the data.
#   -Index picks which page (0 based) from the whole hierarchy.
param(
  [int]$Index = 0,
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

$on = New-Object -ComObject OneNote.Application
$xml = ''
$on.GetHierarchy('', 4, [ref]$xml)
$hier = [xml]$xml
$ns = New-Object System.Xml.XmlNamespaceManager($hier.NameTable)
$ns.AddNamespace('one', $hier.DocumentElement.NamespaceURI)

$pages = $hier.SelectNodes('//one:Page', $ns)
if ($Index -ge $pages.Count) { throw "Only $($pages.Count) pages" }
$page = $pages[$Index]
Write-Host "Page: $($page.name)  id=$($page.ID)"

$content = ''
$on.GetPageContent($page.ID, [ref]$content, 0)   # 0 = piBasic, no binary blobs
if ($Out) {
  [System.IO.File]::WriteAllText($Out, $content, [System.Text.Encoding]::UTF8)
  Write-Host "Wrote $Out ($($content.Length) chars)"
} else {
  Write-Output $content
}
