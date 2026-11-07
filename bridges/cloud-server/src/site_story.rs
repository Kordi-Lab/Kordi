//! The kordi.ai log-in and sign-up layout for pages the server renders: the
//! home page's navigation above a panel that says what Kordi is (headline,
//! line, faint leaves and two slow columns of product captures) beside one
//! narrow card.
//!
//! The styles are a server-owned copy of the home page's layout, so the page
//! keeps its shape on servers that do not also serve the home page. The
//! leaves and captures load from the home page's `/assets/public/auth/` files
//! on the same origin; they are decoration, hidden from assistive technology
//! and dropped on phones. The motion stops under `prefers-reduced-motion`,
//! and a checkbox styled as the home page's round button pauses it without
//! a script.

/// The home page's headline and line, word for word.
pub(crate) const STORY_HEADLINE_LEAD: &str = "Build the next";
pub(crate) const STORY_HEADLINE_EMPHASIS: &str = "supercollaboration.";
pub(crate) const STORY_LINE: &str =
    "Every communication in one place, with AI that is proactive and cooperative.";

/// Layout for `<body class="interior-page x-auth-page">`, loaded after
/// [`crate::site_page::SITE_CSS`].
pub(crate) const STORY_CSS: &str = r#"
    :root { --rule-strong: #d6c6bf; }
    .x-auth-page .wrap { width: min(100%, 1440px); padding-inline: clamp(20px, 4vw, 56px); }
    .skip { position: absolute; top: -80px; left: 1rem; z-index: 4; }
    .skip:focus { top: .5rem; background: var(--paper); }
    .x-auth-page .mast { justify-content: space-between; flex-wrap: wrap; gap: .45rem 1rem; }
    .mast nav { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem 1rem; }
    .mast nav a { min-height: 44px; display: inline-flex; align-items: center; color: var(--ink); font-size: .9375rem; text-decoration: none; white-space: nowrap; }
    .mast nav a:hover { color: var(--muted); }
    .nav-accounts { display: inline-flex; align-items: center; gap: 12px; }
    .mast .nav-login, .mast .nav-signup { justify-content: center; padding: 8px 20px; border-radius: 999px; color: var(--ink); font-weight: 500; }
    .mast .nav-signup { border: 1px solid var(--ink); }
    .mast .nav-login:hover, .mast .nav-signup:hover { color: var(--ink); background: var(--selected); }

    .x-story { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(400px, .88fr); grid-template-rows: auto minmax(0, 1fr); grid-template-areas: "copy form" "reel form"; min-height: max(640px, calc(100vh - 68px)); padding: 8px 24px 24px; }
    .x-story-panel { position: relative; grid-area: 1 / 1 / 3 / 2; overflow: hidden; border-radius: 24px; background: var(--paper-alt); }
    .x-story-leaf { position: absolute; height: auto; pointer-events: none; }
    .x-story-leaf-sprig { top: -18px; right: -28px; width: 300px; transform: rotate(-8deg); }
    .x-story-leaf-fern { bottom: -30px; left: -46px; width: 190px; transform: rotate(14deg); opacity: .8; }
    .x-story-copy { position: relative; z-index: 1; grid-area: copy; padding: clamp(40px, 5vw, 64px) clamp(32px, 4.5vw, 64px) 28px; }
    .x-story-headline { color: var(--ink); font-size: clamp(2.25rem, 1.2rem + 2.6vw, 3.75rem); font-weight: 600; line-height: 1.06; letter-spacing: -.05em; text-wrap: balance; }
    .x-story-headline span { color: var(--cardinal); white-space: nowrap; }
    .x-story-line { max-width: 40ch; margin-top: 18px; color: var(--muted); font-size: clamp(1rem, .95rem + .3vw, 1.1875rem); line-height: 1.55; text-wrap: pretty; }
    .x-story > .x-auth { grid-area: form; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px clamp(24px, 4vw, 72px); }
    .x-auth-card { width: min(100%, 400px); }

    .x-story-reel { position: relative; z-index: 1; grid-area: reel; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; min-height: 360px; margin: 0 clamp(32px, 4.5vw, 64px); overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 64px, #000 calc(100% - 64px), transparent 100%); mask-image: linear-gradient(to bottom, transparent 0, #000 64px, #000 calc(100% - 64px), transparent 100%); }
    .x-story-col { position: relative; min-width: 0; }
    .x-story-track { position: absolute; inset: 0 0 auto; display: grid; gap: 20px; padding-bottom: 20px; }
    .x-story-track img { display: block; width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 12px; background: #fff; box-shadow: 0 1px 2px #1918170a, 0 12px 32px #19181712; }
    @keyframes x-story-up { from { transform: translateY(0); } to { transform: translateY(-50%); } }
    @keyframes x-story-down { from { transform: translateY(-50%); } to { transform: translateY(0); } }
    .x-story-col:first-child .x-story-track { animation: x-story-up 110s linear infinite; }
    .x-story-col:last-child .x-story-track { animation: x-story-down 130s linear -48s infinite; }
    .x-story-toggle:checked ~ .x-story-reel .x-story-track { animation-play-state: paused; }

    .x-story-toggle { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
    .x-story-motion { position: relative; z-index: 3; grid-area: reel; align-self: end; justify-self: end; display: grid; place-items: center; width: 36px; height: 36px; margin: 0 18px 18px 0; border: 1px solid var(--rule); border-radius: 50%; background: var(--paper); color: var(--muted); cursor: pointer; transition: color 120ms ease, border-color 120ms ease; }
    .x-story-motion:hover { color: var(--ink); border-color: var(--rule-strong); }
    .x-story-toggle:focus-visible + .x-story-motion { outline: 2px solid var(--cardinal); outline-offset: 2px; }
    .x-story-motion svg { width: 14px; height: 14px; }
    .x-story-motion .x-story-play, .x-story-toggle:checked + .x-story-motion .x-story-pause { display: none; }
    .x-story-toggle:checked + .x-story-motion .x-story-play { display: block; }

    @media (prefers-reduced-motion: reduce) {
      .x-story-track { animation: none !important; }
      .x-story-toggle, .x-story-motion { display: none; }
    }
    @media (max-width: 1100px) {
      .x-story { grid-template-columns: minmax(0, 1fr) minmax(380px, 1fr); }
      .x-story-reel { grid-template-columns: 1fr; }
      .x-story-col:last-child { display: none; }
    }
    @media (max-width: 760px) {
      .x-story { display: block; min-height: 0; padding: 0; }
      .x-story-panel, .x-story-reel, .x-story-toggle, .x-story-motion { display: none; }
      .x-story-copy { padding: 28px 16px 0; text-align: center; }
      .x-story-headline { font-size: clamp(1.625rem, 7.4vw, 2rem); letter-spacing: -.045em; }
      .x-story-line { max-width: 32ch; margin: 8px auto 0; font-size: .9375rem; line-height: 1.5; }
      .x-story > .x-auth { padding: 28px 16px 40px; }
    }
    @media (max-width: 680px) {
      .x-auth-page .mast { min-height: 72px; padding-block: 16px; gap: 16px; }
      .mast nav { justify-content: center; gap: 16px; }
      .nav-accounts { gap: 8px; }
      .mast .nav-login, .mast .nav-signup { padding: 8px 16px; }
    }
    @media (max-width: 520px) { .x-auth-page .mast { justify-content: center; } }
"#;

const AUTH_ASSETS: &str = "/assets/public/auth";

/// Two columns of captures as `(file, width, height)`. Each track holds its
/// set twice so moving it by half its height loops without a seam.
const REEL: [&[(&str, u32, u32)]; 2] = [
    &[
        ("group-agents.webp", 1000, 1226),
        ("grounding.webp", 1000, 736),
        ("digest.webp", 1100, 488),
        ("iphone.webp", 900, 876),
    ],
    &[
        ("mentions.webp", 1100, 470),
        ("shared-doc.webp", 900, 1345),
        ("agent-offer.webp", 1100, 534),
        ("side-chat.webp", 1300, 731),
    ],
];

const PAUSE_ICON: &str = r#"<svg class="x-story-pause" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="1"/><rect x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>"#;
const PLAY_ICON: &str = r#"<svg class="x-story-play" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7Z"/></svg>"#;

/// Where the header's Log in and Sign up go. Both are escaped hrefs.
pub(crate) struct NavAccounts<'a> {
    pub login: &'a str,
    pub register: &'a str,
}

/// The skip link and the home page's header with its navigation. `home` is
/// the escaped home page URL ending in `/`.
pub(crate) fn story_header(home: &str, accounts: Option<NavAccounts<'_>>) -> String {
    let accounts = accounts
        .map(|links| {
            format!(
                r#"<span class="nav-accounts"><a class="nav-login" href="{}">Log in</a><a class="nav-signup" href="{}">Sign up</a></span>"#,
                links.login, links.register
            )
        })
        .unwrap_or_default();
    format!(
        r##"<a class="skip" href="#main">Skip to content</a>
  <header class="wrap mast"><a class="brand" href="{home}" aria-label="Kordi home">{bird}<span>kordi</span></a><nav aria-label="Main navigation"><a href="{home}#figures">Demos</a><a href="{home}research">Research</a><a href="https://research.kordi.ai/">Academia</a><a href="{home}events">Events</a><a href="{home}download">Download</a><a href="https://github.com/Kordi-AI/Kordi" target="_blank" rel="noopener noreferrer">GitHub</a>{accounts}</nav></header>"##,
        bird = crate::site_page::bird("kordi-bird-head"),
    )
}

fn reel() -> String {
    let columns: String = REEL
        .iter()
        .map(|set| {
            let images: String = set
                .iter()
                .chain(set.iter())
                .map(|(file, width, height)| {
                    format!(
                        r#"<img src="{AUTH_ASSETS}/{file}" width="{width}" height="{height}" alt="" loading="lazy" decoding="async">"#
                    )
                })
                .collect();
            format!(r#"<div class="x-story-col"><div class="x-story-track">{images}</div></div>"#)
        })
        .collect();
    format!(r#"<div class="x-story-reel" aria-hidden="true" inert>{columns}</div>"#)
}

/// The story layout around `card`, the page's trusted card markup.
pub(crate) fn story_main(card: &str) -> String {
    format!(
        r#"<main id="main" class="x-story">
    <div class="x-story-panel" aria-hidden="true"><img class="x-story-leaf x-story-leaf-sprig" src="{AUTH_ASSETS}/leaf-sprig.svg" width="420" height="220" alt="" loading="lazy"><img class="x-story-leaf x-story-leaf-fern" src="{AUTH_ASSETS}/leaf-fern.svg" width="220" height="420" alt="" loading="lazy"></div>
    <div class="x-story-copy"><p class="x-story-headline">{STORY_HEADLINE_LEAD} <span>{STORY_HEADLINE_EMPHASIS}</span></p><p class="x-story-line">{STORY_LINE}</p></div>
    <div class="x-auth">
      <section class="x-auth-card">
        {card}
      </section>
    </div>
    <input class="x-story-toggle" id="x-story-toggle" type="checkbox" aria-label="Pause background motion">
    <label class="x-story-motion" for="x-story-toggle">{PAUSE_ICON}{PLAY_ICON}</label>
    {reel}
  </main>"#,
        reel = reel(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn story_carries_the_home_page_lines_and_still_decoration() {
        let main = story_main("<h1>Card</h1>");
        assert!(main.contains(
            r#"<p class="x-story-headline">Build the next <span>supercollaboration.</span></p>"#
        ));
        assert!(main.contains(
            r#"<p class="x-story-line">Every communication in one place, with AI that is proactive and cooperative.</p>"#
        ));
        assert!(main.contains(r#"<section class="x-auth-card">"#));
        assert!(main.contains(r#"<div class="x-story-reel" aria-hidden="true" inert>"#));
        // Each column repeats its four captures for a seamless loop.
        assert_eq!(main.matches("/assets/public/auth/digest.webp").count(), 2);
        assert_eq!(
            main.matches("/assets/public/auth/side-chat.webp").count(),
            2
        );
        assert!(main.contains(r#"aria-label="Pause background motion""#));
        assert!(!main.contains("<script"));
    }

    #[test]
    fn motion_stops_for_reduced_motion_and_phones() {
        let reduced = STORY_CSS
            .split("@media (prefers-reduced-motion: reduce)")
            .nth(1)
            .unwrap();
        assert!(reduced.contains(".x-story-track { animation: none !important; }"));
        let phone = STORY_CSS.split("@media (max-width: 760px)").nth(1).unwrap();
        assert!(phone.contains(
            ".x-story-panel, .x-story-reel, .x-story-toggle, .x-story-motion { display: none; }"
        ));
    }

    #[test]
    fn header_offers_accounts_only_when_given() {
        let home = "https://kordi.ai/";
        let plain = story_header(home, None);
        assert!(plain.contains(r#"<a href="https://kordi.ai/download">Download</a>"#));
        assert!(!plain.contains("nav-login"));
        let with = story_header(
            home,
            Some(NavAccounts {
                login: "/login?next=%2Fg%2Fx",
                register: "/register?next=%2Fg%2Fx",
            }),
        );
        assert!(with.contains(r#"<a class="nav-login" href="/login?next=%2Fg%2Fx">Log in</a>"#));
        assert!(
            with.contains(r#"<a class="nav-signup" href="/register?next=%2Fg%2Fx">Sign up</a>"#)
        );
    }
}
