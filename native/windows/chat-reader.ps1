$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName WindowsBase
    $source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'ChatReader.cs'), [System.Text.Encoding]::UTF8)
    Add-Type -TypeDefinition $source -ReferencedAssemblies @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, 'System.dll', 'System.Core.dll')
} catch {
    # No raw compiler or accessibility errors on stdout/stderr (they may contain private paths).
    exit 2
}
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        if ($request.op -notin @('list', 'read', 'diagnose') -or $request.room.Length -gt 200) { exit 3 }
        $capture = [ReplyWindowsReader]::Capture([string]$request.op, [string]$request.room)
        $packet = @{ id = $request.id; capture = $capture }
        [Console]::WriteLine(($packet | ConvertTo-Json -Compress -Depth 8))
    } catch { exit 4 }
}
