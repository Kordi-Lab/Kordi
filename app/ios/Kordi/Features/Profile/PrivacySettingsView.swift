import SwiftUI

struct PrivacySettingsView: View {
    @AppStorage(LinkPreviewSetting.storageKey) private var linkPreviewRawValue = LinkPreviewSetting.contacts.rawValue
    @AppStorage(PrivacyCoverController.storageKey) private var hidesInAppSwitcher = true
    @AppStorage(MessageClipboard.storageKey) private var limitsCopiedMessages = true

    static let appSwitcherFooter = "When you leave Kordi or open the app switcher, Kordi shows a blank screen instead of your conversations."
    static let clipboardFooter = "Message text you copy stays on this iPhone and clears from the clipboard after 10 minutes. Turn this off to paste copied messages on your other Apple devices."
    static let localMessagesText = "Kordi keeps copies of recent messages and downloaded files on this iPhone so they open quickly. Saved messages can't be read until you unlock this iPhone for the first time after it restarts. Downloaded photos, videos, and documents can't be opened while this iPhone is locked. Kordi's message cache is left out of iCloud and computer backups."

    static func linkPreviewFooter(for setting: LinkPreviewSetting) -> String {
        let summary = switch setting {
        case .contacts:
            "Kordi loads previews and site icons only for links you send and links from people in your contacts. Other links show just the web address."
        case .everyone:
            "Kordi loads previews and site icons for every link, including links from agents and from people who aren't in your contacts."
        case .off:
            "Kordi doesn't load link previews or site icons. Links show just the web address."
        }
        return summary + " Loading a preview connects this iPhone to the linked website, which can see your IP address and when the link was viewed."
    }

    private var linkPreviewSetting: Binding<LinkPreviewSetting> {
        Binding(
            get: { LinkPreviewSetting(storedValue: linkPreviewRawValue) },
            set: { linkPreviewRawValue = $0.rawValue }
        )
    }

    var body: some View {
        List {
            Section {
                Picker("Link previews", selection: linkPreviewSetting) {
                    ForEach(LinkPreviewSetting.allCases) { setting in
                        Text(setting.title).tag(setting)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("Link previews")
            } footer: {
                Text(Self.linkPreviewFooter(for: linkPreviewSetting.wrappedValue))
            }

            Section {
                Toggle("Hide conversations in app switcher", isOn: $hidesInAppSwitcher)
            } header: {
                Text("App switcher")
            } footer: {
                Text(Self.appSwitcherFooter)
            }

            Section {
                Toggle("Limit copied messages", isOn: $limitsCopiedMessages)
            } header: {
                Text("Clipboard")
            } footer: {
                Text(Self.clipboardFooter)
            }

            Section("Messages on this iPhone") {
                Text(Self.localMessagesText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Privacy")
        .navigationBarTitleDisplayMode(.inline)
    }
}
