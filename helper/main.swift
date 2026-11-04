// reminders-helper: a one-shot EventKit bridge for the MCP server.
// Usage: reminders-helper '<json {"op": String, "args": Object}>'
// Prints {"ok": true, "result": ...} or {"ok": false, "error": String} to stdout.
// In args, an absent key means "leave unchanged" and JSON null means "clear".

import EventKit
import Foundation

struct HelperError: Error { let message: String }

let store = EKEventStore()

func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message])
    exit(1)
}

func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

// MARK: - Access

func requestAccess() throws {
    switch EKEventStore.authorizationStatus(for: .reminder) {
    case .fullAccess:
        return
    case .notDetermined:
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        store.requestFullAccessToReminders { ok, _ in granted = ok; sem.signal() }
        sem.wait()
        if granted { return }
    default:
        break
    }
    throw HelperError(message: "Not authorized to access Reminders. Grant access in System Settings → Privacy & Security → Reminders for the app running this server.")
}

// MARK: - Dates

let localTZ = TimeZone.current

func isoString(_ date: Date?) -> Any {
    guard let date else { return NSNull() }
    let f = ISO8601DateFormatter()
    f.timeZone = localTZ
    f.formatOptions = [.withInternetDateTime]
    return f.string(from: date)
}

/// "YYYY-MM-DD" → all-day components; otherwise an ISO datetime (offset optional, local if absent).
func parseDateComponents(_ s: String) throws -> DateComponents {
    let cal = Calendar(identifier: .gregorian)
    if let m = s.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/) {
        var c = DateComponents(year: Int(m.1), month: Int(m.2), day: Int(m.3))
        c.calendar = cal
        return c
    }
    let date = try parseDate(s)
    var c = cal.dateComponents(in: localTZ, from: date)
    c.nanosecond = nil
    c.weekday = nil; c.weekdayOrdinal = nil; c.weekOfMonth = nil; c.weekOfYear = nil
    c.yearForWeekOfYear = nil; c.quarter = nil; c.era = nil
    return c
}

func parseDate(_ s: String) throws -> Date {
    if let m = s.wholeMatch(of: /(\d{4})-(\d{2})-(\d{2})/) {
        let c = DateComponents(year: Int(m.1), month: Int(m.2), day: Int(m.3))
        if let d = Calendar.current.date(from: c) { return d }
    }
    let withOffset = ISO8601DateFormatter()
    withOffset.formatOptions = [.withInternetDateTime]
    if let d = withOffset.date(from: s) { return d }
    withOffset.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = withOffset.date(from: s) { return d }
    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.timeZone = localTZ
    for fmt in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm"] {
        local.dateFormat = fmt
        if let d = local.date(from: s) { return d }
    }
    throw HelperError(message: "Invalid date: \(s). Use YYYY-MM-DD or an ISO 8601 datetime like 2026-11-05T15:00.")
}

func dueInfo(_ r: EKReminder) -> (value: Any, allDay: Bool, sortKey: Date?) {
    guard let c = r.dueDateComponents else { return (NSNull(), false, nil) }
    let cal = c.calendar ?? Calendar.current
    if c.hour == nil {
        let s = String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
        return (s, true, cal.date(from: c))
    }
    let d = cal.date(from: c)
    return (isoString(d), false, d)
}

// MARK: - Lookup

func reminderCalendars() -> [EKCalendar] { store.calendars(for: .reminder) }

func findList(_ name: String) throws -> EKCalendar {
    if let c = reminderCalendars().first(where: { $0.title == name }) { return c }
    if let c = reminderCalendars().first(where: { $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame }) { return c }
    throw HelperError(message: "List not found: \(name)")
}

func normalizeId(_ id: String) -> String {
    id.hasPrefix("x-apple-reminder://") ? String(id.dropFirst("x-apple-reminder://".count)) : id
}

func findReminder(_ id: String) throws -> EKReminder {
    guard let r = store.calendarItem(withIdentifier: normalizeId(id)) as? EKReminder else {
        throw HelperError(message: "Reminder not found: \(id)")
    }
    return r
}

func fetch(_ predicate: NSPredicate) -> [EKReminder] {
    let sem = DispatchSemaphore(value: 0)
    var out: [EKReminder] = []
    store.fetchReminders(matching: predicate) { rs in out = rs ?? []; sem.signal() }
    sem.wait()
    return out
}

// MARK: - Serialization

func serialize(_ r: EKReminder, full: Bool) -> [String: Any] {
    let due = dueInfo(r)
    var o: [String: Any] = [
        "id": r.calendarItemIdentifier,
        "title": r.title ?? "",
        "notes": (r.notes?.isEmpty ?? true) ? NSNull() : r.notes!,
        "list": r.calendar?.title ?? NSNull(),
        "completed": r.isCompleted,
        "dueDate": due.value,
        "allDay": due.allDay,
        "priority": r.priority,
    ]
    if full {
        o["completionDate"] = isoString(r.completionDate)
        o["creationDate"] = isoString(r.creationDate)
        o["lastModified"] = isoString(r.lastModifiedDate)
        o["url"] = r.url?.absoluteString ?? NSNull()
        o["alarms"] = (r.alarms ?? []).compactMap { a -> Any? in
            if let d = a.absoluteDate { return isoString(d) }
            return ["relativeOffsetSeconds": a.relativeOffset]
        }
        o["recurring"] = r.hasRecurrenceRules
    }
    return o
}

// MARK: - Mutation

func applyFields(_ r: EKReminder, _ a: [String: Any]) throws {
    if let t = a["title"] as? String { r.title = t }
    if a.keys.contains("notes") { r.notes = a["notes"] as? String }
    if a.keys.contains("dueDate") {
        if let s = a["dueDate"] as? String { r.dueDateComponents = try parseDateComponents(s) }
        else { r.dueDateComponents = nil }
    }
    if a.keys.contains("remindMeDate") {
        for alarm in r.alarms ?? [] { r.removeAlarm(alarm) }
        if let s = a["remindMeDate"] as? String { r.addAlarm(EKAlarm(absoluteDate: try parseDate(s))) }
    }
    if let p = a["priority"] as? Int { r.priority = p }
    if a.keys.contains("url") {
        if let s = a["url"] as? String { r.url = URL(string: s) } else { r.url = nil }
    }
    if let c = a["completed"] as? Bool { r.isCompleted = c }
    if let l = a["list"] as? String { r.calendar = try findList(l) }
}

// MARK: - Ops

func listLists() throws -> Any {
    let cals = reminderCalendars()
    let incomplete = fetch(store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals))
    var counts: [String: Int] = [:]
    for r in incomplete { counts[r.calendar.calendarIdentifier, default: 0] += 1 }
    let defaultId = store.defaultCalendarForNewReminders()?.calendarIdentifier
    return cals.map { c -> [String: Any] in
        [
            "id": c.calendarIdentifier,
            "name": c.title,
            "account": c.source?.title ?? NSNull(),
            "incompleteCount": counts[c.calendarIdentifier] ?? 0,
            "isDefault": c.calendarIdentifier == defaultId,
        ]
    }
}

func listReminders(_ a: [String: Any]) throws -> Any {
    let cals = try (a["list"] as? String).map { [try findList($0)] } ?? reminderCalendars()
    let mode = a["completed"] as? String ?? "incomplete"
    let predicate: NSPredicate
    switch mode {
    case "completed": predicate = store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: cals)
    case "all": predicate = store.predicateForReminders(in: cals)
    default: predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: cals)
    }
    let query = (a["search"] as? String)?.lowercased()
    let before = try (a["dueBefore"] as? String).map(parseDate)
    let after = try (a["dueAfter"] as? String).map(parseDate)
    let ids = (a["onlyIds"] as? [String]).map { Set($0.map(normalizeId)) }
    let limit = a["limit"] as? Int ?? 100

    var rows: [(EKReminder, Date?)] = []
    for r in fetch(predicate) {
        if let ids, !ids.contains(r.calendarItemIdentifier) { continue }
        if let q = query, !(r.title ?? "").lowercased().contains(q), !(r.notes ?? "").lowercased().contains(q) { continue }
        let key = dueInfo(r).sortKey
        if let before { guard let key, key < before else { continue } }
        if let after { guard let key, key >= after else { continue } }
        rows.append((r, key))
    }
    rows.sort { x, y in
        switch (x.1, y.1) {
        case let (a?, b?): return a < b
        case (nil, _?): return false
        case (_?, nil): return true
        default: return (x.0.creationDate ?? .distantPast) < (y.0.creationDate ?? .distantPast)
        }
    }
    return [
        "total": rows.count,
        "returned": min(limit, rows.count),
        "reminders": rows.prefix(limit).map { serialize($0.0, full: false) },
    ]
}

func createReminder(_ a: [String: Any]) throws -> Any {
    guard let title = a["title"] as? String, !title.isEmpty else { throw HelperError(message: "title is required") }
    let r = EKReminder(eventStore: store)
    r.title = title
    if a["list"] == nil {
        guard let def = store.defaultCalendarForNewReminders() else { throw HelperError(message: "No default list; pass list") }
        r.calendar = def
    }
    try applyFields(r, a)
    try store.save(r, commit: true)
    return serialize(r, full: true)
}

func updateReminder(_ a: [String: Any]) throws -> Any {
    guard let id = a["id"] as? String else { throw HelperError(message: "id is required") }
    let r = try findReminder(id)
    try applyFields(r, a)
    try store.save(r, commit: true)
    return serialize(r, full: true)
}

func deleteReminder(_ a: [String: Any]) throws -> Any {
    guard let id = a["id"] as? String else { throw HelperError(message: "id is required") }
    let r = try findReminder(id)
    let title = r.title ?? ""
    try store.remove(r, commit: true)
    return ["deleted": true, "id": r.calendarItemIdentifier, "title": title]
}

func createList(_ a: [String: Any]) throws -> Any {
    guard let name = a["name"] as? String, !name.isEmpty else { throw HelperError(message: "name is required") }
    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = name
    guard let source = store.defaultCalendarForNewReminders()?.source
        ?? store.sources.first(where: { $0.sourceType == .calDAV || $0.sourceType == .local }) else {
        throw HelperError(message: "No account available to create the list in")
    }
    cal.source = source
    try store.saveCalendar(cal, commit: true)
    return ["id": cal.calendarIdentifier, "name": cal.title, "account": source.title]
}

func deleteList(_ a: [String: Any]) throws -> Any {
    guard let name = a["name"] as? String else { throw HelperError(message: "name is required") }
    let cal = try findList(name)
    try store.removeCalendar(cal, commit: true)
    return ["deleted": true, "name": cal.title]
}

// MARK: - Main

guard CommandLine.arguments.count >= 2,
      let data = CommandLine.arguments[1].data(using: .utf8),
      let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let op = req["op"] as? String else {
    fail("Usage: reminders-helper '{\"op\": ..., \"args\": {...}}'")
}
let args = req["args"] as? [String: Any] ?? [:]

do {
    try requestAccess()
    let result: Any
    switch op {
    case "listLists": result = try listLists()
    case "listReminders": result = try listReminders(args)
    case "getReminder": result = serialize(try findReminder(args["id"] as? String ?? ""), full: true)
    case "createReminder": result = try createReminder(args)
    case "updateReminder": result = try updateReminder(args)
    case "deleteReminder": result = try deleteReminder(args)
    case "createList": result = try createList(args)
    case "deleteList": result = try deleteList(args)
    default: throw HelperError(message: "Unknown op: \(op)")
    }
    emit(["ok": true, "result": result])
} catch let e as HelperError {
    fail(e.message)
} catch {
    fail(error.localizedDescription)
}
