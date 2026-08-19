use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use dicebear_core::{Avatar, Style};
use resvg::{tiny_skia, usvg};
use serde_json::json;
use tokio::sync::Semaphore;

pub(super) const AVATAR_RENDER_SIZE: u32 = 256;
const MAX_RENDERED_AVATARS: usize = 512;
const MAX_CONCURRENT_RENDERS: usize = 8;

pub(super) fn render_png(style_name: &str, seed: &str) -> Result<Vec<u8>, String> {
    let definition = dicebear_styles::get(style_name)
        .ok_or_else(|| "Avatar style is unavailable.".to_string())?;
    let style = Style::from_str(definition).map_err(|error| error.to_string())?;
    let avatar = Avatar::new(&style, json!({ "seed": seed, "size": AVATAR_RENDER_SIZE }))
        .map_err(|error| error.to_string())?;
    let tree = usvg::Tree::from_str(avatar.to_svg(), &usvg::Options::default())
        .map_err(|error| error.to_string())?;
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

pub(super) fn cached_rendered_avatar(key: &str) -> Option<Arc<[u8]>> {
    rendered_avatar_cache()
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(key))
}

pub(super) fn cache_rendered_avatar(key: String, value: Arc<[u8]>) {
    if let Ok(mut cache) = rendered_avatar_cache().lock() {
        cache.insert(key, value);
    }
}

pub(super) fn avatar_render_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_RENDERS)))
}

struct RenderedAvatarCache {
    entries: HashMap<String, Arc<[u8]>>,
    order: VecDeque<String>,
}

impl RenderedAvatarCache {
    fn get(&mut self, key: &str) -> Option<Arc<[u8]>> {
        let value = self.entries.get(key)?.clone();
        self.order.retain(|entry| entry != key);
        self.order.push_back(key.to_string());
        Some(value)
    }

    fn insert(&mut self, key: String, value: Arc<[u8]>) {
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
    CACHE.get_or_init(|| {
        Mutex::new(RenderedAvatarCache {
            entries: HashMap::new(),
            order: VecDeque::new(),
        })
    })
}
