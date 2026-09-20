import SwiftUI

/// A plan card posted by PiP. The same card type shows either the vote
/// between options or the calendar card for the plan itself; buttons act for
/// the signed-in member and the returned snapshot shows at once, until the
/// transcript carries a newer one.
struct PlanCardView: View {
    let card: PlanCard
    let ownAccountId: String?
    let onAction: ((PlanCardAction) async -> PlanCard?)?

    @State private var current: PlanCard?
    @State private var busy = false
    @State private var pendingCard: PlanCard?
    @State private var notice: String?
    @State private var peopleSheet: PlanCardPeopleSheet.Content?

    private var view: PlanCard {
        if busy, let pendingCard, pendingCard.eventId == card.eventId { return pendingCard }
        if let current, current.eventId == card.eventId, current.revision > card.revision { return current }
        return card
    }
    private var me: PlanCardParticipant? { view.participant(ownAccountId) }
    private var isVote: Bool { (busy ? pendingCard ?? card : card).cardView == .vote }
    private var votingOpen: Bool { isVote && view.isPolling }
    private var canRespond: Bool { !isVote && me != nil && view.state != .canceled && onAction != nil }
    private var canConfirm: Bool {
        guard (me?.organizer ?? false) || view.managerIds.contains(ownAccountId ?? ""), onAction != nil else { return false }
        return isVote ? votingOpen && view.leadingOption != nil : view.state == .awaitingConfirmation
    }
    private var onCalendar: Bool {
        !isVote && view.state == .confirmed && me?.rsvp == .yes && view.startDate != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if isVote {
                voteBody
            } else {
                eventBody
            }
            if let notice = notice ?? view.calendarHint(ownAccountId: ownAccountId, isVote: isVote, canConfirm: canConfirm) {
                Label(notice, systemImage: self.notice == nil ? "info.circle" : "exclamationmark.circle")
                    .font(.system(size: 12))
                    .foregroundStyle(self.notice == nil ? Color.secondary : Color.red)
            }
        }
        .padding(12)
        .frame(minWidth: 250, maxWidth: 300, alignment: .leading)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.primary.opacity(0.06)))
        .shadow(color: .black.opacity(0.06), radius: 10, y: 3)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(isVote ? "Vote" : "Plan"), \(view.title), \(statusLabel)")
        .onChange(of: card) { _, latest in
            if let current, latest.revision >= current.revision { self.current = nil }
        }
        .sheet(item: $peopleSheet) { content in
            PlanCardPeopleSheet(content: content, ownAccountId: ownAccountId)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: headerSymbol)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(isVote ? "Vote" : "Plan")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 6)
                    Text(statusLabel)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(tint.opacity(0.14), in: Capsule())
                        .fixedSize()
                }
                Text(view.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(view.state == .canceled ? .secondary : .primary)
                    .strikethrough(view.state == .canceled)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var headerSymbol: String {
        if isVote { return "checklist" }
        switch view.state {
        case .confirmed: return "calendar.badge.checkmark"
        case .canceled: return "calendar.badge.exclamationmark"
        default: return "calendar"
        }
    }

    private var statusLabel: String {
        if isVote {
            return votingOpen ? "Voting" : view.state == .canceled ? "Canceled" : "Decided"
        }
        switch view.state {
        case .confirmed: return "Confirmed"
        case .awaitingConfirmation: return "Almost set"
        case .polling: return "Planning"
        case .canceled: return "Canceled"
        case .unknown: return "Plan"
        }
    }

    private var tint: Color {
        if isVote {
            return votingOpen ? Color(red: 0.36, green: 0.36, blue: 0.86) : view.state == .canceled ? .red : Color(red: 0.13, green: 0.60, blue: 0.38)
        }
        switch view.state {
        case .confirmed: return Color(red: 0.13, green: 0.60, blue: 0.38)
        case .awaitingConfirmation: return Color(red: 0.85, green: 0.47, blue: 0.02)
        case .canceled: return .red
        default: return Color(red: 0.36, green: 0.36, blue: 0.86)
        }
    }

    // MARK: Calendar card

    @ViewBuilder
    private var eventBody: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let start = view.startDate {
                detailRow("calendar", "\(start.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))) · \(timeLabel(start))")
            }
            if let location = view.location, !location.isEmpty {
                detailRow("mappin.and.ellipse", location)
            }
            if !view.unresolvedFields.isEmpty {
                detailRow("questionmark.circle", "Still open: \(view.unresolvedFields.joined(separator: ", "))")
            }
        }

        if !view.participants.isEmpty {
            Divider().opacity(0.6)
            attendees
        }

        if canRespond, let accountId = ownAccountId {
            HStack(spacing: 8) {
                responseButton(
                    title: "Can't make it",
                    symbol: "xmark",
                    selected: me?.rsvp == .no,
                    selectedTint: .red,
                    prominent: false
                ) {
                    await perform(.rsvp(view, accountId: accountId, going: false))
                }
                responseButton(
                    title: me?.rsvp == .yes ? "You're in" : "I'm in",
                    symbol: "checkmark",
                    selected: me?.rsvp == .yes,
                    selectedTint: Color(red: 0.13, green: 0.60, blue: 0.38),
                    prominent: true
                ) {
                    await perform(.rsvp(view, accountId: accountId, going: true))
                }
            }
        }

        if canConfirm, let accountId = ownAccountId {
            primaryButton("Confirm plan") {
                await perform(.confirm(view, accountId: accountId))
            }
        }

        if onCalendar {
            Label("On your calendar", systemImage: "calendar.badge.checkmark")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color(red: 0.13, green: 0.60, blue: 0.38))
        }
    }

    private func detailRow(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 16)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(.primary.opacity(0.85))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func timeLabel(_ start: Date) -> String {
        let startText = "\(start.formatted(date: .omitted, time: .shortened)) \(TimeZone.current.abbreviation(for: start) ?? TimeZone.current.identifier)"
        guard let end = view.endAt.flatMap(PlanCard.parseDate) else { return startText }
        return "\(startText) – \(end.formatted(date: .omitted, time: .shortened)) \(TimeZone.current.abbreviation(for: end) ?? TimeZone.current.identifier)"
    }

    /// Scales to any group size: a few avatars with short counts on the card,
    /// and the full, searchable list in a sheet.
    private var attendees: some View {
        let going = view.participants.filter { $0.rsvp == .yes }
        let declined = view.participants.filter { $0.rsvp == .no }
        let waiting = view.participants.filter { $0.rsvp == .pending }
        let shown = Array((going + waiting + declined).prefix(4))
        let hidden = view.participants.count - shown.count
        return Button {
            peopleSheet = .attendees(title: view.title, going: going, declined: declined, waiting: waiting)
        } label: {
            HStack(spacing: 8) {
                HStack(spacing: -6) {
                    ForEach(shown) { participant in
                        attendeeAvatar(participant)
                    }
                    if hidden > 0 {
                        Text("+\(Self.compactCount(hidden))")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 22, minHeight: 22)
                            .padding(.horizontal, hidden > 9 ? 3 : 0)
                            .background(Color(uiColor: .systemGray5), in: Capsule())
                            .overlay(Capsule().strokeBorder(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
                    }
                }
                Text(countsLine(going: going.count, declined: declined.count, waiting: waiting.count))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(countsLine(going: going.count, declined: declined.count, waiting: waiting.count))
        .accessibilityHint("Shows everyone and their answer")
    }

    private func countsLine(going: Int, declined: Int, waiting: Int) -> String {
        var parts = ["\(Self.compactCount(going)) going"]
        if declined > 0 { parts.append("\(Self.compactCount(declined)) can't") }
        if waiting > 0 { parts.append("\(Self.compactCount(waiting)) no reply") }
        return parts.joined(separator: " · ")
    }

    static func compactCount(_ value: Int) -> String {
        value >= 1_000 ? String(format: "%.1fk", Double(value) / 1_000).replacingOccurrences(of: ".0k", with: "k") : "\(value)"
    }

    private func attendeeAvatar(_ participant: PlanCardParticipant) -> some View {
        IdentityAvatar(
            name: participant.displayName,
            imageSource: participant.avatarUrl?.nonEmpty,
            kind: .person,
            size: 22,
            seed: participant.participantId
        )
        .overlay(Circle().strokeBorder(Color(uiColor: .secondarySystemGroupedBackground), lineWidth: 2))
        .opacity(participant.rsvp == .no ? 0.5 : 1)
    }

    // MARK: Vote card

    @ViewBuilder
    private var voteBody: some View {
        Text(voteCaption)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.top, -4)

        VStack(spacing: 6) {
            ForEach(view.options) { option in
                optionRow(option)
            }
        }

        if canConfirm, let accountId = ownAccountId, let leading = view.leadingOption {
            primaryButton("Confirm top choice") {
                await perform(.confirm(view, accountId: accountId, optionId: leading.id))
            }
        }
    }

    private var voteCaption: String {
        let voters = Set(view.options.flatMap(\.votes)).count
        let total = view.participants.count
        return voters == 0 ? "No votes yet" : "\(Self.compactCount(voters)) of \(Self.compactCount(total)) voted"
    }

    private var totalVotes: Int { view.options.reduce(0) { $0 + $1.votes.count } }

    private func percent(_ option: PlanCardOption) -> Int {
        totalVotes == 0 ? 0 : Int((Double(option.votes.count) / Double(totalVotes) * 100).rounded())
    }

    private func optionRow(_ option: PlanCardOption) -> some View {
        let mine = ownAccountId.map { option.votes.contains($0) } ?? false
        let share = percent(option)
        let winner = !votingOpen && view.state == .confirmed && view.leadingOption?.id == option.id
        let accent = winner ? Color(red: 0.13, green: 0.60, blue: 0.38) : Color(red: 0.36, green: 0.36, blue: 0.86)
        return HStack(spacing: 9) {
            ZStack {
                Circle()
                    .strokeBorder(mine || winner ? accent : Color.secondary.opacity(0.5), lineWidth: 1.5)
                if mine || winner {
                    Circle().fill(accent).padding(0.5)
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: 18, height: 18)
            Text(option.label)
                .font(.system(size: 13, weight: winner ? .semibold : .regular))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            Text("\(share)%")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(mine || winner ? accent : .secondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .leading) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Color(uiColor: .tertiarySystemFill)
                    accent.opacity(mine || winner ? 0.20 : 0.10)
                        .frame(width: proxy.size.width * CGFloat(share) / 100)
                        .animation(.easeOut(duration: 0.25), value: share)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(mine || winner ? accent.opacity(0.7) : Color.clear, lineWidth: 1.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .opacity(busy ? 0.6 : 1)
        .onTapGesture {
            guard votingOpen, !busy, let accountId = ownAccountId, me != nil, onAction != nil else { return }
            Task { await perform(.vote(view, accountId: accountId, optionId: option.id)) }
        }
        .onLongPressGesture(minimumDuration: 0.35) {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            peopleSheet = .voters(option: option.label, voters: voters(of: option))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(option.label), \(share) percent\(mine ? ", your vote" : "")\(winner ? ", chosen" : "")")
        .accessibilityAction(named: "See who voted") {
            peopleSheet = .voters(option: option.label, voters: voters(of: option))
        }
    }

    private func voters(of option: PlanCardOption) -> [PlanCardParticipant] {
        let byId = Dictionary(uniqueKeysWithValues: view.participants.map { ($0.participantId, $0) })
        return option.votes.map { id in
            byId[id] ?? PlanCardParticipant(participantId: id, displayName: "Member", organizer: false, rsvp: .pending)
        }
    }

    // MARK: Buttons

    private func responseButton(
        title: String,
        symbol: String,
        selected: Bool,
        selectedTint: Color,
        prominent: Bool,
        action: @escaping () async -> Void
    ) -> some View {
        let accent = Color.accentColor
        let foreground: Color = selected ? selectedTint : (prominent ? .white : .primary)
        let background: Color = selected ? selectedTint.opacity(0.14) : (prominent ? accent : Color(uiColor: .tertiarySystemFill))
        return Button {
            Task { await action() }
        } label: {
            Label(title, systemImage: symbol)
                .font(.system(size: 13, weight: .semibold))
                .labelStyle(.titleAndIcon)
                .foregroundStyle(foreground)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background(background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(selected ? selectedTint.opacity(0.45) : Color.clear, lineWidth: 1)
                )
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.6 : 1)
    }

    private func primaryButton(_ title: String, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(busy || !view.hasConfirmationTime(isVote: isVote))
        .opacity(busy || !view.hasConfirmationTime(isVote: isVote) ? 0.6 : 1)
    }

    // MARK: Helpers

    private func perform(_ action: PlanCardAction) async {
        guard !busy, let onAction else { return }
        var displayed = view
        displayed.view = isVote ? "vote" : "event"
        pendingCard = displayed
        busy = true
        notice = nil
        defer {
            pendingCard = nil
            busy = false
        }
        if let updated = await onAction(action) {
            current = updated
        } else {
            notice = "Could not update the plan. Try again."
        }
    }

    private func name(of accountId: String) -> String {
        if accountId == ownAccountId { return "You" }
        return view.participants.first { $0.participantId == accountId }?.displayName ?? "Member"
    }
}

/// Everyone on a plan, or everyone who chose an option, in a searchable list
/// that stays fast for groups of any size.
struct PlanCardPeopleSheet: View {
    enum Content: Identifiable {
        case attendees(title: String, going: [PlanCardParticipant], declined: [PlanCardParticipant], waiting: [PlanCardParticipant])
        case voters(option: String, voters: [PlanCardParticipant])

        var id: String {
            switch self {
            case .attendees(let title, _, _, _): return "attendees:\(title)"
            case .voters(let option, _): return "voters:\(option)"
            }
        }
    }

    let content: Content
    let ownAccountId: String?
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    private var sections: [(String, [PlanCardParticipant])] {
        switch content {
        case .attendees(_, let going, let declined, let waiting):
            return [("Going", going), ("Can't make it", declined), ("No reply", waiting)]
        case .voters(_, let voters):
            return [("Voted", voters)]
        }
    }

    private var title: String {
        switch content {
        case .attendees(let title, _, _, _): return title
        case .voters(let option, _): return option
        }
    }

    private func filtered(_ people: [PlanCardParticipant]) -> [PlanCardParticipant] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return people }
        return people.filter { $0.displayName.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.0) { section in
                    let people = filtered(section.1)
                    if !people.isEmpty {
                        Section("\(section.0) · \(PlanCardView.compactCount(section.1.count))") {
                            ForEach(people) { person in
                                HStack(spacing: 10) {
                                    IdentityAvatar(
                                        name: person.displayName,
                                        imageSource: person.avatarUrl?.nonEmpty,
                                        kind: .person,
                                        size: 30,
                                        seed: person.participantId
                                    )
                                    Text(person.participantId == ownAccountId ? "\(person.displayName) (you)" : person.displayName)
                                        .font(.system(size: 15))
                                    Spacer()
                                    if person.organizer {
                                        Text("Organizer")
                                            .font(.system(size: 11))
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: "Search people")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Minimal wrapping row for participant chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
