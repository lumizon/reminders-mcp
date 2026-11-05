#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { flaggedIds, helper, isFlagged, setFlagged } from "./backend.js";
import { appendNote, createFolder, createNote, getNote, listFolders, listNotes } from "./notes.js";

type Reminder = { id: string; flagged?: boolean | null; warning?: string; [k: string]: unknown };
type ReminderPage = { total: number; returned: number; reminders: Reminder[] };

const server = new McpServer({ name: "reminders", version: "0.1.0" });

const dateDescription =
  'Date as "YYYY-MM-DD" (all-day) or ISO 8601 datetime like "2026-11-05T15:00" (local time unless an offset is given).';

const priority = z
  .union([z.literal(0), z.literal(1), z.literal(5), z.literal(9)])
  .describe("0 = none, 1 = high, 5 = medium, 9 = low");

async function respond(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
  }
}

// Builds helper args, omitting undefined values so the helper can tell
// "leave unchanged" (absent) from "clear" (null).
function defined(obj: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// Adds the flag, which only Reminders' scripting interface knows about. The
// reminder itself is already saved by now, so a flag failure becomes a warning
// rather than an error: reporting the call as failed would make clients retry
// and create duplicates. `known` skips the lookup when the caller already knows
// the answer (a new reminder is never flagged unless asked).
async function withFlag(
  r: Reminder,
  { set, known }: { set?: boolean; known?: boolean } = {},
): Promise<Reminder> {
  try {
    if (set !== undefined) {
      await setFlagged(r.id, set);
      return { ...r, flagged: set };
    }
    return { ...r, flagged: known ?? (await isFlagged(r.id)) };
  } catch (e) {
    const action = set === undefined ? "read" : "set";
    return {
      ...r,
      flagged: null,
      warning: `Saved, but the flag could not be ${action}: ${(e as Error).message} Do not retry the whole call; use update_reminder for the flag only.`,
    };
  }
}

server.registerTool(
  "list_lists",
  {
    title: "List reminder lists",
    description: "List all Reminders lists with their incomplete reminder counts.",
    annotations: { readOnlyHint: true },
  },
  () => respond(() => helper("listLists")),
);

server.registerTool(
  "list_reminders",
  {
    title: "List reminders",
    description:
      "List reminders, optionally filtered by list, completion state, text, due date range, or flag. Results are sorted by due date (undated last).",
    inputSchema: {
      list: z.string().optional().describe("List name. Omit to search all lists."),
      completed: z
        .enum(["incomplete", "completed", "all"])
        .default("incomplete")
        .describe("Which reminders to include"),
      search: z.string().optional().describe("Case-insensitive text match on title or notes"),
      due_before: z.string().optional().describe(`Only reminders due before this. ${dateDescription}`),
      due_after: z.string().optional().describe(`Only reminders due at or after this. ${dateDescription}`),
      flagged: z.boolean().optional().describe("Only flagged reminders"),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    annotations: { readOnlyHint: true },
  },
  (a) =>
    respond(async () => {
      const args = defined({
        list: a.list,
        completed: a.completed,
        search: a.search,
        dueBefore: a.due_before,
        dueAfter: a.due_after,
        limit: a.limit,
      });
      let page: ReminderPage, flags: Set<string>;
      if (a.flagged) {
        flags = await flaggedIds();
        page = await helper<ReminderPage>("listReminders", { ...args, onlyIds: [...flags] });
      } else {
        [page, flags] = await Promise.all([helper<ReminderPage>("listReminders", args), flaggedIds()]);
      }
      page.reminders = page.reminders.map((r) => ({ ...r, flagged: flags.has(r.id) }));
      return page;
    }),
);

server.registerTool(
  "get_reminder",
  {
    title: "Get reminder",
    description: "Get full details of a single reminder by id, including alarms, dates and URL.",
    inputSchema: { id: z.string().describe("Reminder id") },
    annotations: { readOnlyHint: true },
  },
  (a) => respond(async () => withFlag(await helper<Reminder>("getReminder", { id: a.id }))),
);

server.registerTool(
  "create_reminder",
  {
    title: "Create reminder",
    description: "Create a new reminder.",
    inputSchema: {
      title: z.string().min(1),
      list: z.string().optional().describe("List name. Defaults to the default list."),
      notes: z.string().optional(),
      due_date: z.string().optional().describe(dateDescription),
      remind_me_date: z.string().optional().describe(`When to show an alert. ${dateDescription}`),
      priority: priority.optional(),
      flagged: z.boolean().optional(),
      url: z.string().url().optional(),
    },
  },
  (a) =>
    respond(async () => {
      const r = await helper<Reminder>(
        "createReminder",
        defined({
          title: a.title,
          list: a.list,
          notes: a.notes,
          dueDate: a.due_date,
          remindMeDate: a.remind_me_date,
          priority: a.priority,
          url: a.url,
        }),
      );
      return withFlag(r, a.flagged === undefined ? { known: false } : { set: a.flagged });
    }),
);

server.registerTool(
  "update_reminder",
  {
    title: "Update reminder",
    description:
      "Update fields of an existing reminder. Only provided fields change; pass null for notes, due_date, remind_me_date or url to clear them. Set completed to mark done/undone, or list to move it.",
    inputSchema: {
      id: z.string(),
      title: z.string().min(1).optional(),
      notes: z.string().nullable().optional(),
      due_date: z.string().nullable().optional().describe(dateDescription),
      remind_me_date: z.string().nullable().optional().describe(`Replaces existing alerts. ${dateDescription}`),
      priority: priority.optional(),
      flagged: z.boolean().optional(),
      completed: z.boolean().optional(),
      list: z.string().optional().describe("Move the reminder to this list"),
      url: z.string().url().nullable().optional(),
    },
  },
  (a) =>
    respond(async () => {
      const r = await helper<Reminder>(
        "updateReminder",
        defined({
          id: a.id,
          title: a.title,
          notes: a.notes,
          dueDate: a.due_date,
          remindMeDate: a.remind_me_date,
          priority: a.priority,
          completed: a.completed,
          list: a.list,
          url: a.url,
        }),
      );
      return withFlag(r, { set: a.flagged });
    }),
);

server.registerTool(
  "complete_reminder",
  {
    title: "Complete reminder",
    description: "Mark a reminder as completed (or incomplete with completed=false).",
    inputSchema: { id: z.string(), completed: z.boolean().default(true) },
  },
  (a) => respond(async () => withFlag(await helper<Reminder>("updateReminder", { id: a.id, completed: a.completed }))),
);

server.registerTool(
  "delete_reminder",
  {
    title: "Delete reminder",
    description: "Permanently delete a reminder.",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
  (a) => respond(() => helper("deleteReminder", { id: a.id })),
);

server.registerTool(
  "create_list",
  {
    title: "Create list",
    description: "Create a new Reminders list in the default account.",
    inputSchema: { name: z.string().min(1) },
  },
  (a) => respond(() => helper("createList", { name: a.name })),
);

server.registerTool(
  "delete_list",
  {
    title: "Delete list",
    description: "Permanently delete a Reminders list and all reminders in it.",
    inputSchema: { name: z.string().min(1) },
    annotations: { destructiveHint: true },
  },
  (a) => respond(() => helper("deleteList", { name: a.name })),
);

// --- Calendar ---------------------------------------------------------------

type Event = Record<string, unknown>;

const eventDate =
  'Date as "YYYY-MM-DD" for an all-day event, or ISO 8601 datetime like "2026-11-10T15:00" (local time unless an offset is given).';
const occurrence = z
  .string()
  .optional()
  .describe(
    "For a recurring event: the start of the occurrence meant, as list_events returned it (or its YYYY-MM-DD day). Omit for the first occurrence.",
  );
const alerts = z
  .array(z.number().int())
  .describe(
    "Alerts, in minutes before the start (0 = at start). All-day events start at midnight, so negative values fall on the day: -540 = 9:00 that day, 900 = 9:00 the day before.",
  );
const span = z
  .enum(["this", "future"])
  .default("this")
  .describe("For a recurring event: change only this occurrence, or this and all future ones");

server.registerTool(
  "list_calendars",
  {
    title: "List calendars",
    description: "List all calendars, with their account, whether they can be written to, and which is the default.",
    annotations: { readOnlyHint: true },
  },
  () => respond(() => helper("listCalendars")),
);

server.registerTool(
  "create_calendar",
  {
    title: "Create calendar",
    description: "Create a calendar in the default calendar's account (usually iCloud).",
    inputSchema: {
      name: z.string().min(1),
      color: z.string().optional().describe('Hex color like "#E8A33D"'),
    },
  },
  (a) => respond(() => helper("createCalendar", defined(a))),
);

server.registerTool(
  "list_events",
  {
    title: "List events",
    description:
      "List calendar events in a date range (default: today and the next 7 days), sorted by start. Recurring events appear once per occurrence, sharing an id.",
    inputSchema: {
      from: z.string().optional().describe(`Range start (default: start of today). ${dateDescription}`),
      to: z.string().optional().describe(`Range end; a plain date includes that whole day (default: from + 7 days). ${dateDescription}`),
      calendar: z.string().optional().describe("Calendar name. Omit for all calendars."),
      search: z.string().optional().describe("Case-insensitive text match on title, location or notes"),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    annotations: { readOnlyHint: true },
  },
  (a) => respond(() => helper("listEvents", defined(a))),
);

server.registerTool(
  "get_event",
  {
    title: "Get event",
    description: "Get full details of an event: notes, URL, alerts, attendees.",
    inputSchema: { id: z.string().describe("Event id"), occurrence },
    annotations: { readOnlyHint: true },
  },
  (a) => respond(() => helper<Event>("getEvent", defined(a))),
);

server.registerTool(
  "create_event",
  {
    title: "Create event",
    description:
      'Create a calendar event. A "YYYY-MM-DD" start makes an all-day event; a datetime start without end lasts one hour.',
    inputSchema: {
      title: z.string().min(1),
      start: z.string().describe(eventDate),
      end: z
        .string()
        .optional()
        .describe("Same form as start. For all-day events, the last day (inclusive); omit for a single day."),
      calendar: z.string().optional().describe("Calendar name. Defaults to the default calendar."),
      location: z.string().optional(),
      notes: z.string().optional(),
      url: z.string().url().optional(),
      alert_minutes_before: alerts.optional(),
    },
  },
  (a) =>
    respond(() =>
      helper<Event>(
        "createEvent",
        defined({
          title: a.title,
          start: a.start,
          end: a.end,
          calendar: a.calendar,
          location: a.location,
          notes: a.notes,
          url: a.url,
          alertMinutesBefore: a.alert_minutes_before,
        }),
      ),
    ),
);

server.registerTool(
  "update_event",
  {
    title: "Update event",
    description:
      "Update an event. Only provided fields change; pass null for location, notes or url to clear them. Changing start alone keeps the event's length.",
    inputSchema: {
      id: z.string(),
      occurrence,
      span,
      title: z.string().min(1).optional(),
      start: z.string().optional().describe(eventDate),
      end: z.string().optional().describe("Same form as start. For all-day events, the last day (inclusive)."),
      calendar: z.string().optional().describe("Move the event to this calendar"),
      location: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      url: z.string().url().nullable().optional(),
      alert_minutes_before: alerts.optional().describe(`${alerts.description} Replaces existing alerts; [] removes them.`),
    },
  },
  (a) =>
    respond(() =>
      helper<Event>(
        "updateEvent",
        defined({
          id: a.id,
          occurrence: a.occurrence,
          span: a.span,
          title: a.title,
          start: a.start,
          end: a.end,
          calendar: a.calendar,
          location: a.location,
          notes: a.notes,
          url: a.url,
          alertMinutesBefore: a.alert_minutes_before,
        }),
      ),
    ),
);

server.registerTool(
  "delete_event",
  {
    title: "Delete event",
    description: "Delete an event (for a recurring one, this occurrence or this and all future ones).",
    inputSchema: { id: z.string(), occurrence, span },
    annotations: { destructiveHint: true },
  },
  (a) => respond(() => helper("deleteEvent", defined(a))),
);

// --- Notes ------------------------------------------------------------------

server.registerTool(
  "list_note_folders",
  {
    title: "List note folders",
    description: "List Notes folders with their account and note count.",
    annotations: { readOnlyHint: true },
  },
  () => respond(listFolders),
);

server.registerTool(
  "create_note_folder",
  {
    title: "Create note folder",
    description: "Create a Notes folder in the default account (usually iCloud).",
    inputSchema: { name: z.string().min(1) },
  },
  (a) => respond(() => createFolder(a.name)),
);

server.registerTool(
  "list_notes",
  {
    title: "List notes",
    description:
      "List notes (id, title, folder, last modified), newest first, without their content. search matches titles; with in_body it also matches note text, which is slower: narrow it with folder.",
    inputSchema: {
      folder: z.string().optional().describe("Folder name. Omit for all folders."),
      search: z.string().optional().describe("Case-insensitive text to look for"),
      in_body: z.boolean().default(false).describe("Also search note text, not just titles"),
      limit: z.number().int().min(1).max(500).default(50),
    },
    annotations: { readOnlyHint: true },
  },
  (a) => respond(() => listNotes(a)),
);

server.registerTool(
  "get_note",
  {
    title: "Get note",
    description:
      "Read a note as Markdown. Link targets are not available through Notes' scripting interface: links come back as their text only.",
    inputSchema: { id: z.string().describe("Note id, as list_notes returned it") },
    annotations: { readOnlyHint: true },
  },
  (a) => respond(() => getNote(a.id)),
);

server.registerTool(
  "create_note",
  {
    title: "Create note",
    description:
      "Create a note from Markdown: headings (#, ##, ###), bullet and numbered lists (nested by indentation), **bold**, *italic*, `code`, code blocks, [links](url) and tables. Checkboxes become ☐/☑ text, since Notes checklists can't be scripted.",
    inputSchema: {
      folder: z.string().min(1).describe("Folder name (must exist; see create_note_folder)"),
      title: z.string().min(1).describe("Becomes the note's first line, as its title"),
      markdown: z.string().optional().describe("The note's content, below the title"),
    },
  },
  (a) => respond(() => createNote(a)),
);

server.registerTool(
  "append_to_note",
  {
    title: "Append to note",
    description:
      "Add Markdown to the end of a note. Only works on notes this server created and that haven't been edited in Notes since, because appending rewrites the whole note and would drop what the scripting interface can't see (checklists, highlights, drawings). Otherwise create a new note.",
    inputSchema: { id: z.string(), markdown: z.string().min(1) },
  },
  (a) => respond(() => appendNote(a.id, a.markdown)),
);

await server.connect(new StdioServerTransport());
