use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use dicebear_core::{Avatar, Style};
use resvg::{tiny_skia, usvg};
use serde_json::json;
use tokio::sync::Semaphore;

use super::birds::{parse_bird_seed, render_bird_svg, BirdAvatar};

pub(super) const AVATAR_RENDER_SIZE: u32 = 256;
const MAX_RENDERED_AVATARS: usize = 512;
const MAX_CONCURRENT_RENDERS: usize = 8;

/// What a generated avatar is rendered and cached as. Both agent styles draw birds: an
/// explicit `kordi-birds` pick, and the `thumbs` style that every agent without one still
/// stores, which draws the bird its seed hashes to (the same hash the desktop and iOS
/// pickers use). A bird's picture depends only on its species, tone and palette, so all
/// agents share at most 16 x 3 x 8 = 384 bird images. People's Lorelei avatars render per seed.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum RenderKey {
    Bird(BirdAvatar),
    Seed { style: String, seed: String },
}

impl RenderKey {
    pub(super) fn new(style: &str, seed: &str) -> Self {
        if style == super::AGENT_AVATAR_STYLE || style == super::BIRD_AVATAR_STYLE {
            Self::Bird(parse_bird_seed(seed))
        } else {
            Self::Seed {
                style: style.to_string(),
                seed: seed.to_string(),
            }
        }
    }
}

#[cfg(test)]
pub(super) fn render_png(style_name: &str, seed: &str) -> Result<Vec<u8>, String> {
    render_key_png(&RenderKey::new(style_name, seed))
}

pub(super) fn render_key_png(key: &RenderKey) -> Result<Vec<u8>, String> {
    let (style_name, seed) = match key {
        RenderKey::Bird(bird) => return rasterize_svg(&render_bird_svg(*bird)),
        RenderKey::Seed { style, seed } => (style, seed),
    };
    let definition = dicebear_styles::get(style_name)
        .ok_or_else(|| "Avatar style is unavailable.".to_string())?;
    let style = Style::from_str(definition).map_err(|error| error.to_string())?;
    let avatar = Avatar::new(&style, json!({ "seed": seed, "size": AVATAR_RENDER_SIZE }))
        .map_err(|error| error.to_string())?;
    rasterize_svg(avatar.to_svg())
}

pub(super) fn rasterize_svg(svg: &str) -> Result<Vec<u8>, String> {
    let tree =
        usvg::Tree::from_str(svg, &usvg::Options::default()).map_err(|error| error.to_string())?;
    let mut pixmap = tiny_skia::Pixmap::new(AVATAR_RENDER_SIZE, AVATAR_RENDER_SIZE)
        .ok_or_else(|| "Avatar image buffer is unavailable.".to_string())?;
    let source_size = tree.size();
    let transform = tiny_skia::Transform::from_scale(
        AVATAR_RENDER_SIZE as f32 / source_size.width(),
        AVATAR_RENDER_SIZE as f32 / source_size.height(),
    );
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    pixmap.encode_png().map_err(|error| error.to_string())
}

pub(super) fn cached_rendered_avatar(key: &RenderKey) -> Option<Arc<[u8]>> {
    rendered_avatar_cache()
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(key))
}

pub(super) fn cache_rendered_avatar(key: RenderKey, value: Arc<[u8]>) {
    if let Ok(mut cache) = rendered_avatar_cache().lock() {
        cache.insert(key, value);
    }
}

pub(super) fn avatar_render_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_RENDERS)))
}

/// Birds live apart from the bounded per-seed renders: there are at most 384 of them, so
/// they are never trimmed and never push a person's avatar out of the
/// `MAX_RENDERED_AVATARS` most recently used ones.
#[derive(Default)]
struct RenderedAvatarCache {
    birds: HashMap<BirdAvatar, Arc<[u8]>>,
    entries: HashMap<RenderKey, Arc<[u8]>>,
    order: VecDeque<RenderKey>,
}

impl RenderedAvatarCache {
    fn get(&mut self, key: &RenderKey) -> Option<Arc<[u8]>> {
        if let RenderKey::Bird(bird) = key {
            return self.birds.get(bird).cloned();
        }
        let value = self.entries.get(key)?.clone();
        self.order.retain(|entry| entry != key);
        self.order.push_back(key.clone());
        Some(value)
    }

    fn insert(&mut self, key: RenderKey, value: Arc<[u8]>) {
        if let RenderKey::Bird(bird) = key {
            self.birds.insert(bird, value);
            return;
        }
        self.entries.insert(key.clone(), value);
        self.order.retain(|entry| entry != &key);
        self.order.push_back(key);
        while self.entries.len() > MAX_RENDERED_AVATARS {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }
}

fn rendered_avatar_cache() -> &'static Mutex<RenderedAvatarCache> {
    static CACHE: OnceLock<Mutex<RenderedAvatarCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(RenderedAvatarCache::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::avatars::birds::{BIRD_PALETTES, BIRD_SPECIES, BIRD_TONES};
    use crate::avatars::{AGENT_AVATAR_STYLE, BIRD_AVATAR_STYLE, HUMAN_AVATAR_STYLE};

    fn bird(seed: &str) -> RenderKey {
        RenderKey::Bird(parse_bird_seed(seed))
    }

    #[test]
    fn agent_styles_are_keyed_by_the_bird_they_draw() {
        // The shared fixtures pin `default-agent-acct_123` to the coral eagle.
        let eagle = bird("bird-eagle-color-coral");
        for (style, seed) in [
            (AGENT_AVATAR_STYLE, "default-agent-acct_123"),
            (BIRD_AVATAR_STYLE, "default-agent-acct_123"),
            (BIRD_AVATAR_STYLE, "bird-eagle-color-coral"),
            (BIRD_AVATAR_STYLE, "bird-eagle-coral"),
        ] {
            assert_eq!(RenderKey::new(style, seed), eagle, "{style}/{seed}");
        }
        assert_ne!(
            RenderKey::new(AGENT_AVATAR_STYLE, "bird-owl-ink-paper"),
            eagle
        );
        assert_eq!(
            RenderKey::new(HUMAN_AVATAR_STYLE, "default-agent-acct_123"),
            RenderKey::Seed {
                style: HUMAN_AVATAR_STYLE.to_string(),
                seed: "default-agent-acct_123".to_string(),
            }
        );
    }

    #[test]
    fn birds_share_at_most_one_image_each_and_never_evict_people() {
        let image = Arc::<[u8]>::from(vec![1_u8]);
        let mut cache = RenderedAvatarCache::default();
        for index in 0..MAX_RENDERED_AVATARS {
            cache.insert(
                RenderKey::new(HUMAN_AVATAR_STYLE, &format!("person_{index}")),
                image.clone(),
            );
        }
        for index in 0..5_000 {
            let style = [AGENT_AVATAR_STYLE, BIRD_AVATAR_STYLE][index % 2];
            cache.insert(
                RenderKey::new(style, &format!("agent_{index}")),
                image.clone(),
            );
        }
        for species in BIRD_SPECIES {
            for tone in BIRD_TONES {
                for (palette, _) in BIRD_PALETTES {
                    let seed = format!("bird-{species}-{tone}-{palette}");
                    cache.insert(RenderKey::new(BIRD_AVATAR_STYLE, &seed), image.clone());
                }
            }
        }
        assert_eq!(cache.birds.len(), 16 * 3 * 8);
        assert_eq!(cache.entries.len(), MAX_RENDERED_AVATARS);
        assert!(cache
            .get(&RenderKey::new(HUMAN_AVATAR_STYLE, "person_0"))
            .is_some());
        assert!(cache
            .get(&RenderKey::new(AGENT_AVATAR_STYLE, "never_requested_seed"))
            .is_some());

        cache.insert(
            RenderKey::new(HUMAN_AVATAR_STYLE, "one_more_person"),
            image.clone(),
        );
        assert_eq!(cache.entries.len(), MAX_RENDERED_AVATARS);
        assert!(
            cache
                .get(&RenderKey::new(HUMAN_AVATAR_STYLE, "person_1"))
                .is_none(),
            "the least recently used person is trimmed"
        );
    }
}
