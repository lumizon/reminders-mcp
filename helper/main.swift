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

func requestAccess(_ type: EKEntityType) throws {
    switch EKEventStore.authorizationStatus(for: type) {
    case .fullAccess:
        return
    case .notDetermined:
        let sem = DispatchSemaphore(value: 0)
        var granted = false
        let done: EKEventStoreRequestAccessCompletionHandler = { ok, _ in granted = ok; sem.signal() }
        if type == .event { store.requestFullAccessToEvents(completion: done) } else { store.requestFullAccessToReminders(completion: done) }
        sem.wait()
        if granted { return }
    default:
        break
    }
    let app = type == .event ? "Calendars" : "Reminders"
    throw HelperError(message: "Not authorized to access \(app). Grant full access in System Settings → Privacy & Security → \(app) for the app running this server.")
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

// MARK: - Calendar events

func eventCalendars() -> [EKCalendar] { store.calendars(for: .event) }

func findCalendar(_ name: String) throws -> EKCalendar {
    if let c = eventCalendars().first(where: { $0.title == name }) { return c }
    if let c = eventCalendars().first(where: { $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame }) { return c }
    throw HelperError(message: "Calendar not found: \(name)")
}

let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = localTZ
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

func isDayOnly(_ s: String) -> Bool { s.wholeMatch(of: /\d{4}-\d{2}-\d{2}/) != nil }

/// All-day events report dates as "YYYY-MM-DD", with `end` the last day (inclusive);
/// timed events as ISO datetimes.
func eventTime(_ e: EKEvent, _ d: Date) -> Any { e.isAllDay ? dayFormatter.string(from: d) : isoString(d) }

func serializeEvent(_ e: EKEvent, full: Bool) -> [String: Any] {
    var o: [String: Any] = [
        "id": e.eventIdentifier ?? NSNull(),
        "title": e.title ?? "",
        "calendar": e.calendar?.title ?? NSNull(),
        "start": eventTime(e, e.startDate),
        "end": eventTime(e, e.isAllDay ? e.endDate.addingTimeInterval(-1) : e.endDate),
        "allDay": e.isAllDay,
        "location": (e.location?.isEmpty ?? true) ? NSNull() : e.location!,
        "recurring": e.hasRecurrenceRules,
    ]
    if full {
        o["notes"] = (e.notes?.isEmpty ?? true) ? NSNull() : e.notes!
        o["url"] = e.url?.absoluteString ?? NSNull()
        o["alertMinutesBefore"] = (e.alarms ?? []).compactMap { a -> Int? in
            a.absoluteDate == nil ? Int(-a.relativeOffset / 60) : nil
        }
        o["attendees"] = (e.attendees ?? []).map { $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "") }
        o["creationDate"] = isoString(e.creationDate)
        o["lastModified"] = isoString(e.lastModifiedDate)
    }
    return o
}

/// A recurring event's occurrences share one id; `occurrence` (the start of the one
/// meant, as listed) picks it. Without it, EventKit returns the first occurrence.
func findEvent(_ a: [String: Any]) throws -> EKEvent {
    guard let id = a["id"] as? String, !id.isEmpty else { throw HelperError(message: "id is required") }
    guard let first = store.event(withIdentifier: id) else { throw HelperError(message: "Event not found: \(id)") }
    guard let occ = a["occurrence"] as? String else { return first }
    let at = try parseDate(occ)
    let dayStart = Calendar.current.startOfDay(for: at)
    let candidates = store.events(matching: store.predicateForEvents(
        withStart: dayStart, end: dayStart.addingTimeInterval(86_400), calendars: [first.calendar]))
    if let e = candidates.first(where: { $0.eventIdentifier == id && (isDayOnly(occ) || $0.startDate == at) }) { return e }
    throw HelperError(message: "No occurrence of \(id) at \(occ)")
}

func applyEventFields(_ e: EKEvent, _ a: [String: Any]) throws {
    if let t = a["title"] as? String { e.title = t }
    if let c = a["calendar"] as? String { e.calendar = try findCalendar(c) }
    if let s = a["start"] as? String {
        let duration = e.startDate.map { e.endDate.timeIntervalSince($0) }
        e.isAllDay = isDayOnly(s)
        e.startDate = try parseDate(s)
        // Moving an event keeps its length unless a new end is given.
        if a["end"] == nil { e.endDate = e.startDate.addingTimeInterval(e.isAllDay ? 0 : (duration ?? 3600)) }
    }
    if let s = a["end"] as? String {
        if e.isAllDay != isDayOnly(s) { throw HelperError(message: "start and end must both be dates (all-day) or both datetimes") }
        e.endDate = try parseDate(s)
        if e.endDate < e.startDate { throw HelperError(message: "end is before start") }
    }
    if a.keys.contains("location") { e.location = a["location"] as? String }
    if a.keys.contains("notes") { e.notes = a["notes"] as? String }
    if a.keys.contains("url") {
        if let s = a["url"] as? String { e.url = URL(string: s) } else { e.url = nil }
    }
    if a.keys.contains("alertMinutesBefore") {
        for alarm in e.alarms ?? [] { e.removeAlarm(alarm) }
        for m in a["alertMinutesBefore"] as? [Int] ?? [] { e.addAlarm(EKAlarm(relativeOffset: TimeInterval(-m * 60))) }
    }
}

func span(_ a: [String: Any]) -> EKSpan { (a["span"] as? String) == "future" ? .futureEvents : .thisEvent }

func listCalendars() throws -> Any {
    let defaultId = store.defaultCalendarForNewEvents?.calendarIdentifier
    return eventCalendars().map { c -> [String: Any] in
        [
            "id": c.calendarIdentifier,
            "name": c.title,
            "account": c.source?.title ?? NSNull(),
            "writable": c.allowsContentModifications,
            "isDefault": c.calendarIdentifier == defaultId,
        ]
    }
}

func createCalendar(_ a: [String: Any]) throws -> Any {
    guard let name = a["name"] as? String, !name.isEmpty else { throw HelperError(message: "name is required") }
    if eventCalendars().contains(where: { $0.title == name }) { throw HelperError(message: "A calendar named \(name) already exists") }
    let cal = EKCalendar(for: .event, eventStore: store)
    cal.title = name
    guard let source = store.defaultCalendarForNewEvents?.source
        ?? store.sources.first(where: { $0.sourceType == .calDAV || $0.sourceType == .local }) else {
        throw HelperError(message: "No account available to create the calendar in")
    }
    cal.source = source
    if let hex = a["color"] as? String {
        guard let v = UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16), hex.count >= 6 else {
            throw HelperError(message: "color must be a hex like #E8A33D")
        }
        cal.cgColor = CGColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
    try store.saveCalendar(cal, commit: true)
    return ["id": cal.calendarIdentifier, "name": cal.title, "account": source.title]
}

func listEvents(_ a: [String: Any]) throws -> Any {
    let cals = try (a["calendar"] as? String).map { [try findCalendar($0)] } ?? eventCalendars()
    let from = try (a["from"] as? String).map(parseDate) ?? Calendar.current.startOfDay(for: Date())
    var to = try (a["to"] as? String).map(parseDate) ?? from.addingTimeInterval(7 * 86_400)
    // A day-only "to" means through the end of that day.
    if let s = a["to"] as? String, isDayOnly(s) { to = to.addingTimeInterval(86_400) }
    if to <= from { throw HelperError(message: "to must be after from") }
    let query = (a["search"] as? String)?.lowercased()
    let limit = a["limit"] as? Int ?? 100

    let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: cals))
        .filter { e in
            guard let q = query else { return true }
            return [e.title, e.location, e.notes].contains { ($0 ?? "").lowercased().contains(q) }
        }
        .sorted { $0.startDate < $1.startDate }
    return [
        "total": events.count,
        "returned": min(limit, events.count),
        "events": events.prefix(limit).map { serializeEvent($0, full: false) },
    ]
}

func createEvent(_ a: [String: Any]) throws -> Any {
    guard let title = a["title"] as? String, !title.isEmpty else { throw HelperError(message: "title is required") }
    guard a["start"] is String else { throw HelperError(message: "start is required") }
    let e = EKEvent(eventStore: store)
    e.title = title
    if a["calendar"] == nil {
        guard let def = store.defaultCalendarForNewEvents else { throw HelperError(message: "No default calendar; pass calendar") }
        e.calendar = def
    }
    try applyEventFields(e, a)
    try store.save(e, span: .thisEvent, commit: true)
    return serializeEvent(e, full: true)
}

func updateEvent(_ a: [String: Any]) throws -> Any {
    let e = try findEvent(a)
    try applyEventFields(e, a)
    try store.save(e, span: span(a), commit: true)
    return serializeEvent(e, full: true)
}

func deleteEvent(_ a: [String: Any]) throws -> Any {
    let e = try findEvent(a)
    let out: [String: Any] = ["deleted": true, "id": e.eventIdentifier ?? NSNull(), "title": e.title ?? "", "start": eventTime(e, e.startDate)]
    try store.remove(e, span: span(a), commit: true)
    return out
}

// MARK: - Main

guard CommandLine.arguments.count >= 2,
      let data = CommandLine.arguments[1].data(using: .utf8),
      let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let op = req["op"] as? String else {
    fail("Usage: reminders-helper '{\"op\": ..., \"args\": {...}}'")
}
let args = req["args"] as? [String: Any] ?? [:]

let calendarOps: Set = ["listCalendars", "createCalendar", "listEvents", "getEvent", "createEvent", "updateEvent", "deleteEvent"]

do {
    try requestAccess(calendarOps.contains(op) ? .event : .reminder)
    let result: Any
    switch op {
    case "listCalendars": result = try listCalendars()
    case "createCalendar": result = try createCalendar(args)
    case "listEvents": result = try listEvents(args)
    case "getEvent": result = serializeEvent(try findEvent(args), full: true)
    case "createEvent": result = try createEvent(args)
    case "updateEvent": result = try updateEvent(args)
    case "deleteEvent": result = try deleteEvent(args)
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
