import AppKit
import EventKit
import Foundation

struct CalendarCache: Codable {
  let provider: String
  let authorization: String
  let generatedAt: String
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

@main
final class CalendarHelperApp: NSObject, NSApplicationDelegate {
  private static let sharedDelegate = CalendarHelperApp()
  private let store = EKEventStore()
  private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private var timer: Timer?

  static func main() {
    let app = NSApplication.shared
    app.delegate = sharedDelegate
    app.setActivationPolicy(.accessory)
    app.run()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    requestAccessAndRefresh()
    timer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
      self?.refreshCache()
    }
  }

  private func requestAccessAndRefresh() {
    let status = EKEventStore.authorizationStatus(for: .event)
    if calendarAuthorizationStatus(status) == "granted" {
      refreshCache()
      return
    }
    if status != .notDetermined {
      writeCache(events: [], calendars: [], error: "Calendar access is not granted.")
      return
    }
    if #available(macOS 14.0, *) {
      store.requestFullAccessToEvents { [weak self] _, error in
        DispatchQueue.main.async {
          if let error {
            self?.writeCache(events: [], calendars: [], error: error.localizedDescription)
          } else {
            self?.refreshCache()
          }
        }
      }
    } else {
      store.requestAccess(to: .event) { [weak self] _, error in
        DispatchQueue.main.async {
          if let error {
            self?.writeCache(events: [], calendars: [], error: error.localizedDescription)
          } else {
            self?.refreshCache()
          }
        }
      }
    }
  }

  private func refreshCache() {
    let status = EKEventStore.authorizationStatus(for: .event)
    guard calendarAuthorizationStatus(status) == "granted" else {
      writeCache(events: [], calendars: [], error: "Calendar access is not granted.")
      return
    }
    let calendar = Calendar.current
    let now = Date()
    let start = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now))!
    let end = calendar.date(byAdding: .day, value: 31, to: start)!
    let calendars = store.calendars(for: .event)
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = store.events(matching: predicate)
      .sorted { left, right in
        if left.startDate == right.startDate {
          return (left.title ?? "") < (right.title ?? "")
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
          notes: event.notes,
          url: event.url?.absoluteString
        )
      }
    writeCache(events: events, calendars: calendars.map(\.title).sorted(), error: nil, start: start, end: end)
  }

  private func writeCache(
    events: [CalendarEventOutput],
    calendars: [String],
    error: String?,
    start: Date = Date(),
    end: Date = Date()
  ) {
    let output = CalendarCache(
      provider: "apple-calendar-helper",
      authorization: calendarAuthorizationStatus(EKEventStore.authorizationStatus(for: .event)),
      generatedAt: isoFormatter.string(from: Date()),
      start: isoFormatter.string(from: start),
      end: isoFormatter.string(from: end),
      calendars: calendars,
      events: events,
      error: error
    )
    do {
      let data = try JSONEncoder.pretty.encode(output)
      let file = cacheFilePath()
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      let temporary = file.appendingPathExtension("tmp")
      try data.write(to: temporary, options: .atomic)
      if FileManager.default.fileExists(atPath: file.path) {
        try FileManager.default.removeItem(at: file)
      }
      try FileManager.default.moveItem(at: temporary, to: file)
    } catch {
      NSLog("CyberBoss Calendar Helper failed to write cache: \(error.localizedDescription)")
    }
  }

  private func cacheFilePath() -> URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".cyberboss", isDirectory: true)
      .appendingPathComponent("apple-calendar-cache.json")
  }
}

func calendarAuthorizationStatus(_ status: EKAuthorizationStatus) -> String {
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
  case .authorized:
    return "granted"
  case .denied:
    return "denied"
  case .restricted:
    return "restricted"
  case .notDetermined:
    return "not_determined"
  default:
    return "unknown"
  }
}

extension JSONEncoder {
  static var pretty: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
  }
}
