import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jxa } from "./backend.js";

// Notes has no EventKit equivalent: everything goes through its scripting
// interface, which reads and writes a note's body as HTML. That HTML is lossy:
// link targets read back as plain underlined text, and checklists, highlights
// and drawings aren't in it at all. So notes are created from Markdown and only
// ever appended to, never rewritten, and only when nobody has edited them in
// Notes since this server last wrote them (see `appendNote`).

const notes = <T>(script: string, arg: unknown = null) => jxa<T>(script, arg, "Notes");

// --- Markdown → Notes HTML ----------------------------------------------------

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s: string): string {
  const code: string[] = [];
  return escape(s)
    .replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`) // keep code spans from further formatting
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])[*_](?!\s)(.+?)(?<!\s)[*_](?![*\w])/g, "$1<i>$2</i>")
    .replace(/~~(.+?)~~/g, "<strike>$1</strike>")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `<tt>${code[+i]}</tt>`);
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

/** One Markdown line becomes one Notes line; a blank line stays a blank line. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      for (i++; i < lines.length && !lines[i].trim().startsWith("```"); i++) {
        const code = escape(lines[i]).replace(/^ +/, (sp) => "&nbsp;".repeat(sp.length)); // HTML would collapse the indent
        out.push(`<div><tt>${code || "<br>"}</tt></div>`);
      }
      i++;
    } else if (LIST_ITEM.test(line)) {
      // Nesting by indentation (2+ spaces per level); a bullet list and a
      // numbered list next to each other must stay separate lists.
      const stack: { tag: string; indent: number }[] = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) {
        const [, ws, marker, text] = lines[i].match(LIST_ITEM)!;
        const indent = ws.replace(/\t/g, "    ").length;
        const tag = /\d/.test(marker) ? "ol" : "ul";
        while (stack.length && (indent < stack.at(-1)!.indent || (indent === stack.at(-1)!.indent && tag !== stack.at(-1)!.tag))) {
          out.push(`</${stack.pop()!.tag}>`);
        }
        if (!stack.length || indent > stack.at(-1)!.indent) {
          out.push(`<${tag}>`);
          stack.push({ tag, indent });
        }
        const item = text.replace(/^\[([ xX])\]\s+/, (_, done) => (done === " " ? "☐ " : "☑ "));
        out.push(`<li>${inline(item)}</li>`);
      }
      while (stack.length) out.push(`</${stack.pop()!.tag}>`);
    } else if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      for (; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // the |---| separator
        rows.push(`<tr>${cells.map((c) => `<td>${inline(c) || "<br>"}</td>`).join("")}</tr>`);
      }
      out.push(`<div><table>${rows.join("")}</table></div>`);
    } else {
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) out.push(`<h${Math.min(heading[1].length, 3)}>${inline(heading[2])}</h${Math.min(heading[1].length, 3)}>`);
      else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) out.push("<div><br></div>"); // no rules in Notes
      else if (line.trim() === "") out.push("<div><br></div>");
      else out.push(`<div>${inline(line.replace(/^>\s?/, ""))}</div>`);
      i++;
    }
  }
  return out.join("");
}

// --- Notes HTML → Markdown ----------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : (ENTITIES[e] ?? m),
  );

/**
 * Notes writes headings as bold text in a larger font, lists as <ul>/<ol>
 * (nested lists as siblings of their parent item), tables inside <object>, and
 * everything else as one <div> per line. Link targets aren't in it.
 */
export function htmlToMarkdown(html: string): string {
  const lines: string[] = [];
  let line = "";
  let heading = 0;
  const lists: { tag: string; n: number }[] = [];
  const fonts: boolean[] = []; // per open <font>: whether it opened a code span
  let table: string[][] | null = null;

  const flush = () => {
    let text = line.replace(/\s+$/, "");
    if (heading && text.trim()) {
      text = `${"#".repeat(heading)} ${text.replace(/\*\*/g, "").trim()}`;
    }
    if (table) {
      if (text.trim()) table.at(-1)?.push(text.trim());
    } else if (text.trim() || line.includes("\n")) {
      lines.push(text);
    }
    line = "";
    heading = 0;
  };

  for (const [, close, tag, attrs, text] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (text !== undefined) {
      const t = decode(text).replace(/\n/g, "");
      if (t) line += t;
      continue;
    }
    const name = tag.toLowerCase();
    const end = close === "/";
    switch (name) {
      case "div":
      case "p":
      case "h1":
      case "h2":
      case "h3":
        if (end) flush();
        else if (line.trim()) flush();
        if (!end && name[0] === "h") heading = +name[1];
        break;
      case "br":
        if (!line.trim() && !table && !lists.length) lines.push("");
        break;
      case "b":
      case "strong":
        line += "**";
        break;
      case "i":
      case "em":
        line += "*";
        break;
      case "strike":
      case "s":
        line += "~~";
        break;
      case "tt":
      case "code":
        if (!fonts.at(-1)) line += "`";
        break;
      case "font": {
        // Notes writes code as Courier text, sometimes with a <tt> inside too.
        if (end) {
          if (fonts.pop()) line += "`";
        } else {
          const mono = /face="?(Courier|Menlo|Monaco)/i.test(attrs);
          fonts.push(mono);
          if (mono) line += "`";
        }
        break;
      }
      case "span": {
        const size = attrs.match(/font-size:\s*(\d+)px/);
        if (!end && size && +size[1] >= 16) heading = +size[1] >= 24 ? 1 : +size[1] >= 18 ? 2 : 3;
        break;
      }
      case "ul":
      case "ol":
        if (line.trim()) flush();
        if (end) lists.pop();
        else lists.push({ tag: name, n: 0 });
        break;
      case "li":
        if (end) flush();
        else {
          const list = lists.at(-1);
          const depth = Math.max(0, lists.length - 1);
          line = "  ".repeat(depth) + (list?.tag === "ol" ? `${++list.n}. ` : "- ");
        }
        break;
      case "table":
        if (end && table) {
          const width = Math.max(...table.map((r) => r.length));
          const row = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? "").join(" | ")} |`;
          lines.push(row(table[0]), `|${" --- |".repeat(width)}`, ...table.slice(1).map(row));
          table = null;
        } else if (!end) table = [];
        break;
      case "tr":
        if (!end) table?.push([]);
        break;
      case "td":
      case "th":
        if (end) flush();
        break;
      case "img":
        line += "[image]";
        break;
    }
  }
  flush();
  // Collapse the empty ** / ` pairs left by empty formatting runs, and runs of blank lines.
  return lines
    .map((l) => l.replace(/\*\*\*\*|``/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Local dates --------------------------------------------------------------

function localIso(utc: string | null): string | null {
  if (!utc) return null;
  const d = new Date(utc);
  const off = -d.getTimezoneOffset();
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60_000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

// --- Write guard --------------------------------------------------------------

// When this server last wrote each note: { [id]: modificationDate }. Appending
// rewrites the whole body, so it's only safe if the note is still exactly as we
// left it.
const STATE = join(homedir(), "Library", "Application Support", "reminders-mcp", "notes-written.json");

async function written(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(STATE, "utf8"));
  } catch {
    return {};
  }
}

async function remember(id: string, modified: string): Promise<void> {
  const state = await written();
  state[id] = modified;
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 1));
}

// --- Operations ---------------------------------------------------------------

const FIND_FOLDER = `
  function findFolder(N, name) {
    const want = name.toLowerCase();
    for (const acc of N.accounts()) {
      const names = acc.folders.name();
      const k = names.findIndex((n) => n.toLowerCase() === want);
      if (k >= 0) return acc.folders[k];
    }
    throw new Error("Folder not found: " + name + ". Create it with create_note_folder.");
  }`;

const READ_NOTE = `
  function readNote(n, withBody) {
    const locked = n.passwordProtected();
    const o = { id: n.id(), title: n.name(), folder: n.container().name(), locked,
                created: n.creationDate().toISOString(), modified: n.modificationDate().toISOString() };
    if (withBody && !locked) o.body = n.body();
    return o;
  }`;

type RawNote = { id: string; title: string; folder: string; locked?: boolean; created?: string; modified: string; body?: string };

function present(n: RawNote) {
  const { body, ...rest } = n;
  return {
    ...rest,
    created: localIso(n.created ?? null) ?? undefined,
    modified: localIso(n.modified),
    ...(body !== undefined && { markdown: htmlToMarkdown(body) }),
    ...(n.locked && { warning: "Locked note: its content can't be read." }),
  };
}

export async function listFolders() {
  return notes(`function run() {
    const N = Application("Notes");
    const out = [];
    for (const acc of N.accounts()) {
      const fs = acc.folders, names = fs.name(), ids = fs.id();
      names.forEach((name, k) => out.push({ id: ids[k], name, account: acc.name(), notes: fs[k].notes.length }));
    }
    return JSON.stringify(out);
  }`);
}

export async function createFolder(name: string) {
  return notes(
    `function run(argv) {
      const a = JSON.parse(argv[0]);
      const N = Application("Notes");
      for (const acc of N.accounts()) {
        if (acc.folders.name().some((n) => n.toLowerCase() === a.name.toLowerCase())) throw new Error("A folder named " + a.name + " already exists");
      }
      const f = N.make({ new: "folder", at: N.defaultAccount(), withProperties: { name: a.name } });
      return JSON.stringify({ id: f.id(), name: f.name(), account: N.defaultAccount().name() });
    }`,
    { name },
  );
}

export async function listNotes(a: { folder?: string; search?: string; in_body?: boolean; limit: number }) {
  const rows = await notes<RawNote[]>(
    `${FIND_FOLDER}
    function run(argv) {
      const a = JSON.parse(argv[0]);
      const N = Application("Notes");
      // Notes exposes its trash as an ordinary folder; skip it unless asked for by name.
      const trash = ["Recently Deleted", "Suppressions récentes"];
      const folders = a.folder
        ? [findFolder(N, a.folder)]
        : N.accounts().flatMap((acc) => acc.folders()).filter((f) => !trash.includes(f.name()));
      const rows = [];
      for (const f of folders) {
        let ns = f.notes;
        if (a.search) {
          const q = { _contains: a.search };
          ns = ns.whose(a.in_body ? { _or: [{ name: q }, { plaintext: q }] } : { name: q });
        }
        const ids = ns.id(), titles = ns.name(), mods = ns.modificationDate(), folder = f.name();
        ids.forEach((id, k) => rows.push({ id, title: titles[k], folder, modified: mods[k] }));
      }
      return JSON.stringify(rows);
    }`,
    a,
  );
  rows.sort((x, y) => y.modified.localeCompare(x.modified));
  return { total: rows.length, returned: Math.min(a.limit, rows.length), notes: rows.slice(0, a.limit).map(present) };
}

export async function getNote(id: string) {
  return present(
    await notes<RawNote>(
      `${READ_NOTE}
      function run(argv) { return JSON.stringify(readNote(Application("Notes").notes.byId(JSON.parse(argv[0])), true)); }`,
      id,
    ),
  );
}

export async function createNote(a: { folder: string; title: string; markdown?: string }) {
  const html = `<h1>${inline(a.title)}</h1>${a.markdown ? markdownToHtml(a.markdown) : ""}`;
  const n = await notes<RawNote>(
    `${FIND_FOLDER}${READ_NOTE}
    function run(argv) {
      const a = JSON.parse(argv[0]);
      const N = Application("Notes");
      const n = N.make({ new: "note", at: findFolder(N, a.folder), withProperties: { body: a.html } });
      return JSON.stringify(readNote(n, false));
    }`,
    { folder: a.folder, html },
  );
  await remember(n.id, n.modified);
  return present(n);
}

export async function appendNote(id: string, markdown: string) {
  const state = await written();
  const n = await notes<RawNote & { body: string }>(
    `${READ_NOTE}
    function run(argv) {
      const a = JSON.parse(argv[0]);
      const n = Application("Notes").notes.byId(a.id);
      const before = readNote(n, true);
      if (before.locked) throw new Error("Locked note: it can't be changed.");
      if (a.expected !== before.modified) return JSON.stringify(before);
      n.body = before.body + a.html;
      return JSON.stringify(readNote(n, false));
    }`,
    { id, expected: state[id] ?? null, html: `<div><br></div>${markdownToHtml(markdown)}` },
  );
  if (n.body !== undefined) {
    throw new Error(
      state[id]
        ? `"${n.title}" was edited in Notes since this server last wrote it, so appending (which rewrites the note) could lose formatting the scripting interface can't see, like checklists. Create a new note instead, or ask the user to add it.`
        : `"${n.title}" wasn't created by this server, so appending (which rewrites the note) could lose formatting the scripting interface can't see, like checklists. Create a new note instead, or ask the user to add it.`,
    );
  }
  await remember(n.id, n.modified);
  return present(n);
}
