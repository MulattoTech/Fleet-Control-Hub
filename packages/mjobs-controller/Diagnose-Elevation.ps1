$ErrorActionPreference = 'Stop'
$definition = @"
using System;
using System.Runtime.InteropServices;
public class ProcElevation {
 [DllImport("kernel32.dll", SetLastError = true)]
 public static extern IntPtr OpenProcess(uint desiredAccess, bool inherit, int processId);
 [DllImport("advapi32.dll", SetLastError = true)]
 public static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
 [DllImport("advapi32.dll", SetLastError = true)]
 public static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass, IntPtr information, int length, out int returnLength);
 [DllImport("kernel32.dll", SetLastError = true)]
 public static extern bool CloseHandle(IntPtr handle);
 public static string Status(int id) {
   IntPtr process = OpenProcess(0x1000, false, id);
   if (process == IntPtr.Zero) return "OpenProcess failed "+Marshal.GetLastWin32Error();
   IntPtr token = IntPtr.Zero;
   try {
      if(!OpenProcessToken(process, 0x8, out token))return "OpenToken failed "+Marshal.GetLastWin32Error();
      IntPtr buffer=Marshal.AllocHGlobal(4);
      try {
        int len;
        if (!GetTokenInformation(token,20,buffer,4,out len)) return "TokenElevation failed "+Marshal.GetLastWin32Error();
        int elev=Marshal.ReadInt32(buffer);
        if (!GetTokenInformation(token,18,buffer,4,out len)) return "TokenType failed "+Marshal.GetLastWin32Error();
        int kind=Marshal.ReadInt32(buffer);
        return (elev !=0?"Elevated":"NotElevated") + " / ElevationType="+kind;
      } finally { Marshal.FreeHGlobal(buffer); }
   }finally{if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
 }
}
"@
Add-Type -TypeDefinition $definition -ErrorAction Stop
$processes=Get-CimInstance Win32_Process |
 Where-Object {$_.Name -in @('agent-orchestrator.exe','codex.exe','ao.exe','node.exe','explorer.exe','powershell.exe','pwsh.exe')}
$targets = @(
    $processes | Where-Object {$_.Name -eq 'agent-orchestrator.exe' -and $_.CommandLine -notmatch '\-\-type='} | Select-Object -First 1
    $processes | Where-Object {$_.Name -eq 'codex.exe' -and $_.CommandLine -match 'resume'} | Select-Object -First 3
    $processes | Where-Object {$_.Name -eq 'ao.exe' -and $_.CommandLine -match 'pty-host'} | Select-Object -First 3
    $processes | Where-Object {$_.Name -eq 'explorer.exe'} | Select-Object -First 1
    $processes | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -like '*AO-Fleet-Control*server.js*'} | Select-Object -First 1
    $processes | Where-Object {$_.Name -eq 'pwsh.exe'} | Select-Object -First 2
)
$targets | Where-Object { $_ -and $_.ProcessId } | ForEach-Object {
 [pscustomobject]@{ Name=$_.Name; ProcessId=$_.ProcessId; Parent=$_.ParentProcessId; Elevation=[ProcElevation]::Status([int]$_.ProcessId) }
} | Format-Table -AutoSize
