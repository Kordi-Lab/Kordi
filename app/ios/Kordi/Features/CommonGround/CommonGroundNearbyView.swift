import SwiftUI
import UIKit

/// Grounding › Pair › Nearby. Off: one line and Turn on. On: the card being
/// shared, the location status, Open to, People, Looking for and Alerts.
/// While it shows, the list polls (every 3 s while people are being
/// matched, else every 30 s) and this iPhone sends its location.
struct CommonGroundNearbyView: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.kordiChatTheme) private var chatTheme
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var locator = CommonGroundNearbyLocator.shared
    @Binding var path: [CommonGroundRoute]
    @State private var consenting = false
    @State private var editing: CommonGroundNearbyNeedTarget?
    /// Turned on in the sheet with this choice of background alerts; location
    /// access is asked for once the sheet has closed.
    @State private var accessAfterConsent: Bool?
    @State private var visible = false

    private var settings: CommonGroundNearbySettings? { model.nearby.settings }

    var body: some View {
        Group {
            if let settings, settings.enabled {
                onPage(settings)
            } else if settings != nil {
                offPage
            } else {
                CommonGroundPage {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 120)
                }
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await model.loadNearby()
            await model.loadNearbyNeeds()
            await model.pollNearby()
        }
        .onAppear { visible = true; startLocation() }
        .onDisappear { visible = false; locator.stopForeground() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { startLocation() } }
        .onChange(of: model.nearbySharing) { _, _ in startLocation() }
        .onChange(of: locator.postCount) { _, _ in
            Task { await model.nearbyLocationPosted(locator.lastReply) }
        }
        .sheet(isPresented: $consenting, onDismiss: afterConsent) {
            CommonGroundNearbyConsentSheet { background in accessAfterConsent = background }
                .environmentObject(model)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $editing) { target in
            CommonGroundNearbyRequestSheet(need: target.need, defaultRange: settings?.range ?? 2000)
                .environmentObject(model)
                .presentationDetents(target.need == nil ? [.medium, .large] : [.large])
                .presentationDragIndicator(.visible)
        }
    }

    // MARK: Off

    private var offPage: some View {
        CommonGroundPage {
            VStack(spacing: 0) {
                Image(systemName: "mappin.and.ellipse")
                    .font(.system(size: 32))
                    .foregroundStyle(chatTheme.accent)
                    .frame(width: 76, height: 76)
                    .background(chatTheme.accent.opacity(0.13), in: Circle())
                    .accessibilityHidden(true)
                Text("Nearby")
                    .font(.system(size: 24, weight: .bold))
                    .padding(.top, 18)
                    .accessibilityAddTraits(.isHeader)
                Text("See people near you who share a card.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                Button("Turn on") { consenting = true }
                    .buttonStyle(CommonGroundPrimaryButtonStyle())
                    .padding(.top, 28)
            }
            .multilineTextAlignment(.center)
            .padding(.horizontal, 20)
            .padding(.top, 76)
        }
    }

    // MARK: On

    private func onPage(_ settings: CommonGroundNearbySettings) -> some View {
        CommonGroundPage {
            VStack(spacing: 8) {
                CommonGroundNearbyCardChip()
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    statusLine(status(settings, now: context.date), now: context.date)
                }
            }
            .padding(.horizontal, 16)
            VStack(spacing: 24) {
                CommonGroundNearbyOpenToSection()
                if !settings.isPaused() {
                    CommonGroundNearbyPeopleSection(
                        status: status(settings, now: .now),
                        onOpen: { path.append(.nearbyPerson($0)) },
                        onSettings: openSettings
                    )
                }
                CommonGroundNearbyNeedsSection { editing = CommonGroundNearbyNeedTarget(need: $0) }
                CommonGroundNearbyAlertsSection()
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
        }
        .overlay(alignment: .top) {
            Text("Nearby")
                .font(.headline)
                .frame(height: 44)
                .safeAreaPadding(.top, 8)
                .allowsHitTesting(false)
                .accessibilityAddTraits(.isHeader)
        }
        .overlay(alignment: .topTrailing) { moreMenu(settings) }
    }

    private func status(_ settings: CommonGroundNearbySettings, now: Date) -> CommonGroundNearbyStatus {
        let stale = settings.location?.fresh == false || (model.nearby.noLocation && settings.location != nil)
        return CommonGroundNearbyStatus.resolve(
            pausedUntil: settings.pausedUntilDate,
            access: locator.access,
            precise: locator.precise,
            backgroundAlerts: locator.backgroundAlerts,
            refreshAvailable: locator.refreshAvailable,
            stale: stale && !locator.posting,
            updated: locator.lastReply?.captured ?? settings.location?.captured,
            now: now
        )
    }

    @ViewBuilder
    private func statusLine(_ status: CommonGroundNearbyStatus, now: Date) -> some View {
        switch status {
        case .paused(let until):
            statusText(CommonGroundNearbyStatus.pausedLine(until, now: now), link: "Resume") {
                Task { await model.resumeNearby() }
            }
        case .denied:
            EmptyView()
        case .imprecise:
            statusText("Precise location is off", link: "Settings", action: openSettings)
        case .stale:
            statusText("Location is out of date", link: "Update") { locator.updateNow() }
        case .foregroundOnly:
            if locator.access == .always && locator.refreshAvailable {
                statusText("Only while Kordi is open")
            } else {
                statusText("Only while Kordi is open", link: "Settings", action: openSettings)
            }
        case .background(let updated):
            statusText(CommonGroundNearbyStatus.updatedLine(updated, now: now))
        }
    }

    private func statusText(_ text: String, link: String? = nil, action: @escaping () -> Void = {}) -> some View {
        HStack(spacing: 4) {
            Text(text).foregroundStyle(.secondary)
            if let link {
                Button(link, action: action)
                    .fontWeight(.semibold)
                    .foregroundStyle(chatTheme.accent)
                    .buttonStyle(.plain)
            }
        }
        .font(.footnote)
        .multilineTextAlignment(.center)
    }

    private func moreMenu(_ settings: CommonGroundNearbySettings) -> some View {
        Menu {
            if settings.isPaused() {
                Button("Resume") { Task { await model.resumeNearby() } }
            } else {
                Button("Pause for 1 hour") { Task { await model.pauseNearby(untilTomorrow: false) } }
                Button("Pause until tomorrow") { Task { await model.pauseNearby(untilTomorrow: true) } }
            }
            Divider()
            Button("Turn off", role: .destructive) { Task { await model.turnOffNearby() } }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 44, height: 44)
                .sessionGlass(in: Circle())
                .contentShape(Circle())
        }
        .accessibilityLabel("More")
        .padding(.trailing, 16)
        .safeAreaPadding(.top, 8)
    }

    // MARK: Location

    private func startLocation() {
        guard visible, scenePhase == .active, model.nearbySharing else { return }
        locator.startForeground()
    }

    private func afterConsent() {
        guard let background = accessAfterConsent else { return }
        accessAfterConsent = nil
        Task {
            await locator.requestAccess(background: background)
            startLocation()
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// The request sheet's subject: an existing request, or nil for a new one.
struct CommonGroundNearbyNeedTarget: Identifiable {
    let need: CommonGroundNearbyNeed?
    let id = UUID()
}
