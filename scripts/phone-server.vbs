' Starts the Notes phone server hidden (see phone-server-run.ps1).
' Does nothing when it is already running (port 4790 answers).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = "D:\My Projects\My Apps\notes-app"
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:4790/robots.txt", False
http.Send
If Err.Number = 0 And http.Status = 200 Then WScript.Quit
On Error GoTo 0
sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & repo & "\scripts\phone-server-run.ps1""", 0, False
