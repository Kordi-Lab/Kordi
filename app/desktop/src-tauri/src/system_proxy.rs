//! Installs the macOS system proxy policy before any native HTTP clients or
//! sidecars are created.
//!
//! `reqwest` reads proxy environment variables when a client is built. The
//! desktop updater uses a separate `reqwest` version, so resolving the macOS
//! settings once into this process's environment keeps OAuth, providers,
//! discovery, sidecars, and updater requests on the same policy.

#[cfg(any(target_os = "macos", test))]
use std::collections::{BTreeMap, HashSet};

#[cfg(any(target_os = "macos", test))]
const HTTP_PROXY_KEYS: [&str; 2] = ["HTTP_PROXY", "http_proxy"];
#[cfg(any(target_os = "macos", test))]
const HTTPS_PROXY_KEYS: [&str; 2] = ["HTTPS_PROXY", "https_proxy"];
#[cfg(any(target_os = "macos", test))]
const ALL_PROXY_KEYS: [&str; 2] = ["ALL_PROXY", "all_proxy"];
#[cfg(any(target_os = "macos", test))]
const NO_PROXY_KEYS: [&str; 2] = ["NO_PROXY", "no_proxy"];
#[cfg(target_os = "macos")]
const TRACKED_ENVIRONMENT_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
];
#[cfg(any(target_os = "macos", test))]
const REQUIRED_DIRECT_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct SystemProxySettings {
    http_url: Option<String>,
    https_url: Option<String>,
    socks_url: Option<String>,
    exclusions: Vec<String>,
    exclude_simple_hostnames: bool,
    automatic_configuration: bool,
    automatic_discovery: bool,
    invalid_enabled_proxy: bool,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProxySource {
    Direct,
    ExplicitEnvironment,
    MacOsSystem,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct ProxyEnvironmentPlan {
    source: ProxySource,
    updates: BTreeMap<&'static str, String>,
    automatic_configuration_unsupported: bool,
    socks_only_unsupported: bool,
    invalid_system_proxy: bool,
    untranslated_exclusion_count: usize,
}

#[cfg(any(target_os = "macos", test))]
impl ProxyEnvironmentPlan {
    #[cfg(test)]
    fn value(&self, key: &str) -> Option<&str> {
        self.updates.get(key).map(String::as_str)
    }
}

pub(crate) fn install_native_proxy_environment() {
    #[cfg(target_os = "macos")]
    install_macos_proxy_environment();
}

#[cfg(target_os = "macos")]
fn install_macos_proxy_environment() {
    let settings = match macos::read_system_proxy_settings() {
        Ok(settings) => settings,
        Err(error) => {
            eprintln!("[kordi] Unable to read macOS system proxy settings: {error}");
            None
        }
    };
    let environment = snapshot_proxy_environment();
    let plan = plan_proxy_environment(&environment, settings.as_ref());

    // This function is the first operation in `run`, before Tauri, Tokio, any
    // HTTP client, or any child process is initialized. Environment mutation
    // is therefore confined to single-threaded process startup.
    for (key, value) in &plan.updates {
        unsafe { std::env::set_var(key, value) };
    }

    match plan.source {
        ProxySource::MacOsSystem => eprintln!(
            "[kordi] Native network traffic is using macOS system proxy settings; loopback remains direct."
        ),
        ProxySource::ExplicitEnvironment => eprintln!(
            "[kordi] Native network traffic is using explicit proxy environment settings; loopback remains direct."
        ),
        ProxySource::Direct => {}
    }
    if plan.automatic_configuration_unsupported {
        if plan.source == ProxySource::MacOsSystem {
            eprintln!(
                "[kordi] macOS automatic proxy rules are also enabled; native traffic is using the static Web Proxy/Secure Web Proxy values as a consistent fallback. Launch Kordi with HTTPS_PROXY if PAC-only routing is required."
            );
        } else {
            eprintln!(
                "[kordi] macOS automatic proxy configuration is enabled but cannot be represented by the native HTTP stack. Configure a static Web Proxy/Secure Web Proxy or launch Kordi with HTTPS_PROXY."
            );
        }
    }
    if plan.socks_only_unsupported {
        eprintln!(
            "[kordi] A SOCKS-only macOS proxy cannot be used consistently by all native Kordi services. Configure a Web Proxy/Secure Web Proxy or launch Kordi with HTTPS_PROXY."
        );
    }
    if plan.invalid_system_proxy {
        eprintln!(
            "[kordi] An enabled macOS proxy has an invalid host or port. Correct it in System Settings or launch Kordi with HTTPS_PROXY."
        );
    }
    if plan.untranslated_exclusion_count > 0 {
        eprintln!(
            "[kordi] Some macOS proxy exclusions could not be translated. Add those hosts to NO_PROXY before launching Kordi."
        );
    }
}

#[cfg(target_os = "macos")]
fn snapshot_proxy_environment() -> BTreeMap<String, String> {
    TRACKED_ENVIRONMENT_KEYS
        .iter()
        .filter_map(|key| {
            std::env::var_os(key).map(|value| ((*key).to_string(), value.to_string_lossy().into()))
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn plan_proxy_environment(
    environment: &BTreeMap<String, String>,
    system: Option<&SystemProxySettings>,
) -> ProxyEnvironmentPlan {
    let explicit_all = has_any_key(environment, &ALL_PROXY_KEYS);
    let explicit_http = explicit_all || has_any_key(environment, &HTTP_PROXY_KEYS);
    let explicit_https = explicit_all || has_any_key(environment, &HTTPS_PROXY_KEYS);
    let any_explicit_proxy = explicit_http || explicit_https;
    let mut updates = BTreeMap::new();
    let mut uses_system_proxy = false;

    if let Some(settings) = system {
        // PAC/WPAD decisions can vary by destination and cannot be represented
        // by reqwest's process-wide variables. When macOS also exposes static
        // HTTP settings (common with local VPN/proxy apps), use those as the
        // consistent native fallback and report the PAC limitation below.
        if !explicit_http {
            if let Some(url) = &settings.http_url {
                updates.insert("HTTP_PROXY", url.clone());
                updates.insert("http_proxy", url.clone());
                uses_system_proxy = true;
            }
        }
        if !explicit_https {
            if let Some(url) = &settings.https_url {
                updates.insert("HTTPS_PROXY", url.clone());
                updates.insert("https_proxy", url.clone());
                uses_system_proxy = true;
            }
        }
    }

    let use_system_exclusions = uses_system_proxy;
    let mut no_proxy_entries = Vec::new();
    for key in NO_PROXY_KEYS {
        if let Some(value) = environment.get(key) {
            no_proxy_entries.extend(split_no_proxy(value));
        }
    }
    for host in REQUIRED_DIRECT_HOSTS {
        no_proxy_entries.push(host.to_string());
    }

    let mut untranslated_exclusion_count = 0;
    if use_system_exclusions {
        if let Some(settings) = system {
            for exclusion in &settings.exclusions {
                match translate_system_exclusion(exclusion) {
                    Some(exclusion) => no_proxy_entries.push(exclusion),
                    None => untranslated_exclusion_count += 1,
                }
            }
            // reqwest's NO_PROXY grammar cannot express "every hostname with
            // no dot". Kordi's relevant simple/local destinations are covered
            // by the mandatory loopback entries above.
            if settings.exclude_simple_hostnames {
                no_proxy_entries.push(".local".to_string());
            }
        }
    }

    let no_proxy = deduplicate_no_proxy(no_proxy_entries).join(",");
    updates.insert("NO_PROXY", no_proxy.clone());
    updates.insert("no_proxy", no_proxy);

    let source = if any_explicit_proxy {
        ProxySource::ExplicitEnvironment
    } else if uses_system_proxy {
        ProxySource::MacOsSystem
    } else {
        ProxySource::Direct
    };
    let automatic_configuration_unsupported = system.is_some_and(|settings| {
        (settings.automatic_configuration || settings.automatic_discovery) && !any_explicit_proxy
    });
    let socks_only_unsupported = system.is_some_and(|settings| {
        settings.socks_url.is_some()
            && settings.http_url.is_none()
            && settings.https_url.is_none()
            && !any_explicit_proxy
    });
    let invalid_system_proxy =
        system.is_some_and(|settings| settings.invalid_enabled_proxy && !any_explicit_proxy);

    ProxyEnvironmentPlan {
        source,
        updates,
        automatic_configuration_unsupported,
        socks_only_unsupported,
        invalid_system_proxy,
        untranslated_exclusion_count,
    }
}

#[cfg(any(target_os = "macos", test))]
fn has_any_key(environment: &BTreeMap<String, String>, keys: &[&str]) -> bool {
    keys.iter().any(|key| environment.contains_key(*key))
}

#[cfg(any(target_os = "macos", test))]
fn split_no_proxy(value: &str) -> impl Iterator<Item = String> + '_ {
    value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
}

#[cfg(any(target_os = "macos", test))]
fn translate_system_exclusion(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if value.eq_ignore_ascii_case("<local>") {
        // Kordi's native simple-host destinations are loopback services. Map
        // Apple's special token into the mandatory loopback rule; arbitrary
        // simple LAN hostnames are not used by the desktop runtime.
        return Some("localhost".to_string());
    }
    if value == "*" {
        return Some(value.to_string());
    }
    if let Some(suffix) = value.strip_prefix("*.") {
        return (!suffix.is_empty() && !suffix.contains('*')).then(|| format!(".{suffix}"));
    }
    if value.contains('*') {
        return None;
    }
    Some(normalize_ipv4_cidr(value).unwrap_or_else(|| value.to_string()))
}

#[cfg(any(target_os = "macos", test))]
fn normalize_ipv4_cidr(value: &str) -> Option<String> {
    let (address, prefix) = value.split_once('/')?;
    if address.contains(':') {
        return None;
    }
    let prefix = prefix.parse::<u8>().ok()?;
    if prefix > 32 {
        return None;
    }
    let octets = address
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    if octets.is_empty() || octets.len() > 4 {
        return None;
    }
    let mut normalized = octets;
    normalized.resize(4, 0);
    Some(format!(
        "{}.{}.{}.{}/{}",
        normalized[0], normalized[1], normalized[2], normalized[3], prefix
    ))
}

#[cfg(any(target_os = "macos", test))]
fn deduplicate_no_proxy(entries: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    entries
        .into_iter()
        .filter(|entry| seen.insert(entry.to_ascii_lowercase()))
        .collect()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::SystemProxySettings;
    use system_configuration::{
        core_foundation::{
            array::CFArray,
            base::{CFType, TCFType},
            dictionary::CFDictionary,
            number::CFNumber,
            string::{CFString, CFStringRef},
        },
        dynamic_store::SCDynamicStoreBuilder,
        sys::schema_definitions::{
            kSCPropNetProxiesExceptionsList, kSCPropNetProxiesExcludeSimpleHostnames,
            kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPPort, kSCPropNetProxiesHTTPProxy,
            kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSPort, kSCPropNetProxiesHTTPSProxy,
            kSCPropNetProxiesProxyAutoConfigEnable, kSCPropNetProxiesProxyAutoDiscoveryEnable,
            kSCPropNetProxiesSOCKSEnable, kSCPropNetProxiesSOCKSPort, kSCPropNetProxiesSOCKSProxy,
        },
    };

    pub(super) fn read_system_proxy_settings() -> Result<Option<SystemProxySettings>, &'static str>
    {
        let store = SCDynamicStoreBuilder::new("Kordi")
            .build()
            .ok_or("SystemConfiguration did not provide a dynamic store session")?;
        let Some(proxies) = store.get_proxies() else {
            return Ok(None);
        };

        let http_enabled = number_is_one(&proxies, unsafe { kSCPropNetProxiesHTTPEnable });
        let https_enabled = number_is_one(&proxies, unsafe { kSCPropNetProxiesHTTPSEnable });
        let socks_enabled = number_is_one(&proxies, unsafe { kSCPropNetProxiesSOCKSEnable });
        let http_url = read_proxy_url(
            &proxies,
            http_enabled,
            unsafe { kSCPropNetProxiesHTTPProxy },
            unsafe { kSCPropNetProxiesHTTPPort },
            "http",
        );
        let https_url = read_proxy_url(
            &proxies,
            https_enabled,
            unsafe { kSCPropNetProxiesHTTPSProxy },
            unsafe { kSCPropNetProxiesHTTPSPort },
            "http",
        );
        let socks_url = read_proxy_url(
            &proxies,
            socks_enabled,
            unsafe { kSCPropNetProxiesSOCKSProxy },
            unsafe { kSCPropNetProxiesSOCKSPort },
            "socks5h",
        );
        let invalid_enabled_proxy = (http_enabled && http_url.is_none())
            || (https_enabled && https_url.is_none())
            || (socks_enabled && socks_url.is_none());

        Ok(Some(SystemProxySettings {
            http_url,
            https_url,
            socks_url,
            exclusions: read_string_array(&proxies, unsafe { kSCPropNetProxiesExceptionsList }),
            exclude_simple_hostnames: number_is_one(&proxies, unsafe {
                kSCPropNetProxiesExcludeSimpleHostnames
            }),
            automatic_configuration: number_is_one(&proxies, unsafe {
                kSCPropNetProxiesProxyAutoConfigEnable
            }),
            automatic_discovery: number_is_one(&proxies, unsafe {
                kSCPropNetProxiesProxyAutoDiscoveryEnable
            }),
            invalid_enabled_proxy,
        }))
    }

    fn number_is_one(proxies: &CFDictionary<CFString, CFType>, key: CFStringRef) -> bool {
        proxies
            .find(key)
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i32())
            == Some(1)
    }

    fn read_proxy_url(
        proxies: &CFDictionary<CFString, CFType>,
        enabled: bool,
        host_key: CFStringRef,
        port_key: CFStringRef,
        scheme: &str,
    ) -> Option<String> {
        if !enabled {
            return None;
        }
        let host = proxies
            .find(host_key)
            .and_then(|value| value.downcast::<CFString>())?
            .to_string();
        let host = host.trim();
        let port = proxies
            .find(port_key)
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i32())?;
        if host.is_empty() || !(1..=u16::MAX as i32).contains(&port) {
            return None;
        }
        let host = if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        Some(format!("{scheme}://{host}:{port}"))
    }

    fn read_string_array(
        proxies: &CFDictionary<CFString, CFType>,
        key: CFStringRef,
    ) -> Vec<String> {
        let Some(array) = proxies
            .find(key)
            .and_then(|value| value.downcast::<CFArray>())
        else {
            return Vec::new();
        };
        array
            .iter()
            .filter_map(|pointer| {
                let value = unsafe { CFType::wrap_under_get_rule(*pointer) };
                value.downcast::<CFString>().map(|value| value.to_string())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests;
