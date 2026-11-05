# reminders-mcp

An MCP server for controlling macOS Reminders and Calendar.

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
| `list_calendars` / `create_calendar` | All calendars (account, writability, default); create one with an optional colour. macOS may make a new calendar the default; change it back in Calendar → Settings → General |
| `list_events` | Events in a date range (default: the next 7 days), filter by calendar or text |
| `get_event` | Full details (notes, URL, alerts, attendees) |
| `create_event` | Title, start/end, calendar, location, notes, URL, alerts (minutes before) |
| `update_event` | Change any field; moving the start keeps the length; `null` clears location/notes/URL |
| `delete_event` | Delete an event |

Dates: `"YYYY-MM-DD"` for all-day, or ISO 8601 like `"2026-11-05T15:00"` (local time unless an offset is given). An all-day event's `end` is its last day, inclusive.

Alerts are minutes before the start; an all-day event starts at midnight, so `-540` is 9:00 that day.

Occurrences of a recurring event share one id. To change or delete one, pass `occurrence` (its start, as `list_events` returned it) and `span`: `"this"` (default) or `"future"`.

## How it works

- `helper/main.swift` → `bin/reminders-helper`: a one-shot EventKit CLI that does nearly all the work, for both reminders and calendar events. EventKit is fast, can tell timed from all-day due dates, and can clear fields, which Reminders' AppleScript interface cannot.
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

On first use macOS asks the host app (Terminal, Claude, …) for access to **Reminders** and **Calendars** (EventKit) and to **automate Reminders** (flags). If you denied it, re-enable it under System Settings → Privacy & Security → Reminders / Calendars / Automation.

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
