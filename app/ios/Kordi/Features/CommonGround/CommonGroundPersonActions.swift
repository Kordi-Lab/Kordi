import SwiftUI

/// Add (or Requested, Accept, Message) and Meet for one person, as glass
/// tiles. Message and Meet lead into the Kordi chat.
struct CommonGroundPersonActions: View {
    @EnvironmentObject private var model: CommonGroundModel
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.commonGroundOpenConversation) private var openConversation
    let person: CommonGroundPerson
    @State private var meets = false
    /// The chat a sent proposal landed in, opened once the sheet closes.
    @State private var meetConversationId: String?

    private var relationship: CommonGroundRelationship? { model.relationship(for: person.accountId) }
    private var action: CommonGroundContactAction { CommonGroundContactAction(relationship) }
    private var canMeet: Bool { CommonGroundContactAction.canMeet(relationship) }

    var body: some View {
        if action != .hidden {
            CommonGroundActions(columns: canMeet ? 2 : 1) {
                SessionProfileActionButton(title: action.title, symbol: action.symbol, tint: commonGroundTint) {
                    Task { await perform(action) }
                }
                .disabled(action == .requested || model.busy != nil)
                if canMeet {
                    SessionProfileActionButton(title: "Meet", symbol: "calendar", tint: commonGroundTint) {
                        meets = true
                    }
                    .disabled(model.busy != nil)
                }
            }
            .frame(maxWidth: canMeet ? .infinity : 180)
            .sheet(isPresented: $meets, onDismiss: openMeetChat) {
                CommonGroundMeetSheet(name: person.displayName) { input in
                    guard let response = await model.meet(person.accountId, input: input) else { return false }
                    meetConversationId = response.conversationId
                    return true
                }
                .environmentObject(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
        }
    }

    private func openMeetChat() {
        guard let conversationId = meetConversationId else { return }
        meetConversationId = nil
        Task { await open(conversationId: conversationId, sessionId: nil) }
    }

    private func perform(_ action: CommonGroundContactAction) async {
        let id = person.accountId
        switch action {
        case .add:
            await model.addContact(id)
        case .accept:
            if let requestId = relationship?.requestId, await appModel.acceptCommonGroundRequest(requestId: requestId) {
                model.markContact(id)
            } else {
                await model.addContact(id)
            }
        case .message:
            guard let response = await model.openChat(id) else { return }
            await open(conversationId: response.conversationId, sessionId: response.sessionId)
        case .requested, .hidden:
            break
        }
    }

    private func open(conversationId: String, sessionId: String?) async {
        if let conversation = await appModel.commonGroundConversation(
            peerAccountId: person.accountId, conversationId: conversationId, sessionId: sessionId
        ) {
            openConversation(conversation)
        } else {
            model.notice = "Could not open the chat."
        }
    }
}

/// Proposes a time in the chat with a contact: title, start and length.
struct CommonGroundMeetSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let send: (CommonGroundMeetInput) async -> Bool
    @State private var title: String
    @State private var start: Date
    @State private var minutes = 30

    init(name: String, now: Date = .now, send: @escaping (CommonGroundMeetInput) async -> Bool) {
        self.send = send
        _title = State(initialValue: "Meet \(name)")
        _start = State(initialValue: Self.nextHour(after: now))
    }

    /// The next full hour, local time.
    static func nextHour(after now: Date, calendar: Calendar = .current) -> Date {
        let hour = calendar.dateInterval(of: .hour, for: now)?.start ?? now
        return calendar.date(byAdding: .hour, value: 1, to: hour) ?? now
    }

    static func input(title: String, start: Date, minutes: Int) -> CommonGroundMeetInput {
        let formatter = ISO8601DateFormatter()
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return CommonGroundMeetInput(
            title: trimmed.isEmpty ? nil : trimmed,
            startAt: formatter.string(from: start),
            endAt: formatter.string(from: start.addingTimeInterval(TimeInterval(minutes * 60)))
        )
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("Meet")
                .font(.headline)
                .padding(.top, 22)
            CommonGroundSection {
                TextField("Title", text: $title)
                    .font(.body)
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
                DatePicker("Starts", selection: $start, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
                Picker("Length", selection: $minutes) {
                    ForEach([30, 60, 90], id: \.self) { Text("\($0) min").tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(minHeight: SessionDetailMetrics.rowMinHeight)
            }
            Spacer(minLength: 0)
            Button("Send") {
                Task {
                    if await send(Self.input(title: title, start: start, minutes: minutes)) { dismiss() }
                }
            }
            .buttonStyle(CommonGroundPrimaryButtonStyle())
            .disabled(model.busy == "meet")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .background(Color(uiColor: .systemGroupedBackground))
    }
}
