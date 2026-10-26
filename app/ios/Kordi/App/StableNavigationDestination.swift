import SwiftUI

extension View {
    /// `navigationDestination(item:)` attached to an empty background instead
    /// of wrapping this view.
    ///
    /// Inside a `NavigationStack` that lives in a child `UIHostingController`,
    /// which is every screen `MainNavigationHost` pushes, wrapping a view with
    /// `navigationDestination(item:)` makes SwiftUI rebuild that view's sheets
    /// and full-screen covers with fresh state whenever the view updates (#2094).
    /// The `isPresented:` variant does not do this. Use this helper instead of
    /// `navigationDestination(item:)` so presentations keep their state.
    func stableNavigationDestination<Item: Hashable, Destination: View>(
        item: Binding<Item?>,
        @ViewBuilder destination: @escaping (Item) -> Destination
    ) -> some View {
        background {
            Color.clear
                .accessibilityHidden(true)
                .navigationDestination(item: item, destination: destination)
        }
    }
}
