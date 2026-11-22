' Watchdog for the Notes phone server (Notes and Planner connectors for Claude).
' Run by the "Notes Phone Server Watchdog" scheduled task at sign-in and every
' 2 minutes (scripts\install-phone-server-task.ps1). Quits at once when the server
' answers; otherwise starts phone-server-run.ps1 -Restart hidden, which clears any
' hung copy first. No window ever shows.
Set sh = CreateObject("WScript.Shell")
repo = "D:\My Projects\My Apps\notes-app"

Function Healthy()
  Healthy = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  ' resolve, connect, send, receive (ms): a hung server counts as down.
  http.setTimeouts 3000, 3000, 5000, 5000
  http.Open "GET", "http://127.0.0.1:4790/robots.txt", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then Healthy = True
  End If
  On Error GoTo 0
End Function

If Healthy() Then WScript.Quit
' Give a server that is just starting a second chance before restarting it.
WScript.Sleep 8000
If Healthy() Then WScript.Quit
sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & repo & "\scripts\phone-server-run.ps1"" -Restart", 0, False
