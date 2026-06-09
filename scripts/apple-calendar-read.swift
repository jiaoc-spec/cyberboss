#!/usr/bin/env swift
import EventKit
import Foundation

struct CalendarReadOutput: Codable {
  let provider: String
  let authorization: String
  let start: String
  let end: String
  let calendars: [String]
  let events: [CalendarEventOutput]
  let error: String?
}

struct CalendarEventOutput: Codable {
  let id: String
  let calendar: String
  let title: String
  let start: String
  let end: String
  let isAllDay: Bool
  let location: String?
  let notes: String?
  let url: String?
}

let arguments = CommandLine.arguments.dropFirst()
let isoFormatter = ISO8601DateFormatter()
isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func argumentValue(_ name: String) -> String? {
  var iterator = arguments.makeIterator()
  while let current = iterator.next() {
    if current == name {
      return iterator.next()
    }
    if current.hasPrefix("\(name)=") {
      return String(current.dropFirst(name.count + 1))
    }
  }
  return nil
}

func parseDate(_ value: String?) -> Date? {
  guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    return nil
  }
  if let date = isoFormatter.date(from: value) {
    return date
  }
  let fallback = ISO8601DateFormatter()
  fallback.formatOptions = [.withInternetDateTime]
  return fallback.date(from: value)
}

func parseInt(_ value: String?, default defaultValue: Int) -> Int {
  guard let value, let parsed = Int(value), parsed > 0 else {
    return defaultValue
  }
  return parsed
}

func emit(_ output: CalendarReadOutput, exitCode: Int32 = 0) -> Never {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  if let data = try? encoder.encode(output), let text = String(data: data, encoding: .utf8) {
    print(text)
  } else {
    print("{\"provider\":\"apple-calendar\",\"authorization\":\"unknown\",\"events\":[],\"error\":\"failed to encode output\"}")
  }
  exit(exitCode)
}

let calendar = Calendar.current
let now = Date()
let start = parseDate(argumentValue("--start")) ?? calendar.startOfDay(for: now)
let days = parseInt(argumentValue("--days"), default: 7)
let end = parseDate(argumentValue("--end")) ?? calendar.date(byAdding: .day, value: days, to: start)!
let calendarNameFilter = argumentValue("--calendars")?
  .split(separator: ",")
  .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
  .filter { !$0.isEmpty }
let includeNotes = argumentValue("--include-notes") == "true"
let includeUrls = argumentValue("--include-urls") == "true"
let shouldRequestAccess = argumentValue("--request-access") == "true"

let store = EKEventStore()

let initialAuthorization = calendarAuthorizationStatus()
if initialAuthorization == "not_determined" && !shouldRequestAccess {
  emit(CalendarReadOutput(
    provider: "apple-calendar",
    authorization: initialAuthorization,
    start: isoFormatter.string(from: start),
    end: isoFormatter.string(from: end),
    calendars: [],
    events: [],
    error: "Calendar access has not been requested yet. Run again with --request-access true from an interactive macOS session."
  ))
}

let requestResult = requestCalendarAccessIfNeeded()
let finalAuthorization = calendarAuthorizationStatus()

if !requestResult.granted {
  emit(CalendarReadOutput(
    provider: "apple-calendar",
    authorization: finalAuthorization,
    start: isoFormatter.string(from: start),
    end: isoFormatter.string(from: end),
    calendars: [],
    events: [],
    error: requestResult.error?.localizedDescription ?? "Calendar access was not granted."
  ), exitCode: 2)
}

let allCalendars = store.calendars(for: .event)
let selectedCalendars: [EKCalendar]
if let filter = calendarNameFilter, !filter.isEmpty {
  let wanted = Set(filter.map { $0.lowercased() })
  selectedCalendars = allCalendars.filter { wanted.contains($0.title.lowercased()) }
} else {
  selectedCalendars = allCalendars
}

let predicate = store.predicateForEvents(withStart: start, end: end, calendars: selectedCalendars)
let events = store.events(matching: predicate)
  .sorted { left, right in
    if left.startDate == right.startDate {
      return left.title < right.title
    }
    return left.startDate < right.startDate
  }
  .map { event in
    CalendarEventOutput(
      id: event.eventIdentifier,
      calendar: event.calendar.title,
      title: event.title ?? "",
      start: isoFormatter.string(from: event.startDate),
      end: isoFormatter.string(from: event.endDate),
      isAllDay: event.isAllDay,
      location: event.location,
      notes: includeNotes ? event.notes : nil,
      url: includeUrls ? event.url?.absoluteString : nil
    )
  }

emit(CalendarReadOutput(
  provider: "apple-calendar",
  authorization: "granted",
  start: isoFormatter.string(from: start),
  end: isoFormatter.string(from: end),
  calendars: selectedCalendars.map(\.title).sorted(),
  events: events,
  error: nil
))

func calendarAuthorizationStatus() -> String {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    switch status {
    case .fullAccess:
      return "granted"
    case .writeOnly:
      return "write_only"
    case .denied:
      return "denied"
    case .restricted:
      return "restricted"
    case .notDetermined:
      return "not_determined"
    @unknown default:
      return "unknown"
    }
  }
  switch status {
  case .fullAccess:
    return "granted"
  case .writeOnly:
    return "write_only"
  case .authorized:
    return "granted"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  case .notDetermined:
    return "not_determined"
  @unknown default:
    return "unknown"
  }
}

func requestCalendarAccessIfNeeded() -> (granted: Bool, error: Error?) {
  let status = calendarAuthorizationStatus()
  if status == "granted" {
    return (true, nil)
  }
  if status != "not_determined" || !shouldRequestAccess {
    return (false, nil)
  }

  let semaphore = DispatchSemaphore(value: 0)
  var granted = false
  var authError: Error?
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { accessGranted, error in
      granted = accessGranted
      authError = error
      semaphore.signal()
    }
  } else {
    store.requestAccess(to: .event) { accessGranted, error in
      granted = accessGranted
      authError = error
      semaphore.signal()
    }
  }
  semaphore.wait()
  return (granted, authError)
}
