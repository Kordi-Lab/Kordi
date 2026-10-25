//! The `kordi-birds` agent avatar style: original paper-cut bird portraits.
//!
//! The artwork comes from `scripts/kordi-birds/birds.mjs`, which generates the
//! SVG templates in `birds/templates/` and the `TEMPLATES` table. The species,
//! tone and palette tables below must stay in the same order as the generator and
//! the desktop and iOS clients, because the seed hash indexes into them.

mod templates;

use self::templates::TEMPLATES;

pub(super) const BIRD_SEED_PREFIX: &str = "bird-";
const BACKGROUND_PLACEHOLDER: &str = "__BG__";

pub const BIRD_SPECIES: [&str; 16] = [
    "sparrow",
    "robin",
    "cardinal",
    "jay",
    "kingfisher",
    "hummingbird",
    "owl",
    "osprey",
    "sparrowhawk",
    "eagle",
    "penguin",
    "puffin",
    "toucan",
    "heron",
    "blackbird",
    "cockatoo",
];

pub const BIRD_TONES: [&str; 3] = ["color", "slate", "ink"];

/// (palette key, background colour).
pub const BIRD_PALETTES: [(&str, &str); 8] = [
    ("paper", "#ffffff"),
    ("rice", "#fbf5ea"),
    ("coral", "#ff8a6b"),
    ("sakura", "#f9c6d3"),
    ("butter", "#ffd96a"),
    ("mint", "#bfe6cf"),
    ("sky", "#a9d8f2"),
    ("lavender", "#d6cdf3"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BirdAvatar {
    pub species: &'static str,
    pub tone: &'static str,
    pub palette: &'static str,
}

impl BirdAvatar {
    pub fn background(&self) -> &'static str {
        BIRD_PALETTES
            .iter()
            .find(|(key, _)| *key == self.palette)
            .map_or(BIRD_PALETTES[0].1, |(_, color)| color)
    }
}

/// Maps any seed to a bird. `bird-<species>-<tone>-<palette>` and
/// `bird-<species>-<palette>` (tone `color`) name one explicitly; every other
/// seed picks a species and palette from its FNV-1a hash, with tone `color`.
pub fn parse_bird_seed(seed: &str) -> BirdAvatar {
    if let Some(rest) = seed.strip_prefix(BIRD_SEED_PREFIX) {
        let parts: Vec<&str> = rest.split('-').collect();
        let named = match parts.as_slice() {
            [species, tone, palette] => known(&BIRD_SPECIES, species)
                .zip(known(&BIRD_TONES, tone))
                .zip(known_palette(palette)),
            [species, palette] => known(&BIRD_SPECIES, species)
                .zip(Some(BIRD_TONES[0]))
                .zip(known_palette(palette)),
            _ => None,
        };
        if let Some(((species, tone), palette)) = named {
            return BirdAvatar {
                species,
                tone,
                palette,
            };
        }
    }
    let hash = fnv1a(seed.as_bytes());
    BirdAvatar {
        species: BIRD_SPECIES[hash as usize % BIRD_SPECIES.len()],
        tone: BIRD_TONES[0],
        palette: BIRD_PALETTES[(hash >> 8) as usize % BIRD_PALETTES.len()].0,
    }
}

/// The 128 x 128 SVG for a seed, with its palette background filled in.
pub fn render_svg(seed: &str) -> String {
    let bird = parse_bird_seed(seed);
    let template = TEMPLATES
        .iter()
        .find(|(species, tone, _)| *species == bird.species && *tone == bird.tone)
        .map_or(TEMPLATES[0].2, |(_, _, svg)| svg);
    template.replacen(BACKGROUND_PLACEHOLDER, bird.background(), 1)
}

fn known(table: &[&'static str], value: &str) -> Option<&'static str> {
    table.iter().copied().find(|entry| *entry == value)
}

fn known_palette(value: &str) -> Option<&'static str> {
    BIRD_PALETTES
        .iter()
        .map(|(key, _)| *key)
        .find(|key| *key == value)
}

fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::avatars::rendering::{rasterize_svg, AVATAR_RENDER_SIZE};

    const FIXTURES: &str = include_str!("../../../../scripts/kordi-birds/fixtures.json");

    #[test]
    fn seeds_match_the_shared_fixtures() {
        let fixtures: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(FIXTURES).expect("parse fixtures");
        assert_eq!(fixtures.len(), 12);
        for (seed, expected) in fixtures {
            let bird = parse_bird_seed(&seed);
            assert_eq!(
                serde_json::json!({
                    "species": bird.species,
                    "tone": bird.tone,
                    "palette": bird.palette,
                }),
                expected,
                "seed {seed:?}"
            );
        }
    }

    #[test]
    fn every_species_and_tone_has_a_template() {
        assert_eq!(TEMPLATES.len(), BIRD_SPECIES.len() * BIRD_TONES.len());
        for species in BIRD_SPECIES {
            for tone in BIRD_TONES {
                let template = TEMPLATES
                    .iter()
                    .find(|entry| entry.0 == species && entry.1 == tone)
                    .unwrap_or_else(|| panic!("missing template {species}-{tone}"));
                assert_eq!(template.2.matches(BACKGROUND_PLACEHOLDER).count(), 1);
            }
        }
    }

    #[test]
    fn render_svg_fills_the_palette_background() {
        let svg = render_svg("bird-osprey-color-sky");
        assert!(svg.contains("fill=\"#a9d8f2\""));
        assert!(!svg.contains(BACKGROUND_PLACEHOLDER));
    }

    #[test]
    fn every_template_rasterizes_with_an_opaque_centre() {
        for species in BIRD_SPECIES {
            for tone in BIRD_TONES {
                let seed = format!("bird-{species}-{tone}-lavender");
                let png = rasterize_svg(&render_svg(&seed)).expect("rasterize bird");
                let image = image::load_from_memory(&png)
                    .unwrap_or_else(|error| panic!("decode {seed}: {error}"))
                    .to_rgba8();
                assert_eq!(image.dimensions(), (AVATAR_RENDER_SIZE, AVATAR_RENDER_SIZE));
                let centre = image.get_pixel(AVATAR_RENDER_SIZE / 2, AVATAR_RENDER_SIZE / 2);
                assert_eq!(centre[3], 255, "{seed} centre is transparent");
            }
        }
    }
}
