use rusqlite::{params, Connection};

fn leading_address_match<'a>(text_after_at: &'a str, label: &str) -> Option<&'a str> {
    let label = label.trim();
    if label.is_empty() {
        return None;
    }
    let label_char_count = label.chars().count();
    let end_index = text_after_at
        .char_indices()
        .nth(label_char_count)
        .map(|(index, _)| index)
        .unwrap_or_else(|| text_after_at.len());
    let candidate = &text_after_at[..end_index];
    if candidate.to_lowercase() != label.to_lowercase() {
        return None;
    }
    let mut rest = &text_after_at[end_index..];
    if let Some(next) = rest.chars().next() {
        if !next.is_whitespace() && !matches!(next, ':' | ';' | ',' | '.' | '!' | '?' | '—' | '-')
        {
            return None;
        }
    }
    rest = rest.trim_start();
    if let Some(next) = rest.chars().next() {
        if matches!(next, ':' | ';' | ',' | '.' | '!' | '?' | '—' | '-') {
            rest = rest[next.len_utf8()..].trim_start();
        }
    }
    Some(rest)
}

fn strip_leading_address_mentions(text: &str, labels: &[String]) -> String {
    let mut current = text.trim_start().to_string();
    let mut labels = labels
        .iter()
        .map(|label| label.trim())
        .filter(|label| !label.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    labels.sort_by_key(|label| std::cmp::Reverse(label.chars().count()));
    labels.dedup_by(|left, right| left.eq_ignore_ascii_case(right));

    loop {
        let Some(after_at) = current.strip_prefix('@') else {
            break;
        };
        let Some(rest) = labels
            .iter()
            .find_map(|label| leading_address_match(after_at, label))
        else {
            break;
        };
        let next = rest.trim_start().to_string();
        if next.is_empty() || next == current {
            break;
        }
        current = next;
    }

    current
}

fn session_address_labels(conn: &Connection, session_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT i.display_name
             FROM session_participants sp
             JOIN identities i ON i.id = sp.identity_id
             WHERE sp.session_id = ?1
               AND sp.state = 'active'
               AND TRIM(i.display_name) <> ''
             UNION
             SELECT DISTINCT owner.display_name
             FROM session_participants sp
             JOIN identities i ON i.id = sp.identity_id
             JOIN identities owner ON owner.id = i.owner_identity_id
             WHERE sp.session_id = ?1
               AND sp.state = 'active'
               AND TRIM(owner.display_name) <> ''",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

pub(super) fn sanitize_shared_agent_response_text_with_conn(
    conn: &Connection,
    parent_session_id: Option<&str>,
    text: &str,
    extra_labels: &[String],
) -> Result<String, String> {
    let mut labels = extra_labels.to_vec();
    if let Some(session_id) = parent_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        labels.extend(session_address_labels(conn, session_id)?);
    }
    Ok(strip_leading_address_mentions(text, &labels))
}
