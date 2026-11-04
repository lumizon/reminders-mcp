# reminders-mcp

An MCP server for controlling macOS Reminders.

## Tools

| Tool | Description |
| --- | --- |
| `list_lists` | All lists, with incomplete counts and which is the default |
| `list_reminders` | Filter by list, completion state, text, due range, flag; sorted by due date |
| `get_reminder` | Full details (alarms, URL, creation/modified dates, recurrence) |
| `create_reminder` | Title, list, notes, due date, alert, priority, flag, URL |
| `update_reminder` | Change any field; `null` clears notes/due/alert/URL; `list` moves it |
| `complete_reminder` | Mark done / not done |
| `delete_reminder` | Delete a reminder |
| `create_list` / `delete_list` | Manage lists |

Dates: `"YYYY-MM-DD"` for all-day, or ISO 8601 like `"2026-11-05T15:00"` (local time unless an offset is given).

## How it works

- `helper/main.swift` → `bin/reminders-helper`: a one-shot EventKit CLI that does nearly all the work. EventKit is fast, can tell timed from all-day due dates, and can clear fields, which Reminders' AppleScript interface cannot.
- EventKit has no public API for the **flagged** state, so that one field is read and written through JXA (`osascript`).
- `src/` is the TypeScript MCP server (stdio) that calls both.

A reminder created through EventKit can take a few seconds to appear in Reminders' scripting interface. Setting a flag at creation therefore retries for up to ~8 s. If the flag still can't be set or read, the reminder is returned with `flagged: null` and a `warning` instead of an error, since it was saved and retrying the whole call would duplicate it.

## Setup

Requires macOS 14+, Node 18+, and Xcode command line tools (`swiftc`).

```sh
npm install
npm run build
claude mcp add --scope user reminders -- node "$PWD/dist/index.js"
```

On first use macOS asks the host app (Terminal, Claude, …) for access to **Reminders** (EventKit) and to **automate Reminders** (flags). If you denied it, re-enable it under System Settings → Privacy & Security → Reminders / Automation.

For Claude Desktop, add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reminders": { "command": "node", "args": ["/absolute/path/to/reminders-mcp/dist/index.js"] }
  }
}
```

## License

MIT, see [LICENSE](LICENSE).
