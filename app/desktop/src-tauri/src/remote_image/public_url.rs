use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use reqwest::Url;

fn is_public_remote_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _fourth] = address.octets();
    !(first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 88 && third == 99)
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113))
}

fn is_public_remote_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4() {
        return is_public_remote_ipv4(mapped);
    }
    let segments = address.segments();
    if segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        let embedded = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            segments[6] as u8,
            (segments[7] >> 8) as u8,
            segments[7] as u8,
        );
        return is_public_remote_ipv4(embedded);
    }
    // RFC 8215 reserves 64:ff9b:1::/48 for local use; never treat it as public even when its embedded IPv4 address
    // is not represented in the well-known /96 layout above.
    if segments[..3] == [0x0064, 0xff9b, 0x0001] {
        return false;
    }

    let is_global_unicast = segments[0] & 0xe000 == 0x2000;
    let is_special_registry = segments[0] == 0x2001 && segments[1] <= 0x01ff;
    let is_documentation = (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0);
    let is_six_to_four = segments[0] == 0x2002;
    is_global_unicast && !is_special_registry && !is_documentation && !is_six_to_four
}

pub(super) fn is_public_remote_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_remote_ipv4(address),
        IpAddr::V6(address) => is_public_remote_ipv6(address),
    }
}

/// Classifies the parsed URL host. For HTTPS URLs the `url` crate normalizes
/// every IPv4 form (including `127.1` and `0x7f.1`) to dotted decimal and
/// always brackets IPv6 literals, so these three shapes mirror `Url::host()`.
fn is_public_remote_host(host: &str) -> bool {
    if let Some(literal) = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return literal
            .parse::<Ipv6Addr>()
            .is_ok_and(|address| is_public_remote_ip(IpAddr::V6(address)));
    }
    if let Ok(address) = host.parse::<Ipv4Addr>() {
        return is_public_remote_ip(IpAddr::V4(address));
    }
    let domain = host.trim_end_matches('.').to_ascii_lowercase();
    !(domain.is_empty()
        || domain == "localhost"
        || domain.ends_with(".localhost")
        || domain.ends_with(".local"))
}

pub(crate) fn validated_remote_image_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "Avatar image URL is invalid.".to_string())?;
    if url.scheme() != "https" {
        return Err("Avatar image URL must use HTTPS.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Avatar image URL must not contain credentials.".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "Avatar image URL is missing a host.".to_string())?;
    if !is_public_remote_host(host) {
        return Err("Avatar image URL must use a public host.".to_string());
    }
    Ok(url)
}

/// Resolves a redirect `Location` against the current URL and applies the
/// same public HTTPS policy as the first request.
pub(crate) fn validated_redirect_target(current: &Url, location: &str) -> Result<Url, String> {
    let next_url = current
        .join(location.trim())
        .map_err(|_| "Avatar image redirect URL is invalid.".to_string())?;
    validated_remote_image_url(next_url.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_avatar_urls_require_public_https_hosts() {
        assert!(validated_remote_image_url("https://images.example/avatar.png").is_ok());
        assert!(validated_remote_image_url("https://images.example./avatar.png").is_ok());
        assert!(validated_remote_image_url("https://[2606:4700:4700::1111]/avatar.png").is_ok());
        assert!(validated_remote_image_url("http://images.example/avatar.png").is_err());
        assert!(validated_remote_image_url("https://localhost/avatar.png").is_err());
        assert!(validated_remote_image_url("https://127.0.0.1/avatar.png").is_err());
        assert!(validated_remote_image_url("https://192.168.1.20/avatar.png").is_err());
    }

    #[test]
    fn remote_image_urls_reject_local_and_literal_private_hosts() {
        for url in [
            "http://example.com/",
            "https://127.0.0.1/",
            "https://127.1/",
            "https://0x7f.1/",
            "https://169.254.169.254/",
            "https://[::1]/",
            "https://[::ffff:127.0.0.1]/",
            "https://[fd00::1]/",
            "https://[fe80::1]/",
            "https://localhost./",
            "https://LOCALHOST/",
            "https://foo.localhost/",
            "https://foo.localhost./",
            "https://printer.local/",
            "https://printer.local./",
            "https://user:pw@example.com/",
            "https://user@example.com/",
        ] {
            assert!(
                validated_remote_image_url(url).is_err(),
                "{url} must be rejected"
            );
        }
    }

    #[test]
    fn redirect_targets_are_joined_then_validated() {
        let current = Url::parse("https://example.com/articles/one").unwrap();
        assert_eq!(
            validated_redirect_target(&current, "/articles/two")
                .unwrap()
                .as_str(),
            "https://example.com/articles/two"
        );
        assert_eq!(
            validated_redirect_target(&current, "three?page=2")
                .unwrap()
                .as_str(),
            "https://example.com/articles/three?page=2"
        );
        assert_eq!(
            validated_redirect_target(&current, "https://cdn.example.org/image.png")
                .unwrap()
                .as_str(),
            "https://cdn.example.org/image.png"
        );
        for location in [
            "http://example.com/articles/two",
            "https://127.0.0.1/",
            "https://0x7f.1/",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/",
            "https://[fd00::1]/",
            "https://foo.localhost/",
            "https://localhost./",
            "https://user:pw@example.com/",
            "//127.0.0.1/admin",
        ] {
            assert!(
                validated_redirect_target(&current, location).is_err(),
                "{location} must be rejected"
            );
        }
    }

    #[test]
    fn remote_avatar_ip_filter_rejects_non_public_and_mapped_addresses() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "192.168.1.20",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b:1::7f00:1",
            "2001:2::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            let address = value.parse::<IpAddr>().expect("test IP address");
            assert!(!is_public_remote_ip(address), "{value} must not be public");
        }

        for value in [
            "1.1.1.1",
            "8.8.8.8",
            "64:ff9b::101:101",
            "2606:4700:4700::1111",
        ] {
            let address = value.parse::<IpAddr>().expect("test IP address");
            assert!(is_public_remote_ip(address), "{value} should remain public");
        }
    }
}
