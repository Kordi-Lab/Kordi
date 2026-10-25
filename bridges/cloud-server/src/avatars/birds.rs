//! The `kordi-birds` agent avatar style: original paper-cut bird portraits.
//!
//! The artwork comes from `scripts/kordi-birds/birds.mjs`, which generates the
//! SVG templates in `birds/templates/` and the `TEMPLATES` table. The species,
//! tone and palette tables below must stay in the same order as the generator and
//! the desktop and iOS clients, because the seed hash indexes into them.

mod templates;

use rand::Rng;

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

/// Maps any seed to a bird. A structured seed names one (see
/// [`parse_structured_bird_seed`]); every other seed picks a species and
/// palette from its FNV-1a hash, with tone `color`.
pub fn parse_bird_seed(seed: &str) -> BirdAvatar {
    parse_structured_bird_seed(seed).unwrap_or_else(|| {
        let hash = fnv1a(seed.as_bytes());
        BirdAvatar {
            species: BIRD_SPECIES[hash as usize % BIRD_SPECIES.len()],
            tone: BIRD_TONES[0],
            palette: BIRD_PALETTES[(hash >> 8) as usize % BIRD_PALETTES.len()].0,
        }
    })
}

/// The bird that `bird-<species>-<tone>-<palette>` or `bird-<species>-<palette>`
/// (tone `color`) names, or `None` for any other seed.
pub fn parse_structured_bird_seed(seed: &str) -> Option<BirdAvatar> {
    let parts: Vec<&str> = seed.strip_prefix(BIRD_SEED_PREFIX)?.split('-').collect();
    let (species, tone, palette) = match parts.as_slice() {
        [species, tone, palette] => (*species, *tone, *palette),
        [species, palette] => (*species, BIRD_TONES[0], *palette),
        _ => return None,
    };
    Some(BirdAvatar {
        species: known(&BIRD_SPECIES, species)?,
        tone: known(&BIRD_TONES, tone)?,
        palette: known_palette(palette)?,
    })
}

/// A new agent's seed: a uniformly random species and palette in the default
/// tone `color`, in the picker's `bird-<species>-<tone>-<palette>` format.
/// Migration 155 draws the default agent profile's seed the same way in SQL.
pub fn random_bird_seed() -> String {
    let mut rng = rand::thread_rng();
    let species = BIRD_SPECIES[rng.gen_range(0..BIRD_SPECIES.len())];
    let palette = BIRD_PALETTES[rng.gen_range(0..BIRD_PALETTES.len())].0;
    format!("{BIRD_SEED_PREFIX}{species}-{}-{palette}", BIRD_TONES[0])
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
    fn random_seeds_name_every_species_and_palette_and_render() {
        let mut species = std::collections::BTreeSet::new();
        let mut palettes = std::collections::BTreeSet::new();
        for index in 0..2_000 {
            let seed = random_bird_seed();
            let bird = parse_structured_bird_seed(&seed)
                .unwrap_or_else(|| panic!("{seed:?} is not a structured bird seed"));
            assert_eq!(
                seed,
                format!("bird-{}-{}-{}", bird.species, bird.tone, bird.palette)
            );
            assert_eq!(bird.tone, "color");
            assert!(crate::avatars::is_valid_avatar_seed(&seed), "{seed:?}");
            if index < 16 {
                rasterize_svg(&render_svg(&seed)).expect("rasterize random bird");
            }
            species.insert(bird.species);
            palettes.insert(bird.palette);
        }
        assert_eq!(species.len(), BIRD_SPECIES.len());
        assert_eq!(palettes.len(), BIRD_PALETTES.len());
    }

    #[test]
    fn structured_seeds_parse_strictly() {
        assert_eq!(
            parse_structured_bird_seed("bird-owl-ink-paper"),
            Some(BirdAvatar {
                species: "owl",
                tone: "ink",
                palette: "paper"
            })
        );
        assert_eq!(
            parse_structured_bird_seed("bird-jay-mint").map(|bird| bird.tone),
            Some("color")
        );
        for seed in [
            "bird-dodo-color-sky",
            "bird-owl-neon-sky",
            "default-agent-acct_1",
        ] {
            assert_eq!(parse_structured_bird_seed(seed), None, "{seed}");
        }
    }

    #[test]
    fn migration_155_draws_from_the_same_tables() {
        let sql = include_str!("../../migrations/0155_agent_default_bird_avatars.sql");
        let quoted = |keys: &[&str]| {
            let list: Vec<String> = keys.iter().map(|key| format!("'{key}'")).collect();
            format!("ARRAY[{}]", list.join(", "))
        };
        let palettes: Vec<&str> = BIRD_PALETTES.iter().map(|(key, _)| *key).collect();
        assert!(sql.contains(&quoted(&BIRD_SPECIES)), "species table");
        assert!(sql.contains(&quoted(&palettes)), "palette table");
        assert!(
            sql.contains(&format!("'-{}-'", BIRD_TONES[0])),
            "default tone"
        );
        assert!(sql.contains(crate::avatars::AVATAR_RENDERER_VERSION));
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
