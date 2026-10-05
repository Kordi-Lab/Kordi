//! Compact migration entries keep the ordered registry readable.
macro_rules! migration {
    ($version:literal, $description:literal, $file:literal) => {
        super::EmbeddedMigration {
            version: $version,
            description: $description,
            sql: include_str!(concat!("../../../migrations/", $file)),
        }
    };
}
pub(super) use migration;
