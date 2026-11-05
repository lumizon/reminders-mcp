import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

// Most operations go through the EventKit helper (fast, and can clear dates and
// tell all-day from timed due dates). EventKit has no public "flagged" API, so
// that one field goes through Reminders' scripting interface instead.

const HELPER = fileURLToPath(new URL("../bin/reminders-helper", import.meta.url));

function exec(file: string, args: string[]): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`${file} not found. Run \`npm run build\` first.`));
        return;
      }
      resolve({ stdout, stderr, failed: !!err });
    });
  });
}

export async function helper<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const { stdout, stderr } = await exec(HELPER, [JSON.stringify({ op, args })]);
  let res: { ok: boolean; result?: T; error?: string };
  try {
    res = JSON.parse(stdout);
  } catch {
    throw new Error(`reminders-helper failed: ${(stderr || stdout).trim().slice(0, 500)}`);
  }
  if (!res.ok) throw new Error(res.error);
  return res.result as T;
}

const APPLE_ID_PREFIX = "x-apple-reminder://";
const toAppleId = (id: string) => (id.startsWith(APPLE_ID_PREFIX) ? id : APPLE_ID_PREFIX + id);
const fromAppleId = (id: string) => id.replace(APPLE_ID_PREFIX, "");

export async function jxa<T>(script: string, arg: unknown, app = "Reminders"): Promise<T> {
  const { stdout, stderr, failed } = await exec("osascript", ["-l", "JavaScript", "-e", script, JSON.stringify(arg)]);
  if (failed) {
    if (/-1743|not allowed|Not authorized/i.test(stderr)) {
      throw new Error(
        `Not authorized to automate ${app}. Grant access in System Settings → Privacy & Security → Automation.`,
      );
    }
    throw new Error(stderr.replace(/^.*?execution error: (Error: )*/s, "").replace(/ \(-?\d+\)\s*$/, "").trim());
  }
  return JSON.parse(stdout) as T;
}

// A reminder created through EventKit can take a few seconds to show up in
// Reminders' scripting interface, which fails with "Can't get object" until it
// does. Polling fast doesn't help (it seems to keep it from catching up), so
// back off instead.
const NOT_YET_VISIBLE = /Can.t get object/i;
const BACKOFF_MS = [500, 1000, 2000, 4000];

async function whenVisible<T>(fn: () => Promise<T>): Promise<T> {
  for (const wait of BACKOFF_MS) {
    try {
      return await fn();
    } catch (e) {
      if (!NOT_YET_VISIBLE.test((e as Error).message)) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return fn();
}

export async function flaggedIds(): Promise<Set<string>> {
  const ids = await jxa<string[]>(
    `function run() { return JSON.stringify(Application("Reminders").reminders.whose({ flagged: true }).id()); }`,
    null,
  );
  return new Set(ids.map(fromAppleId));
}

export async function setFlagged(id: string, flagged: boolean): Promise<void> {
  await whenVisible(() =>
    jxa(
      `function run(argv) {
        const a = JSON.parse(argv[0]);
        Application("Reminders").reminders.byId(a.id).flagged = a.flagged;
        return "true";
      }`,
      { id: toAppleId(id), flagged },
    ),
  );
}

export async function isFlagged(id: string): Promise<boolean> {
  return whenVisible(() =>
    jxa<boolean>(
      `function run(argv) { return JSON.stringify(Application("Reminders").reminders.byId(JSON.parse(argv[0])).flagged()); }`,
      toAppleId(id),
    ),
  );
}
