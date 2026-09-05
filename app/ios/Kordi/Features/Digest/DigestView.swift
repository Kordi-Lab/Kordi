import SwiftUI

struct DigestMessageRoute: Hashable { let conversation: ConversationSummary; let messageID: String }
private enum DigestPane: String, CaseIterable { case brief = "Brief", tasks = "Next steps", calendar = "Calendar" }
private enum DigestSheet: Identifiable {
    case source([String]), task(RollingDigestItem), event(DigestCalendarEvent), imports, connection, details
    var id: String { switch self { case .source(let ids): "source:\(ids.joined(separator: ","))"; case .task(let item): "task:\(item.id)"; case .event(let event): "event:\(event.id)"; case .imports: "import"; case .connection: "connection"; case .details: "details" } }
}

struct DigestView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var notifications: KordiNotificationCoordinator
    @State private var pane = DigestPane.brief
    @State private var digest: RollingDigestResponse?
    @State private var events: [DigestCalendarEvent] = []
    @State private var error: String?
    @State private var selectedSheet: DigestSheet?
    @State private var month = Date()
    @State private var selectedCalendarDay = Date()
    @State private var calendarScrollRevision = 0
    @State private var remindersAllowed = true
    @State private var remoteReminders = false
    @State private var isRefreshing = false
    @State private var loadRevision = 0
    private var sources: [RollingDigestSource] { digest?.sources ?? [] }
    private var content: RollingDigestContent? { digest?.snapshot }
    private var openTasks: [RollingDigestItem] { content?.commitments.filter { $0.kind != "done" } ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(statusText).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { selectedSheet = .details } label: { Label("Live", systemImage: "circle.fill").font(.caption).labelStyle(.titleAndIcon) }
                    .tint(.secondary)
            }.padding(.horizontal, 18).padding(.bottom, 8)
            HStack(spacing: 26) {
                ForEach(DigestPane.allCases, id: \.self) { tab in
                    Button { pane = tab } label: {
                        VStack(spacing: 8) {
                            HStack(spacing: 4) { Text(tab.rawValue); if tab == .tasks { Text(openTasks.count, format: .number).foregroundStyle(.secondary) } }
                                .font(.subheadline.weight(pane == tab ? .semibold : .regular))
                            Rectangle().fill(pane == tab ? Color.primary : .clear).frame(height: 2)
                        }
                    }.buttonStyle(.plain).accessibilityAddTraits(pane == tab ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, 18)
            Divider()
            ZStack {
                page { brief }.opacity(pane == .brief ? 1 : 0).allowsHitTesting(pane == .brief).accessibilityHidden(pane != .brief)
                page { tasks }.opacity(pane == .tasks ? 1 : 0).allowsHitTesting(pane == .tasks).accessibilityHidden(pane != .tasks)
                page { calendar }.id(calendarScrollRevision).opacity(pane == .calendar ? 1 : 0).allowsHitTesting(pane == .calendar).accessibilityHidden(pane != .calendar)
            }
        }
        .navigationTitle("Digest").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { Task { await requestReminders() } } label: { Image(systemName: "bell") }.accessibilityLabel("Enable calendar reminders")
                Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }.disabled(isRefreshing || digest?.status == "updating").accessibilityLabel("Refresh digest")
            }
        }
        .task(id: model.account?.accountId) {
            guard let accountId = model.account?.accountId else { digest = nil; events = []; selectedSheet = nil; return }
            if digest?.accountId != accountId { digest = nil; events = [] }
            while !Task.isCancelled {
                await load(accountId: accountId)
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, let accountId = model.account?.accountId {
                Task { await load(accountId: accountId) }
            }
        }
        .sheet(item: $selectedSheet) { sheet in
            NavigationStack {
                sheetBody(sheet)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { selectedSheet = nil } } }
            }.presentationDragIndicator(.visible)
        }
        .navigationDestination(for: DigestMessageRoute.self) { route in
            ConversationView(conversation: route.conversation, initialMessageID: route.messageID)
        }
    }
    private var statusText: String {
        if digest?.status == "updating" { return "Updating · previous brief available" }
        if let date = DigestDate.parse(digest?.updatedAt) { return "Updated \(date.formatted(date: .omitted, time: .shortened))" }
        return "Preparing your digest"
    }
    private func page<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if let error { Text(error).font(.subheadline).foregroundStyle(.secondary).accessibilityAddTraits(.updatesFrequently) }
                if let code = digest?.errorCode {
                    Text(code == "missing_provider_auth" ? "Connect a model provider in account settings to generate your digest." : "The last update failed. Your previous brief remains available.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if digest?.partial == true { Text("Partial coverage · a bounded selection of accessible messages was included.").font(.caption).foregroundStyle(.secondary) }
                content()
            }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 20)
        }.refreshable { await refresh() }
    }
    @ViewBuilder private var brief: some View {
        if let lead = content?.claims.first {
            VStack(alignment: .leading, spacing: 10) {
                Text(lead.title).font(.subheadline.weight(.semibold))
                Text(lead.text).foregroundStyle(.secondary)
                people(lead)
                citations(lead)
            }
            ForEach(Array((content?.claims ?? []).dropFirst())) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    Text(item.text).foregroundStyle(.secondary)
                    people(item)
                    citations(item)
                    Divider().padding(.top, 8)
                }
            }
        } else {
            Text(digest?.status == "ready" ? "No conversations to summarize yet." : "Your sourced brief will appear after the first update.").foregroundStyle(.secondary).padding(.vertical, 24)
        }
    }
    @ViewBuilder private var tasks: some View {
        Text("Commitments").font(.subheadline).foregroundStyle(.secondary)
        ForEach(openTasks) { item in
            VStack(alignment: .leading, spacing: 8) {
                Text(item.title).font(.subheadline.weight(.semibold))
                people(item)
                Text(item.kind == "possible" ? "Possible follow-up" : item.ownerAccountId == nil ? "Owner not specified" : "Explicit commitment").font(.caption).foregroundStyle(.secondary)
                if let due = DigestDate.parse(item.dueAt) { Text("Due \(due.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
                citations(item)
                if digest?.feedback.contains(where: { $0.id == item.id && $0.status == "task" }) == true { Text("Already a task").font(.caption).foregroundStyle(.secondary) }
                else { Button("Review task") { selectedSheet = .task(item) }.buttonStyle(.bordered) }
                Divider().padding(.top, 8)
            }
        }
        if openTasks.isEmpty { Text("No open commitments.").foregroundStyle(.secondary) }
        HStack { Text("Consider next"); Spacer(); Text("AI suggestions").font(.caption) }.font(.subheadline).foregroundStyle(.secondary)
        ForEach(content?.suggestions.filter { item in digest?.feedback.contains(where: { $0.id == item.id && $0.status == "dismissed" }) != true } ?? []) { item in
            VStack(alignment: .leading, spacing: 8) {
                Text(item.title).font(.subheadline.weight(.semibold)); Text(item.text).foregroundStyle(.secondary)
                people(item); citations(item)
                Button("Dismiss") { Task { await perform { try await model.dismissDigestItem(item.id, dismissed: true) } } }
            }
        }
        if digest?.feedback.contains(where: { $0.status == "dismissed" }) == true {
            Button("Restore dismissed suggestions") { Task { await perform { for feedback in digest?.feedback.filter({ $0.status == "dismissed" }) ?? [] { try await model.dismissDigestItem(feedback.id, dismissed: false) } } } }
        }
    }
    private var calendar: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 22) {
                Button { selectedSheet = .connection } label: { Label("Connect calendars", systemImage: "calendar.badge.plus") }
                Button { selectedSheet = .imports } label: { Label("Import ICS", systemImage: "square.and.arrow.down") }
            }.font(.subheadline).buttonStyle(.plain).foregroundStyle(.secondary)
            if !remindersAllowed { Text("Events are saved, but notifications are off. Enable them in Settings to receive reminders.").font(.caption).foregroundStyle(.secondary) }
            HStack {
                Text(month.formatted(.dateTime.month(.wide).year())).font(.title3.weight(.semibold))
                Spacer(minLength: 4)
                Button { changeMonth(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous month")
                Button("Today") { month = Date(); selectedCalendarDay = month }.font(.caption)
                Button { changeMonth(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next month")
            }.buttonStyle(.plain)
            DigestMonthGrid(month: month, events: events, candidates: content?.calendarCandidates ?? [], selectedDay: $selectedCalendarDay, onSelect: { selectedSheet = .event($0) }, onReview: reviewCalendarCandidate)
            Divider().padding(.vertical, 4)
            Text("From your chats").font(.subheadline.weight(.semibold))
            ForEach(content?.calendarCandidates ?? []) { item in
                let saved = events.first { $0.id == "digest-\(item.id)" }
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    people(item)
                    HStack(alignment: .firstTextBaseline) {
                        Text(item.startAt.flatMap(DigestDate.parse)?.formatted(date: .abbreviated, time: .shortened) ?? "Date or time not agreed").font(.footnote).foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Button(saved == nil ? "Review & add" : "View event") {
                            reviewCalendarCandidate(item)
                        }.font(.footnote.weight(.medium)).buttonStyle(.plain)
                    }
                    citations(item)
                    Divider().padding(.top, 8)
                }
            }
        }
    }
    private func reviewCalendarCandidate(_ item: RollingDigestItem) {
        let saved = events.first { $0.id == "digest-\(item.id)" }
        selectedSheet = .event(saved ?? DigestCalendarEvent(id: "digest-\(item.id)", title: item.title, startAt: item.startAt ?? "", endAt: item.endAt, sourceIds: item.sourceIds, description: item.text))
    }
    private func changeMonth(_ value: Int) {
        month = Calendar.current.date(byAdding: .month, value: value, to: month) ?? month
        selectedCalendarDay = Calendar.current.dateInterval(of: .month, for: month)?.start ?? month
    }
    private func citations(_ item: RollingDigestItem) -> some View {
        let groups = Dictionary(grouping: sources.filter { item.sourceIds.contains($0.id) }, by: \.sessionId).values.sorted { ($0.first?.sessionTitle ?? "") < ($1.first?.sessionTitle ?? "") }
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(groups, id: \.first?.sessionId) { group in
                if let source = group.first {
                    Button {
                        Task { await perform { digest = try await model.loadRollingDigest(); selectedSheet = .source(group.map(\.id)) } }
                    } label: {
                        Label(source.sessionTitle + (group.count > 1 ? " · \(group.count) messages" : ""), systemImage: "arrow.up.right")
                    }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
                }
            }
        }
    }
    private func people(_ item: RollingDigestItem) -> some View {
        DigestPeopleView(sourceIds: item.sourceIds, ownerAccountId: item.ownerAccountId, sources: sources, accountId: model.account?.accountId ?? "", contacts: model.contacts) { source in
            Task { await perform { digest = try await model.loadRollingDigest(); selectedSheet = .source([source.id]) } }
        }
    }
    @ViewBuilder private func sheetBody(_ sheet: DigestSheet) -> some View {
        switch sheet {
        case .source(let ids):
            let selected = sources.filter { ids.contains($0.id) }.sorted { $0.createdAt < $1.createdAt }
            ScrollView {
                if let first = selected.first {
                    VStack(alignment: .leading, spacing: 18) {
                        ForEach(selected) { source in
                            VStack(alignment: .leading, spacing: 8) {
                                Text("@\(source.senderName)").font(.subheadline.weight(.medium))
                                Text(source.text).font(.subheadline).textSelection(.enabled)
                                if let date = DigestDate.parse(source.createdAt) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
                                if let conversation = model.conversations.first(where: { $0.sessionId == source.sessionId || $0.id == source.conversationId }) {
                                    NavigationLink("Open conversation", value: DigestMessageRoute(conversation: conversation, messageID: source.id)).font(.footnote)
                                }
                                Divider()
                            }
                        }
                    }.padding().navigationTitle(first.sessionTitle)
                } else { Text("This source is no longer accessible or included.").padding().navigationTitle("Source unavailable") }
            }.navigationDestination(for: DigestMessageRoute.self) { route in ConversationView(conversation: route.conversation, initialMessageID: route.messageID) }
        case .task(let item): DigestTaskEditor(item: item, sources: sources, accountId: model.account?.accountId ?? "", contacts: model.contacts) { input in try await model.createDigestTask(item.id, input: input); await reloadAfterEdit() }
        case .event(let event): DigestEventEditor(event: event, sources: sources, accountId: model.account?.accountId ?? "", contacts: model.contacts) { updated in try await model.saveDigestCalendarEvent(updated); await reloadAfterEdit(); if let date = DigestDate.parse(updated.startAt) { month = date; selectedCalendarDay = date }; pane = .calendar; calendarScrollRevision += 1 } remove: { try await model.removeDigestCalendarEvent(event); await reloadAfterEdit() }
        case .imports: DigestImportView(existing: events) { incoming in let report = try await model.importDigestCalendar(incoming); if let id = model.account?.accountId { await load(accountId: id) }; return report }
        case .connection: DigestConnectView(existing: events) { incoming in let report = try await model.importDigestCalendar(incoming); if let id = model.account?.accountId { await load(accountId: id) }; return report }
        case .details: ScrollView { VStack(alignment: .leading, spacing: 16) { Text("Updates follow your messages, sessions and calendar events."); Text("Open work stays in the digest until later evidence resolves it."); Text("\(sources.count) source messages are currently included. Only accessible sources may be opened.").foregroundStyle(.secondary) }.padding() }.navigationTitle("Live digest")
        }
    }
    private func reloadAfterEdit() async { selectedSheet = nil; if let account = model.account?.accountId { await load(accountId: account) } }
    private func load(accountId: String) async {
        loadRevision += 1
        let revision = loadRevision
        do {
            async let report = model.loadRollingDigest()
            async let calendar = model.loadDigestCalendar()
            let (next, calendarResponse) = try await (report, calendar)
            let nextEvents = calendarResponse.events
            try Task.checkCancellation()
            guard model.account?.accountId == accountId, revision == loadRevision else { return }
            remoteReminders = calendarResponse.pushAvailable
            digest = next; events = nextEvents; error = nil
            let accessibleIDs = Set(next.sources.map(\.id))
            if let sheet = selectedSheet {
                switch sheet {
                case .task(let item) where !item.sourceIds.allSatisfy(accessibleIDs.contains): selectedSheet = nil
                case .event(let event) where !event.sourceIds.allSatisfy(accessibleIDs.contains): selectedSheet = nil
                default: break
                }
            }
            if let eventID = notifications.pendingCalendarEventID {
                pane = .calendar
                if let event = nextEvents.first(where: { $0.id == eventID }) { month = DigestDate.parse(event.startAt) ?? Date(); selectedSheet = .event(event) }
                notifications.consumeCalendarRoute()
            }
            if remoteReminders {
                await DigestCalendarService.clearReminders()
                await notifications.refreshAuthorizationState(registerIfAllowed: true)
                remindersAllowed = notifications.authorizationState.canRegisterForRemoteNotifications
            } else { remindersAllowed = try await DigestCalendarService.syncReminders(accountId: accountId, events: nextEvents, isCurrentAccount: { model.account?.accountId == accountId }) }
        } catch { if !Task.isCancelled, revision == loadRevision, model.account?.accountId == accountId { self.error = error.localizedDescription } }
    }
    private func refresh() async { isRefreshing = true; defer { isRefreshing = false }; await perform { try await model.refreshRollingDigest() }; if let id = model.account?.accountId { await load(accountId: id) } }
    private func requestReminders() async { if remoteReminders { await notifications.requestAuthorization(); remindersAllowed = notifications.authorizationState.canRegisterForRemoteNotifications; return }; guard let id = model.account?.accountId else { return }; await perform { remindersAllowed = try await DigestCalendarService.syncReminders(accountId: id, events: events, requestPermission: true, isCurrentAccount: { model.account?.accountId == id }) } }
    private func perform(_ operation: () async throws -> Void) async { do { try await operation(); error = nil } catch { self.error = error.localizedDescription } }
}
