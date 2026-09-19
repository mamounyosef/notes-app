# Checks whether the OneNote desktop automation interface is available here
# and prints the notebook / section / page counts it can see.
$ErrorActionPreference = 'Stop'
try {
  $on = New-Object -ComObject OneNote.Application
} catch {
  Write-Host "NO_COM: $($_.Exception.Message)"
  exit 1
}

[xml]$hier = ''
$xml = ''
$on.GetHierarchy('', 4, [ref]$xml)   # 4 = hsPages, the whole tree
$hier = [xml]$xml

$ns = New-Object System.Xml.XmlNamespaceManager($hier.NameTable)
$ns.AddNamespace('one', $hier.DocumentElement.NamespaceURI)

$notebooks = $hier.SelectNodes('//one:Notebook', $ns)
$sections = $hier.SelectNodes('//one:Section', $ns)
$pages = $hier.SelectNodes('//one:Page', $ns)

Write-Host "COM_OK"
Write-Host "Notebooks: $($notebooks.Count)"
Write-Host "Sections:  $($sections.Count)"
Write-Host "Pages:     $($pages.Count)"
foreach ($n in $notebooks) { Write-Host ("  notebook: " + $n.name + "  [" + $n.path + "]") }
