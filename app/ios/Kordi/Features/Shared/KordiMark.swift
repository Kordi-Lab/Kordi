import SwiftUI

struct KordiMark: View {
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            Circle()
                .fill(KordiTheme.brandPink.opacity(0.94))
                .frame(width: size * 0.58, height: size * 0.58)
                .offset(y: -size * 0.15)

            Circle()
                .fill(KordiTheme.brandCyan.opacity(0.94))
                .frame(width: size * 0.58, height: size * 0.58)
                .offset(x: -size * 0.17, y: size * 0.15)

            Circle()
                .fill(KordiTheme.brandAmber.opacity(0.92))
                .frame(width: size * 0.58, height: size * 0.58)
                .offset(x: size * 0.17, y: size * 0.15)
        }
        .frame(width: size, height: size)
        .compositingGroup()
        .accessibilityHidden(true)
    }
}
