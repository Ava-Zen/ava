# Manually triggers Ava's MCP TTS server to verify the voice bridge works.
#
# Ava must be running (desktop build) so the MCP server is hosted on the
# loopback endpoint. Run from anywhere:
#
#   pwsh ./scripts/test-mcp-tts.ps1
#   pwsh ./scripts/test-mcp-tts.ps1 -Text "Custom message" -Voice bm_george

[CmdletBinding()]
param(
  [string]$Text = "Hi, I'm Ava. This is a test of the MCP voice server. If you can hear me, your agent can borrow my voice.",
  [string]$Voice = "",
  [int]$Port = 7456
)

$ErrorActionPreference = "Stop"
$url = "http://127.0.0.1:$Port"

function Invoke-Mcp([hashtable]$payload) {
  $body = $payload | ConvertTo-Json -Depth 8 -Compress
  return Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $body
}

Write-Host "Ava MCP TTS test -> $url" -ForegroundColor Cyan

try {
  $tools = Invoke-Mcp @{ jsonrpc = "2.0"; id = 1; method = "tools/list"; params = @{} }
  Write-Host "Available tools:" ($tools.result.tools.name -join ", ")
} catch {
  Write-Warning "Could not reach Ava MCP server at $url. Is Ava running?"
  exit 1
}

$speakArgs = @{ text = $Text }
if ($Voice) { $speakArgs.voice = $Voice }

Write-Host "Speaking: `"$Text`"" -ForegroundColor Green
$result = Invoke-Mcp @{
  jsonrpc = "2.0"
  id      = 2
  method  = "tools/call"
  params  = @{ name = "speak"; arguments = $speakArgs }
}

if ($result.result.isError) {
  Write-Warning ($result.result.content.text -join " ")
  exit 1
}

Write-Host ($result.result.content.text -join " ")
