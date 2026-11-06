import SwiftUI

/// Profile › Permissions: what this person may do with your account.
struct ContactPermissionsView: View {
    @StateObject private var model: ContactPermissionsModel

    init(model: @autoclosure @escaping () -> ContactPermissionsModel) {
        _model = StateObject(wrappedValue: model())
    }

    init(appModel: AppModel, accountId: String, initial: CloudContactPermissions?) {
        self.init(model: appModel.makeContactPermissionsModel(accountId: accountId, initial: initial))
    }

    var body: some View {
        SettingsPage {
            if let error = model.errorMessage {
                SettingsErrorLabel(error)
                if model.permissions == nil {
                    Button("Try again") { Task { await model.loadIfNeeded() } }
                        .font(SettingsFont.action)
                        .frame(minHeight: SettingsMetrics.textRowMinHeight)
                        .disabled(model.isLoading)
                }
            }
            if let permissions = model.permissions {
                toggle("Use my agent", systemImage: "sparkles", isOn: permissions.agentAccess, field: .agent)
                    .accessibilityIdentifier("contact-permissions-agent")
                toggle("See my card", systemImage: "person.text.rectangle", isOn: permissions.cardAccess, field: .card)
                    .accessibilityIdentifier("contact-permissions-card")
            } else if model.isLoading || model.errorMessage == nil {
                SettingsLoadingRow("Loading…")
            }
        }
        .navigationTitle("Permissions")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadIfNeeded() }
    }

    private func toggle(
        _ title: String,
        systemImage: String,
        isOn: Bool,
        field: ContactPermissionsModel.Field
    ) -> some View {
        Toggle(isOn: Binding(
            get: { isOn },
            set: { value in Task { await model.set(field, to: value) } }
        )) {
            CompactSettingsLabel(title: title, systemImage: systemImage)
        }
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .disabled(model.savingFields.contains(field))
    }
}

/// The Permissions row when the profile offers it. The debug preview opens
/// the page once on its own.
struct ContactProfilePermissionsEntry: View {
    let presentation: ContactProfilePresentation
    @Binding var route: ContactProfileRoute?

    var body: some View {
        if presentation.showsPermissions {
            ContactProfilePermissionsRow { route = .permissions }
                .task(id: presentation.profile != nil) {
                    guard presentation.profile != nil else { return }
                    if ContactPermissionsAvailability.opensPreviewPage(for: presentation.subject) { route = .permissions }
                }
        }
    }
}

/// The "Permissions" row on a person's profile.
struct ContactProfilePermissionsRow: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "hand.raised")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                Text("Permissions")
                    .font(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                SettingsChevron()
            }
            .padding(.leading, ContactProfileMetrics.gutter)
            .padding(.trailing, 16)
            .frame(minHeight: ContactProfileMetrics.sharedRowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 24)
        .accessibilityIdentifier("contact-profile-permissions")
    }
}
