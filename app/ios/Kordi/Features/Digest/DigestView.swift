import SwiftUI

struct DigestMessageRoute: Hashable { let conversation: ConversationSummary; let messageID: String }
private enum DigestPane: String, CaseIterable { case brief = "Brief", tasks = "Next steps", calendar = "Calendar" }
enum DigestReadState: Equatable {
    case loading, failed, content
    init(hasResponse: Bool, error: String?) {
        self = hasResponse ? .content : error == nil ? .loading : .failed
    }
}

private struct DigestReadNotice: View {
    let name: String
    let hasResponse: Bool
    let error: String?
    let retry: () -> Void

    var body: some View {
        if let error {
            VStack(alignment: .leading, spacing: 8) {
                Text(error).foregroundStyle(.secondary)
                Button("Try again", action: retry).buttonStyle(.plain)
            }.accessibilityAddTraits(.updatesFrequently)
        } else if !hasResponse {
            ProgressView("Loading \(name)…")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
private enum DigestSheet: Identifiable {
    case source([String]), event(DigestCalendarEvent, RollingDigestItem? = nil, DigestCalendarEvent? = nil, [DigestCalendarEvent]? = nil), imports, connection, details
    var id: String { switch self { case .source(let ids): "source:\(ids.joined(separator: ","))"; case .event(let event, let proposal, _, _): "event:\(event.id):\(proposal?.id ?? "")"; case .imports: "import"; case .connection: "connection"; case .details: "details" } }
}

struct DigestView: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var notifications: KordiNotificationCoordinator
    @State private var pane = DigestPane.brief
    private var digest: RollingDigestResponse? { model.rollingDigestSnapshot }
    private var events: [DigestCalendarEvent] { model.digestCalendarSnapshot?.events ?? [] }
    @State private var error: String?
    @State private var digestLoadError: String?
    @State private var calendarLoadError: String?
    @State private var selectedSheet: DigestSheet?
    @State private var month = Date()
    @State private var selectedCalendarDay = Date()
    @State private var calendarScrollRevision = 0
    @State private var remindersAllowed = true
    private var remoteReminders: Bool { model.digestCalendarSnapshot?.pushAvailable ?? false }
    @State private var isRefreshing = false
    @State private var loadRevision = 0
    private var sources: [RollingDigestSource] { digest?.sources ?? [] }
    private var content: RollingDigestContent? { digest?.snapshot }
    private var visibleClaims: [RollingDigestItem] { digest?.visibleClaims ?? [] }
    private var dismissedSuggestions: [RollingDigestItem] { digest?.dismissedSuggestions ?? [] }
    private var visibleSuggestions: [RollingDigestItem] { digest?.visibleSuggestions ?? [] }
    private var calendarCandidates: [RollingDigestItem] { (content?.calendarCandidates ?? []).filter { $0.calendarProposalAvailable(events: events) } }
    private var digestReadState: DigestReadState { DigestReadState(hasResponse: digest != nil, error: digestLoadError) }
    private var calendarReadState: DigestReadState { DigestReadState(hasResponse: model.digestCalendarSnapshot != nil, error: calendarLoadError) }

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
                            HStack(spacing: 4) { Text(tab.rawValue); if tab == .tasks, digestReadState == .content { Text(visibleSuggestions.count, format: .number).foregroundStyle(.secondary) } }
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
            guard let accountId = model.account?.accountId else { return }
            while !Task.isCancelled {
                await load(accountId: accountId)
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .onChange(of: model.account?.accountId) { _, _ in
            selectedSheet = nil
            error = nil; digestLoadError = nil; calendarLoadError = nil
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
        if digestReadState == .failed { return "Could not load digest" }
        if digestReadState == .loading { return "Loading digest…" }
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
                content()
            }.font(.subheadline).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.vertical, 20)
        }.refreshable { await refresh() }
    }
    @ViewBuilder private var brief: some View {
        digestReadNotice
        if let lead = visibleClaims.first {
            VStack(alignment: .leading, spacing: 10) {
                Text(lead.title).font(.subheadline.weight(.semibold))
                Text(lead.text).foregroundStyle(.secondary)
                people(lead)
                citations(lead)
            }
            ForEach(Array(visibleClaims.dropFirst())) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    Text(item.text).foregroundStyle(.secondary)
                    people(item)
                    citations(item)
                    DigestRelatedLinks(urls: DigestRelatedLinks.sourceURLs(item.sourceIds, sources: sources))
                    Divider().padding(.top, 8)
                }
            }
        } else if digestReadState == .content {
            Text(digest?.status == "ready" ? (sources.isEmpty ? "No conversations to summarize yet." : "No brief entries to show.") : "Your sourced brief will appear after the first update.").foregroundStyle(.secondary).padding(.vertical, 24)
        }
    }
    @ViewBuilder private var tasks: some View {
        Text("AI suggestions").font(.subheadline).foregroundStyle(.secondary)
        digestReadNotice
        ForEach(visibleSuggestions) { item in
            VStack(alignment: .leading, spacing: 8) {
                Text(item.title).font(.subheadline.weight(.semibold)); Text(item.text).foregroundStyle(.secondary)
                people(item); citations(item)
                Button("Dismiss") { Task { await perform { try await model.dismissDigestItem(item.id, dismissed: true) } } }
            }
        }
        if visibleSuggestions.isEmpty, digestReadState == .content {
            Text(content == nil && digest?.status != "ready" ? "Suggestions will appear after the first update." : "No suggestions to show.").foregroundStyle(.secondary)
        }
        if !dismissedSuggestions.isEmpty {
            Button("Restore dismissed suggestions") { Task { await perform { for item in dismissedSuggestions { try await model.dismissDigestItem(item.id, dismissed: false) } } } }
        }
    }
    private var calendar: some View {
        VStack(alignment: .leading, spacing: 18) {
            DigestReadNotice(name: "calendar", hasResponse: model.digestCalendarSnapshot != nil, error: calendarLoadError) { retryRead(calendar: true) }
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
            if calendarReadState == .content {
                DigestMonthGrid(month: month, events: events, candidates: calendarCandidates, selectedDay: $selectedCalendarDay, onSelect: { selectedSheet = .event($0) }, onReview: reviewCalendarCandidate)
                if events.isEmpty { Text("No saved events.").font(.footnote).foregroundStyle(.secondary) }
            }
            Text("Shown in \(TimeZone.current.identifier)").font(.caption).foregroundStyle(.secondary)
            Divider().padding(.vertical, 4)
            Text("From your chats").font(.subheadline.weight(.semibold))
            digestReadNotice
            ForEach(calendarCandidates) { item in
                VStack(alignment: .leading, spacing: 8) {
                    if item.calendarAction == "delete" { Text("Cancellation to review").font(.caption).foregroundStyle(KordiTheme.destructiveText) }
                    Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(item.calendarAction == "delete" ? KordiTheme.destructiveText : Color.primary)
                    people(item)
                    HStack(alignment: .firstTextBaseline) {
                        Text(item.calendarScope == "series" ? "\(item.calendarReviewSeries(events: events)?.count ?? 0) events in this series" : item.startAt.flatMap(DigestDate.parse)?.formatted(date: .abbreviated, time: .shortened) ?? "Date or time not agreed").font(.footnote).foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Button(item.calendarReviewLabel(events: events)) {
                            reviewCalendarCandidate(item)
                        }.font(.footnote.weight(.medium)).buttonStyle(.plain).foregroundStyle(item.calendarAction == "delete" ? KordiTheme.destructiveText : Color.accentColor)
                    }
                    citations(item)
                    Divider().padding(.top, 8)
                }
            }
        }
    }
    private var digestReadNotice: some View {
        DigestReadNotice(name: "digest", hasResponse: digest != nil, error: digestLoadError) { retryRead(calendar: false) }
    }
    private func retryRead(calendar: Bool) {
        guard let accountId = model.account?.accountId else { return }
        if calendar { calendarLoadError = nil } else { digestLoadError = nil }
        let revision = loadRevision
        Task {
            if calendar { await loadCalendar(accountId: accountId, revision: revision) }
            else { await loadDigest(accountId: accountId, revision: revision) }
        }
    }
    private func reviewCalendarCandidate(_ item: RollingDigestItem) {
        do {
            let event = try item.calendarReviewEvent(events: events, sources: sources, timezone: digest?.timezone)
            selectedSheet = .event(event, item, events.first { $0.id == item.existingEventId }, item.calendarReviewSeries(events: events))
        } catch { self.error = error.localizedDescription }
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
                        selectedSheet = .source(group.map(\.id))
                    } label: {
                        Label(source.sessionTitle + (group.count > 1 ? " · \(group.count) messages" : ""), systemImage: "arrow.up.right")
                    }.font(.caption).foregroundStyle(.secondary).padding(.vertical, 4)
                }
            }
        }
    }
    private func people(_ item: RollingDigestItem) -> some View {
        DigestPeopleView(sourceIds: item.sourceIds, ownerAccountId: item.ownerAccountId, sources: sources, accountId: model.account?.accountId ?? "", contacts: model.contacts) { source in
            selectedSheet = .source([source.id])
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
                                MarkdownMessageContent(text: source.text).textSelection(.enabled)
                                if let date = DigestDate.parse(source.createdAt) { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary) }
                                if let conversation = model.conversations.first(where: { $0.sessionId == source.sessionId || $0.id == source.conversationId }) {
                                    NavigationLink("Open conversation", value: DigestMessageRoute(conversation: conversation, messageID: source.id)).font(.footnote)
                                }
                                Divider()
                            }
                        }
                    }.padding().navigationTitle(first.sessionTitle)
                } else { Text("This source is no longer accessible or included.").padding().navigationTitle("Source unavailable") }
            }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: DigestMessageRoute.self) { route in ConversationView(conversation: route.conversation, initialMessageID: route.messageID) }
        case .event(let event, let proposal, let original, let series): DigestEventEditor(event: event, sources: sources, accountId: model.account?.accountId ?? "", contacts: model.contacts, proposal: proposal, original: original, series: series) { updated in try await model.saveDigestCalendarEvent(updated); await reloadAfterEdit(); if let date = DigestDate.eventDate(updated) { month = date; selectedCalendarDay = date }; pane = .calendar; calendarScrollRevision += 1 } remove: { if let series, let id = proposal?.existingSeriesId { try await model.removeDigestCalendarSeries(id, events: series) } else { try await model.removeDigestCalendarEvent(event) }; await reloadAfterEdit() }
        case .imports: DigestImportView(existing: events) { incoming in let report = try await model.importDigestCalendar(incoming); if let id = model.account?.accountId { await load(accountId: id) }; return report }
        case .connection: DigestConnectView(existing: events) { incoming in let report = try await model.importDigestCalendar(incoming); if let id = model.account?.accountId { await load(accountId: id) }; return report }
        case .details: ScrollView { VStack(alignment: .leading, spacing: 16) { Text("Updates follow your messages, sessions and calendar events."); Text("Open work stays in the digest until later evidence resolves it."); Text("\(sources.count) source messages are currently included. Only accessible sources may be opened.").foregroundStyle(.secondary) }.padding() }.navigationTitle("Live digest")
        }
    }
    private func reloadAfterEdit() async { selectedSheet = nil; if let account = model.account?.accountId { await load(accountId: account) } }
    private func load(accountId: String) async {
        loadRevision += 1
        let revision = loadRevision
        async let digestRead: Void = loadDigest(accountId: accountId, revision: revision)
        async let calendarRead: Void = loadCalendar(accountId: accountId, revision: revision)
        _ = await (digestRead, calendarRead)
    }
    private func loadDigest(accountId: String, revision: Int) async {
        do {
            let next = try await model.loadRollingDigest()
            try Task.checkCancellation()
            guard model.account?.accountId == accountId, revision == loadRevision else { return }
            digestLoadError = nil
            let accessibleIDs = Set(next.sources.map(\.id))
            if let sheet = selectedSheet {
                switch sheet {
                case .event(let event, _, _, let series) where !(series?.flatMap(\.sourceIds) ?? event.sourceIds).allSatisfy(accessibleIDs.contains): selectedSheet = nil
                case .event(let event, let proposal?, _, _) where event.revision == 0 && next.snapshot?.calendarCandidates.contains(where: { $0.id == proposal.id }) != true: selectedSheet = nil
                default: break
                }
            }
        } catch { if shouldRecordLoadError(error, accountId: accountId, revision: revision) { digestLoadError = error.localizedDescription } }
    }
    private func loadCalendar(accountId: String, revision: Int) async {
        do {
            let calendarResponse = try await model.loadDigestCalendar()
            let nextEvents = calendarResponse.events
            try Task.checkCancellation()
            guard model.account?.accountId == accountId, revision == loadRevision else { return }
            calendarLoadError = nil
            if let eventID = notifications.pendingCalendarEventID {
                pane = .calendar
                if let event = nextEvents.first(where: { $0.id == eventID }) { month = DigestDate.eventDate(event) ?? Date(); selectedSheet = .event(event) }
                notifications.consumeCalendarRoute()
            }
            if remoteReminders {
                await DigestCalendarService.clearReminders()
                await notifications.refreshAuthorizationState(registerIfAllowed: true)
                remindersAllowed = notifications.authorizationState.canRegisterForRemoteNotifications
            } else { remindersAllowed = try await DigestCalendarService.syncReminders(accountId: accountId, events: nextEvents, isCurrentAccount: { model.account?.accountId == accountId }) }
        } catch { if shouldRecordLoadError(error, accountId: accountId, revision: revision) { calendarLoadError = error.localizedDescription } }
    }
    private func shouldRecordLoadError(_ error: Error, accountId: String, revision: Int) -> Bool {
        CloudTransportErrorPolicy.shouldSurface(error, taskIsCancelled: Task.isCancelled)
            && revision == loadRevision && model.account?.accountId == accountId
    }
    private func refresh() async { isRefreshing = true; defer { isRefreshing = false }; await perform { try await model.refreshRollingDigest() }; if let id = model.account?.accountId { await load(accountId: id) } }
    private func requestReminders() async { if remoteReminders { await notifications.requestAuthorization(); remindersAllowed = notifications.authorizationState.canRegisterForRemoteNotifications; return }; guard let id = model.account?.accountId else { return }; await perform { remindersAllowed = try await DigestCalendarService.syncReminders(accountId: id, events: events, requestPermission: true, isCurrentAccount: { model.account?.accountId == id }) } }
    private func perform(_ operation: () async throws -> Void) async { do { try await operation(); error = nil } catch { self.error = error.localizedDescription } }
}
