$taskNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { $taskNode = 'node' }
& $taskNode (Join-Path $PSScriptRoot 'bin\mct.mjs') @args
exit $LASTEXITCODE
