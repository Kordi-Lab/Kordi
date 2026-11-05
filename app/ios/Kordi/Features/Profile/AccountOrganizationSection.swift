import SwiftUI

/// Draws the divider under the account header, then the organization switcher
/// when the account belongs to a team. Choosing an organization switches the
/// session token to it; the account and local data stay as they are.
struct AccountOrganizationSection: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var store = OrganizationSelectionStore.shared

    var body: some View {
        SettingsDivider()
            .task { await store.refresh(using: model) }
        if store.showsSwitcher {
            SettingsSectionTitle("Organization")
            ForEach(store.organizations) { organization in
                row(organization)
            }
            SettingsDivider()
        }
    }

    private func row(_ organization: CloudOrganization) -> some View {
        let isSelected = organization.organizationId == store.selectedOrganizationId
        return Button {
            store.select(organization.organizationId)
        } label: {
            HStack(spacing: 10) {
                CompactSettingsLabel(
                    title: organization.name,
                    systemImage: organization.isPersonal ? "person" : "person.2",
                    titleLineLimit: 1
                )
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(SettingsFont.action)
                        .foregroundStyle(.tint)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("settings-organization-\(organization.organizationId)")
    }
}
