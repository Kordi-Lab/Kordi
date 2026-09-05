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
                ForEach(DigestDate.monthDays(containing: month), id: \.self) { day in
                    let matching = events.filter { DigestDate.event($0, occursOn: day) }
                    let proposed = proposals(on: day)
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
                                if !proposed.isEmpty { Circle().strokeBorder(Color.accentColor, lineWidth: 1).frame(width: 5, height: 5) }
                            }.frame(height: 5)
                        }.frame(maxWidth: .infinity, minHeight: 44).contentShape(.rect)
                    }.buttonStyle(.plain)
                        .accessibilityLabel("\(day.formatted(date: .complete, time: .omitted)), \(matching.count) scheduled, \(proposed.count) to review")
                        .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            Divider()
            Text(selectedDay.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())).font(.subheadline.weight(.semibold))
            let scheduled = events.filter { DigestDate.event($0, occursOn: selectedDay) }.sorted { $0.startAt < $1.startAt }
            let proposed = proposals(on: selectedDay).sorted { ($0.startAt ?? "") < ($1.startAt ?? "") }
            if scheduled.isEmpty && proposed.isEmpty { Text("No events on this day").font(.footnote).foregroundStyle(.secondary) }
            ForEach(scheduled) { event in
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
            ForEach(proposed) { item in
                Button { onReview(item) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text(DigestDate.parse(item.startAt)?.formatted(date: .omitted, time: .shortened) ?? "")
                            .font(.caption).foregroundStyle(.secondary).frame(width: 62, alignment: .leading)
                        RoundedRectangle(cornerRadius: 2).stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1, dash: [3, 2])).frame(width: 3, height: 32)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                            Text("To review").font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    }.padding(.vertical, 6).frame(minHeight: 44)
                }.buttonStyle(.plain).accessibilityLabel("Review \(item.title)")
            }
        }
    }
}
