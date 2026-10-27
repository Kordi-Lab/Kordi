//! Boring Avatars Marble, ported from boringdesigners/boring-avatars at
//! d0ff2582a8921b643a89de4a4912be28938a828b (src/lib/components/avatar-marble.tsx
//! and src/lib/utilities.ts). See boring-avatars-LICENSE for the MIT license.
//! Square output leaves clipping to each client's avatar container.

pub(super) const STYLE: &str = "boring-marble-v1";
const COLORS: [&str; 5] = ["#DCE4E8", "#526779", "#9CB7B3", "#C9B8A8", "#79879C"];

fn hash_code(seed: &str) -> i64 {
    // Match JavaScript's signed 32-bit hash over UTF-16 code units, including MIN.
    let hash = seed.encode_utf16().fold(0_i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    });
    i64::from(hash).abs()
}

fn unit(number: i64, range: i64, digit: u32) -> i64 {
    let value = number % range;
    if (number / 10_i64.pow(digit)) % 10 % 2 == 0 {
        -value
    } else {
        value
    }
}

pub(super) fn render_svg(seed: &str) -> String {
    let hash = hash_code(seed);
    let color = |index: i64| COLORS[((hash + index) % COLORS.len() as i64) as usize];
    let transform = |index: i64| {
        let number = hash * (index + 1);
        // Upstream uses the third element's scale for both paths.
        let scale = 1.2 + (hash * 3 % 4) as f64 / 10.0;
        format!(
            "translate({} {}) rotate({} 40 40) scale({scale:.1})",
            unit(number, 8, 1),
            unit(number, 8, 2),
            unit(number, 360, 1)
        )
    };
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80" fill="none">
<rect width="80" height="80" fill="{}"/>
<path filter="url(#blur)" d="M32.414 59.35L50.376 70.5H72.5v-71H33.728L26.5 13.381l19.057 27.08L32.414 59.35z" fill="{}" transform="{}"/>
<path filter="url(#blur)" style="mix-blend-mode:overlay" d="M22.216 24L0 46.75l14.108 38.129L78 86l-3.081-59.276-22.378 4.005 12.972 20.186-23.35 27.395L22.215 24z" fill="{}" transform="{}"/>
<defs><filter id="blur" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="7" result="effect1_foregroundBlur"/></filter></defs>
</svg>"##,
        color(0),
        color(1),
        transform(1),
        color(2),
        transform(2)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_upstream_javascript_hash_and_transforms() {
        assert_eq!(hash_code("acct_123"), 2_133_244_922);
        let svg = render_svg("acct_123");
        assert!(svg.contains("translate(-4 -4) rotate(-244 40 40) scale(1.4)"));
        assert!(svg.contains("translate(-6 6) rotate(-6 40 40) scale(1.4)"));
        assert!(!svg.contains("acct_123"));
    }
}
