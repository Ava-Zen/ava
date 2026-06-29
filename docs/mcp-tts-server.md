# Ava MCP TTS Server

Ava can host a small **Model Context Protocol (MCP)** server so other local agents —
GitHub Copilot, Claude Desktop, Cursor, or any MCP-aware tool — can call Ava to **speak
text aloud**. This gives those agents a natural, on-device voice without bundling their
own text-to-speech.

## How it works

- The MCP server runs inside Ava's Rust (Tauri) backend, on the desktop build, while Ava
  is open.
- It listens only on the loopback interface: `http://127.0.0.1:7456` (port `7456` is
  rarely used, so it stays out of the way of common dev servers).
- TTS itself is produced by Ava's on-device Kokoro voice (with system speech as a
  fallback) and played on the machine running Ava.
- The transport is MCP **Streamable HTTP** (JSON-RPC over `POST`).

The endpoint and status are also shown in **Settings → Integrations → MCP voice server**.

## Tools

| Tool          | Arguments                                   | Description                                   |
| ------------- | ------------------------------------------- | --------------------------------------------- |
| `speak`       | `text` (string, required), `voice` (string) | Speaks the text aloud through Ava's voice.    |
| `list_voices` | _none_                                      | Lists the Kokoro voices Ava can speak with.   |

`speak` returns once playback finishes (up to a 2-minute timeout). The optional `voice`
id can be any value returned by `list_voices` (e.g. `af_bella`, `bm_george`).

## Add to VS Code (GitHub Copilot)

1. Make sure Ava is running.
2. Create or edit `.vscode/mcp.json` in your workspace:

   ```json
   {
     "servers": {
       "ava-tts": {
         "type": "http",
         "url": "http://127.0.0.1:7456"
       }
     }
   }
   ```

3. Open the Copilot Chat **Agent** mode, click the tools icon, and confirm `ava-tts`
   exposes `speak` and `list_voices`. Try: _"Use Ava to say hello."_

You can also add it globally via the command palette → **MCP: Add Server… → HTTP** and
point it at `http://127.0.0.1:7456`.

## Add to Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config) and add:

```json
{
  "mcpServers": {
    "ava-tts": {
      "url": "http://127.0.0.1:7456"
    }
  }
}
```

Restart Claude Desktop, then ask it to speak through Ava.

## Add to Cursor

Add to `~/.cursor/mcp.json` (or the project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "ava-tts": {
      "url": "http://127.0.0.1:7456"
    }
  }
}
```

## Quick test (curl)

```bash
curl -s http://127.0.0.1:7456 -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"speak","arguments":{"text":"Hello from Ava."}}}'
```

## Notes & security

- Bound to `127.0.0.1` only — not reachable from other machines.
- Available on desktop builds; mobile builds do not host the server.
- Ava must be open for the voice to play.
