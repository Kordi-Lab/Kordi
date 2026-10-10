use super::ToolSelection;

impl ToolSelection {
    /// Return this selection with `name` removed, whatever its shape.
    pub(crate) fn without(self, name: &str) -> Self {
        match self {
            Self::All => Self::AllExcept(vec![name.to_string()]),
            Self::AllExcept(mut excluded) => {
                if !excluded.iter().any(|existing| existing == name) {
                    excluded.push(name.to_string());
                }
                Self::AllExcept(excluded)
            }
            Self::None => Self::None,
            Self::Only(names) => Self::Only(
                names
                    .into_iter()
                    .filter(|existing| existing != name)
                    .collect(),
            ),
        }
    }
}
