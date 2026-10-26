import SwiftUI

/// New request and Edit request: who to meet, within what distance and an
/// optional time window that ends within 7 days. Editing adds Paused and
/// Delete request. An edit sends only what changed, so pausing alone keeps
/// the request's checks.
struct CommonGroundNearbyRequestSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.kordiChatTheme) private var chatTheme
    let need: CommonGroundNearbyNeed?
    @State private var text: String
    @State private var range: Int
    @State private var windowed: Bool
    @State private var start: Date
    @State private var end: Date
    @State private var paused: Bool
    @State private var error: String?
    @FocusState private var focused: Bool

    static let maxText = 200

    init(need: CommonGroundNearbyNeed?, defaultRange: Int, now: Date = .now) {
        self.need = need
        let from = need?.start ?? CommonGroundMeetSheet.nextHour(after: now)
        _text = State(initialValue: need?.text ?? "")
        _range = State(initialValue: need?.range ?? defaultRange)
        _windowed = State(initialValue: need?.end != nil)
        _start = State(initialValue: from)
        _end = State(initialValue: need?.end ?? from.addingTimeInterval(3 * 60 * 60))
        _paused = State(initialValue: need?.paused ?? false)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var problem: CommonGroundNearbyWindow.Problem? {
        windowed ? CommonGroundNearbyWindow.problem(start: start, end: end, now: .now) : nil
    }

    private var canSave: Bool { !trimmed.isEmpty && problem == nil && model.busy != "need" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CommonGroundSheetHeader(title: need == nil ? "New request" : "Edit request") { dismiss() }
                TextField("Who are you looking for?", text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.top, 10)
                    .onChange(of: text) { _, typed in
                        if typed.count > Self.maxText { text = String(typed.prefix(Self.maxText)) }
                    }
                options.padding(.top, 18)
                if let problem {
                    Text(CommonGroundNearbyWindow.message(problem))
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                        .padding(.top, 8)
                }
                if let need {
                    CommonGroundSection {
                        Button(role: .destructive) { Task { await delete(need) } } label: {
                            Text("Delete request")
                                .font(.body)
                                .foregroundStyle(.red)
                                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                                .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(SessionRowButtonStyle())
                        .disabled(model.busy == "need")
                    }
                    .padding(.top, 18)
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 10)
                }
                Button("Save") { Task { await save() } }
                    .buttonStyle(CommonGroundPrimaryButtonStyle())
                    .disabled(!canSave)
                    .padding(.top, 18)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(Color(uiColor: .systemGroupedBackground))
        .onAppear { if need == nil { focused = true } }
    }

    private var options: some View {
        let now = Date.now
        return CommonGroundSection {
            Menu {
                Picker("Within", selection: $range) {
                    ForEach(CommonGroundNearbyBand.ranges, id: \.self) { Text(CommonGroundNearbyBand.rangeLabel($0)).tag($0) }
                }
            } label: {
                HStack(spacing: 6) {
                    Text("Within").font(.body).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    Text(CommonGroundNearbyBand.rangeLabel(range)).font(.body).foregroundStyle(.secondary)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight)
                .contentShape(Rectangle())
            }
            separator
            toggleRow("Time window", isOn: $windowed.animation(.easeOut(duration: 0.24)))
            if windowed {
                separator
                DatePicker("From", selection: $start, in: min(start, now)..., displayedComponents: [.date, .hourAndMinute])
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                separator
                DatePicker("Until", selection: $end, in: now...now.addingTimeInterval(CommonGroundNearbyWindow.maxAhead),
                           displayedComponents: [.date, .hourAndMinute])
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
            }
            if need != nil {
                separator
                toggleRow("Paused", isOn: $paused)
            }
        }
    }

    private var separator: some View { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }

    private func toggleRow(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) { Text(title).font(.body) }
            .tint(chatTheme.accent)
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .frame(minHeight: SessionDetailMetrics.rowMinHeight)
    }

    /// The body for a save: everything for a new request, only changes for an edit.
    static func draft(for need: CommonGroundNearbyNeed?, text: String, range: Int, window: (start: Date, end: Date)?,
                      paused: Bool) -> CommonGroundNearbyNeedDraft? {
        let iso = ISO8601DateFormatter()
        let startsAt = window.map { iso.string(from: $0.start) }
        let endsAt = window.map { iso.string(from: $0.end) }
        guard let need else {
            var draft = CommonGroundNearbyNeedDraft(text: text, range: range)
            if window != nil {
                draft.startsAt = .some(startsAt)
                draft.endsAt = .some(endsAt)
            }
            return draft
        }
        var draft = CommonGroundNearbyNeedDraft()
        if text != need.text { draft.text = text }
        if range != need.range { draft.range = range }
        let sameStart = window.map { Self.sameSecond($0.start, need.start) } ?? (need.start == nil)
        let sameEnd = window.map { Self.sameSecond($0.end, need.end) } ?? (need.end == nil)
        if !sameStart || !sameEnd {
            draft.startsAt = .some(startsAt)
            draft.endsAt = .some(endsAt)
        }
        if paused != need.paused { draft.paused = paused }
        return draft == CommonGroundNearbyNeedDraft() ? nil : draft
    }

    private static func sameSecond(_ date: Date, _ other: Date?) -> Bool {
        guard let other else { return false }
        return abs(date.timeIntervalSince(other)) < 1
    }

    private func save() async {
        error = nil
        guard canSave else { return }
        let window = windowed ? (start: start, end: end) : nil
        guard let draft = Self.draft(for: need, text: trimmed, range: range, window: window, paused: paused) else {
            dismiss()
            return
        }
        if await model.saveNearbyNeed(need?.needId, draft: draft) {
            dismiss()
        } else {
            error = model.notice
            model.notice = nil
        }
    }

    private func delete(_ need: CommonGroundNearbyNeed) async {
        error = nil
        if await model.deleteNearbyNeed(need.needId) {
            dismiss()
        } else {
            error = model.notice
            model.notice = nil
        }
    }
}
