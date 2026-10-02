import SwiftUI
import UIKit

/// "Waiting for you": calendar sharing and PiP suggestions that need this
/// person's answer, shown above the composer of the conversation they belong to.
struct PendingAgentActionsBanner: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let sessionId: String

    @State private var decidingActionIDs = Set<String>()
    @State private var errorsByActionID: [String: String] = [:]
    @State private var bannerError: String?
    @State private var announcedActionIDs = Set<String>()
    @State private var cardsHeight: CGFloat = 0

    private var actions: [CloudPendingAgentAction] {
        model.pendingAgentActions(for: sessionId).filter { PendingAgentActionCopy.make(for: $0) != nil }
    }

    var body: some View {
        if !actions.isEmpty || bannerError != nil {
            VStack(alignment: .leading, spacing: 10) {
                Text(PendingAgentActionCopy.regionLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                if let bannerError {
                    Text(bannerError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                // Several requests scroll inside the banner so the composer
                // and the latest messages stay on screen.
                ScrollView {
                    cards.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { cardsHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(cardsHeight, maxCardsHeight))
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(uiColor: .secondarySystemBackground),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(PendingAgentActionCopy.regionLabel)
            .onAppear { announceNewActions() }
            .onChange(of: actions.map(\.actionId)) { _, _ in announceNewActions() }
            .task(id: bannerError) {
                // A request that closed elsewhere leaves a short note, then the banner goes away.
                guard bannerError != nil else { return }
                try? await Task.sleep(for: .seconds(8))
                guard !Task.isCancelled else { return }
                bannerError = nil
            }
        }
    }

    /// Room for about one request at large text sizes and two at default sizes.
    private var maxCardsHeight: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 420 : 300
    }

    private var cards: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(actions) { action in
                if let copy = PendingAgentActionCopy.make(for: action) {
                    actionCard(action, copy: copy)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func actionCard(_ action: CloudPendingAgentAction, copy: PendingAgentActionCopy) -> some View {
        let isDeciding = decidingActionIDs.contains(action.actionId)
        return VStack(alignment: .leading, spacing: 6) {
            Text(copy.title)
                .font(.subheadline.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(copy.body)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            if let footnote = copy.footnote {
                Text(footnote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = errorsByActionID[action.actionId] {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            buttons(action, copy: copy, isDeciding: isDeciding)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private func buttons(_ action: CloudPendingAgentAction, copy: PendingAgentActionCopy, isDeciding: Bool) -> some View {
        let decline = Button {
            decide(action, .decline)
        } label: {
            Text(copy.declineLabel)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, minHeight: 44)
                .padding(.horizontal, 6)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(copy.declineAccessibilityLabel)

        let approve = Button {
            decide(action, .approve)
        } label: {
            Text(copy.approveLabel)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, minHeight: 44)
                .padding(.horizontal, 6)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityLabel(copy.approveAccessibilityLabel)

        // Large text stacks the buttons at full width so labels never truncate.
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) { approve; decline }
            } else {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    decline
                    approve
                }
            }
        }
        .disabled(isDeciding)
        .padding(.top, 2)
    }

    private func decide(_ action: CloudPendingAgentAction, _ decision: CloudAgentActionDecision) {
        guard !decidingActionIDs.contains(action.actionId) else { return }
        decidingActionIDs.insert(action.actionId)
        errorsByActionID[action.actionId] = nil
        bannerError = nil
        Task { @MainActor in
            defer { decidingActionIDs.remove(action.actionId) }
            if let error = await model.decidePendingAgentAction(action, decision: decision) {
                if model.pendingAgentActions(for: sessionId).contains(where: { $0.actionId == action.actionId }) {
                    errorsByActionID[action.actionId] = error
                } else {
                    bannerError = error
                }
                UIAccessibility.post(notification: .announcement, argument: error)
            } else {
                UIAccessibility.post(
                    notification: .announcement,
                    argument: PendingAgentActionCopy.announcement(for: action.kind, decision: decision)
                )
            }
        }
    }

    /// Announces newly arrived actions once, politely, without moving focus.
    private func announceNewActions() {
        let fresh = actions.filter { !announcedActionIDs.contains($0.actionId) }
        guard !fresh.isEmpty else { return }
        announcedActionIDs.formUnion(fresh.map(\.actionId))
        UIAccessibility.post(
            notification: .announcement,
            argument: PendingAgentActionCopy.arrivalAnnouncement(count: fresh.count)
        )
    }
}
