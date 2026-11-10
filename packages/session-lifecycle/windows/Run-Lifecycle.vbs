Option Explicit
Dim shell, runner, configuration, node, rc
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
node = WScript.Arguments(0)
runner = WScript.Arguments(1)
configuration = WScript.Arguments(2)
If InStr(node, """") > 0 Or InStr(runner, """") > 0 Or InStr(configuration, """") > 0 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
rc = shell.Run("""" & node & """ """ & runner & """ --config """ & configuration & """", 0, True)
WScript.Quit rc
