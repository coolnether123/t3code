Option Explicit
Dim shell, command, argument, exitCode
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
command = ""
For Each argument In WScript.Arguments
  If InStr(argument, Chr(34)) > 0 Then WScript.Quit 2
  command = command & Chr(34) & argument & Chr(34) & " "
Next
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
