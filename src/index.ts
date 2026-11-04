#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { flaggedIds, helper, isFlagged, setFlagged } from "./backend.js";

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

await server.connect(new StdioServerTransport());
