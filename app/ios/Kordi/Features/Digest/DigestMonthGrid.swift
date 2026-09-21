import SwiftUI

struct DigestMonthGrid: View {
    let month: Date
    let events: [DigestCalendarEvent]
    let candidates: [RollingDigestItem]
    @Binding var selectedDay: Date
    let onSelect: (DigestCalendarEvent) -> Void
    let onReview: (RollingDigestItem) -> Void
    private func proposals(on day: Date) -> [RollingDigestItem] { DigestDate.pendingCandidates(candidates, events: events, on: day) }
    private let columns = Array(repeating: GridItem(.flexible(minimum: 0), spacing: 2), count: 7)

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 16) {
                Label { Text("Scheduled") } icon: { Circle().fill(Color.accentColor).frame(width: 6, height: 6) }
                Label { Text("To review") } icon: { Circle().strokeBorder(Color.accentColor, lineWidth: 1).frame(width: 7, height: 7) }
            }.font(.caption).foregroundStyle(.secondary)
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], id: \.self) { day in
                    Text(day).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.bottom, 4)
                }
                let days = DigestDate.monthDays(containing: month)
                // One pass over the events per render; a synced calendar can hold hundreds of events.
                let byDay = DigestDate.eventsByDay(events, days: days)
                ForEach(days, id: \.self) { day in
                    let proposed = candidates.isEmpty ? [] : proposals(on: day)
                    let onDay = byDay[DigestDate.key(day)] ?? []
                    let matching = proposed.isEmpty ? onDay : onDay.filter { event in !proposed.contains { $0.calendarCancellationTargets(event) } }
                    let selected = Calendar.current.isDate(day, inSameDayAs: selectedDay)
                    let inMonth = Calendar.current.isDate(day, equalTo: month, toGranularity: .month)
                    Button { selectedDay = day } label: {
                        VStack(spacing: 3) {
                            Text(day, format: .dateTime.day()).font(.subheadline.weight(selected ? .semibold : .regular))
                                .frame(width: 30, height: 30)
                                .foregroundStyle(selected ? Color.white : Calendar.current.isDateInToday(day) ? Color.accentColor : inMonth ? .primary : .secondary)
                                .background(selected ? Color.accentColor : .clear, in: .circle)
                            HStack(spacing: 3) {
                                if !matching.isEmpty { Circle().fill(Color.accentColor).frame(width: 4, height: 4) }
                                if proposed.contains(where: { $0.calendarAction != "delete" }) { Circle().strokeBorder(Color.accentColor, lineWidth: 1).frame(width: 5, height: 5) }
                                if proposed.contains(where: { $0.calendarAction == "delete" }) { Circle().strokeBorder(KordiTheme.destructiveText, lineWidth: 1).frame(width: 5, height: 5) }
                            }.frame(height: 5)
                        }.frame(maxWidth: .infinity, minHeight: 44).contentShape(.rect)
                    }.buttonStyle(.plain)
                        .accessibilityLabel("\(day.formatted(date: .complete, time: .omitted)), \(matching.count) scheduled, \(proposed.count) to review")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            Divider()
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let now = context.date
                let proposed = proposals(on: selectedDay).sorted { ($0.startAt ?? "") < ($1.startAt ?? "") }
                let scheduled = events.filter { event in DigestDate.event(event, occursOn: selectedDay) && !proposed.contains { $0.calendarCancellationTargets(event) } }.sorted { $0.startAt < $1.startAt }
                // The current-time marker only belongs on today, placed where it falls between events.
                let nowIndex = DigestDate.nowMarkerIndex(among: scheduled, on: selectedDay, now: now)
                VStack(alignment: .leading, spacing: 16) {
                    Text(selectedDay.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())).font(.subheadline.weight(.semibold))
                    ForEach(Array(scheduled.enumerated()), id: \.element.id) { index, event in
                        if index == nowIndex { nowMarker(now) }
                        Button { onSelect(event) } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Text(event.allDay ? "All day" : DigestDate.parse(event.startAt)?.formatted(date: .omitted, time: .shortened) ?? "")
                                    .font(.caption).foregroundStyle(.secondary).frame(width: 62, alignment: .leading)
                                RoundedRectangle(cornerRadius: 2).fill(Color.accentColor).frame(width: 3, height: 32)
                                Text(event.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                            }.padding(.vertical, 6).frame(minHeight: 44)
                        }.buttonStyle(.plain)
                    }
                    if nowIndex == scheduled.count { nowMarker(now) }
                    if scheduled.isEmpty && proposed.isEmpty { Text("No events on this day").font(.footnote).foregroundStyle(.secondary) }
                    ForEach(proposed) { item in
                        let occurrence = events.first { item.calendarCancellationTargets($0) && DigestDate.event($0, occursOn: selectedDay) }
                        Button { onReview(item) } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Text(occurrence?.allDay == true ? "All day" : DigestDate.parse(occurrence?.startAt ?? item.startAt)?.formatted(date: .omitted, time: .shortened) ?? "")
                                    .font(.caption).foregroundStyle(.secondary).frame(width: 62, alignment: .leading)
                                RoundedRectangle(cornerRadius: 2).stroke(item.calendarAction == "delete" ? KordiTheme.destructiveText : Color.accentColor, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(width: 3, height: 32)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item.title).font(.subheadline.weight(.medium)).foregroundStyle(item.calendarAction == "delete" ? KordiTheme.destructiveText : Color.primary)
                                    Text(item.calendarAction == "delete" ? "Cancellation to review" : "To review").font(.caption).foregroundStyle(item.calendarAction == "delete" ? KordiTheme.destructiveText : Color.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                            }.padding(.vertical, 6).frame(minHeight: 44)
                        }.buttonStyle(.plain).accessibilityLabel(item.calendarAction == "delete" ? "Review cancellation of \(item.title)" : "Review \(item.title)")
                    }
                }
            }
        }
    }

    /// The current time inside today's list: a time label, dot and rule, matching the desktop week view's indicator.
    @ViewBuilder private func nowMarker(_ now: Date) -> some View {
        HStack(spacing: 12) {
            Text(now.formatted(date: .omitted, time: .shortened))
                .font(.caption.weight(.medium)).foregroundStyle(KordiTheme.nowIndicator).frame(width: 62, alignment: .leading)
            HStack(spacing: 0) {
                Circle().fill(KordiTheme.nowIndicator).frame(width: 7, height: 7)
                Rectangle().fill(KordiTheme.nowIndicator).frame(height: 2)
            }
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Current time, \(now.formatted(date: .omitted, time: .shortened))")
    }
}
