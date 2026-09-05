import SwiftUI

struct DigestMonthGrid: View {
    let month: Date
    let events: [DigestCalendarEvent]
    let onSelect: (DigestCalendarEvent) -> Void
    @State private var selectedDay: Date?
    @State private var pendingEvent: DigestCalendarEvent?
    private let columns = Array(repeating: GridItem(.flexible(minimum: 0), spacing: 1), count: 7)
    var body: some View {
        VStack(spacing: 1) {
            LazyVGrid(columns: columns, spacing: 1) {
                ForEach(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], id: \.self) { Text($0).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 6) }
                ForEach(DigestDate.monthDays(containing: month), id: \.self) { day in
                    dayCell(day)
                }
            }
        }
        .sheet(isPresented: Binding(get: { selectedDay != nil }, set: { if !$0 { selectedDay = nil } }), onDismiss: { if let event = pendingEvent { pendingEvent = nil; onSelect(event) } }) {
            NavigationStack {
                List {
                    ForEach(events.filter { event in selectedDay.map { DigestDate.event(event, occursOn: $0) } ?? false }) { event in
                        Button { pendingEvent = event; selectedDay = nil } label: { VStack(alignment: .leading) { Text(event.title); Text(event.allDay ? "All day" : DigestDate.parse(event.startAt)?.formatted(date: .omitted, time: .shortened) ?? "").font(.caption).foregroundStyle(.secondary) } }
                    }
                }.navigationTitle(selectedDay?.formatted(date: .abbreviated, time: .omitted) ?? "Events")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { selectedDay = nil } } }
            }
        }
    }
    private func dayCell(_ day: Date) -> some View {
        let matching = events.filter { DigestDate.event($0, occursOn: day) }
        let inMonth = Calendar.current.isDate(day, equalTo: month, toGranularity: .month)
        return VStack(alignment: .leading, spacing: 3) {
            Button { selectedDay = day } label: {
                Text(day, format: .dateTime.day()).font(.caption).frame(maxWidth: .infinity, minHeight: 36)
                    .foregroundStyle(Calendar.current.isDateInToday(day) ? Color.accentColor : inMonth ? .primary : .secondary)
            }.accessibilityLabel(day.formatted(date: .complete, time: .omitted))
            ForEach(Array(matching.prefix(2))) { event in
                Button { onSelect(event) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(event.title).font(.caption2).lineLimit(2)
                        Text(event.allDay ? "All day" : DigestDate.parse(event.startAt)?.formatted(date: .omitted, time: .shortened) ?? "").font(.caption2).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 2)
                        .background(event.allDay ? Color.green.opacity(0.12) : Color.accentColor.opacity(0.06), in: .rect(cornerRadius: 4))
                }.buttonStyle(.plain).accessibilityLabel("\(event.title), \(day.formatted(date: .abbreviated, time: .omitted))")
            }
            if matching.count > 2 { Button("+\(matching.count - 2)") { selectedDay = day }.font(.caption2) }
            Spacer(minLength: 0)
        }.frame(minHeight: 110).padding(2).background(Color(uiColor: .secondarySystemBackground).opacity(inMonth ? 0.45 : 0.2))
    }
}
