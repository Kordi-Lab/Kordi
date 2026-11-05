// Shape-based rules for hosting details: public IP addresses, IP-embedding DNS names,
// Google Cloud project, zone, instance and service-account identifiers, and Linux home paths.
// Every rule must accept documentation ranges and obvious placeholders.

const IPV4_CANDIDATE = /(?<![\w.-])((?:\d{1,3}\.){3}\d{1,3})(?![\w-]|\.\d)/g;
const IPV6_CANDIDATE = /(?<![\w:.])([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})(?![\w:.])/gi;
const VECTOR_PATH_CHARACTER = /[-\d.\s,eE+MmCcLlHhVvSsQqTtAaZz]/;
// SVG path data packs numbers as "1.08.58" or "-.53.63" and separates them with "-", which
// prose and configuration listing IP addresses never do.
const VECTOR_PATH_MARKER = /(?<![A-Za-z])[MmCcLlHhVvSsQqTtAaZz]-?\.?\d|-\.\d|\d-\.?\d/;

// [first address, prefix length] pairs that are never a concrete public host.
const NON_PUBLIC_IPV4_RANGES = [
  ['0.0.0.0', 8], // "this network" and the unspecified address
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local and cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
  // Google Front End source ranges. Origin firewall and proxy configuration must name them,
  // and they identify Google's load balancers rather than a Kordi host.
  ['35.191.0.0', 16],
  ['130.211.0.0', 22],
];

// Well-known public services that code may name on purpose.
const ALLOWED_PUBLIC_IPV4 = new Set([
  '1.1.1.1', '1.0.0.1', // Cloudflare DNS
  '8.8.8.8', '8.8.4.4', // Google Public DNS
  '9.9.9.9', '149.112.112.112', // Quad9 DNS
  '208.67.222.222', '208.67.220.220', // OpenDNS
  '64.233.186.127', // Google public STUN server, the bridges CLI default ICE server
  '172.32.0.1', // first address after 172.16.0.0/12; private-range boundary tests probe it
  '64.211.144.160', // Zoom public dial-in address quoted by calendar-invitation fixtures
]);

const ALLOWED_PUBLIC_IPV6_PREFIXES = [
  '2001:4860:4860:', // Google Public DNS
  '2606:4700:4700:', // Cloudflare DNS
  '2620:fe:', // Quad9 DNS
  '2620:119:35:', '2620:119:53:', // OpenDNS
];

function ipv4ToNumber(address) {
  const octets = address.split('.');
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(octet) || Number(octet) > 255) return null;
    value = (value * 256) + Number(octet);
  }
  return value;
}

const NON_PUBLIC_IPV4_NUMERIC = NON_PUBLIC_IPV4_RANGES.map(([base, prefix]) => {
  const size = 2 ** (32 - prefix);
  const start = ipv4ToNumber(base);
  return [start, start + size];
});

export function isPublicIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  if (ALLOWED_PUBLIC_IPV4.has(address)) return false;
  return !NON_PUBLIC_IPV4_NUMERIC.some(([start, end]) => value >= start && value < end);
}

function expandIpv6(candidate) {
  const lower = candidate.toLowerCase();
  if ((lower.match(/::/g) ?? []).length > 1 || /:::/.test(lower)) return null;
  const [head, tail] = lower.includes('::') ? lower.split('::') : [lower, null];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  if ([...headGroups, ...tailGroups].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === null ? missing !== 0 : missing < 1) return null;
  return [...headGroups, ...Array(tail === null ? 0 : missing).fill('0'), ...tailGroups]
    .map((group) => Number.parseInt(group, 16));
}

export function isPublicIpv6(candidate) {
  const groups = expandIpv6(candidate);
  if (!groups) return false;
  const [first, second, third] = groups;
  if (first < 0x2000 || first > 0x3fff) return false; // only global unicast 2000::/3
  if (groups.slice(4).every((group) => group === 0)) return false; // range bases such as 2000::/3
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x3fff && second <= 0x0fff) return false; // documentation (3fff::/20)
  if (first === 0x2001 && second === 0x0002 && third === 0) return false; // benchmarking
  if (first === 0x2002) {
    // 6to4 embeds an IPv4 address; it is only public when that address is.
    return isPublicIpv4([second >> 8, second & 0xff, third >> 8, third & 0xff].join('.'));
  }
  const canonical = groups.map((group) => group.toString(16)).join(':');
  return !ALLOWED_PUBLIC_IPV6_PREFIXES.some((prefix) => `${canonical}:`.startsWith(prefix));
}

function looksLikeVectorPathData(contents, start, end) {
  let left = start;
  while (left > 0 && start - left < 32 && VECTOR_PATH_CHARACTER.test(contents[left - 1])) left -= 1;
  let right = end;
  while (right < contents.length && right - end < 32 && VECTOR_PATH_CHARACTER.test(contents[right])) right += 1;
  return VECTOR_PATH_MARKER.test(contents.slice(left, start) + contents.slice(end, right));
}

function containsPublicIpv4(contents) {
  for (const match of contents.matchAll(IPV4_CANDIDATE)) {
    const address = match[1];
    if (address.endsWith('.0.0.0')) continue; // version strings and class-A network bases
    if (!isPublicIpv4(address)) continue;
    if (looksLikeVectorPathData(contents, match.index, match.index + match[0].length)) continue;
    return true;
  }
  return false;
}

function containsPublicIpv6(contents) {
  for (const match of contents.matchAll(IPV6_CANDIDATE)) {
    if (isPublicIpv6(match[1])) return true;
  }
  return false;
}

const IP_DNS_NAME = /\b((?:\d{1,3}[.-]){3}\d{1,3})\.(?:sslip|nip)\.io\b/gi;

function containsPublicIpDnsName(contents) {
  for (const match of contents.matchAll(IP_DNS_NAME)) {
    if (isPublicIpv4(match[1].replaceAll('-', '.'))) return true;
  }
  return false;
}

// Placeholder values that documentation and tests use instead of a real project or zone.
const PLACEHOLDER_VALUE = /^(?:[$<{%*]|\\\$)|example|sample|placeholder|dummy|demo|test|your[-_]|my[-_]|project[-_]?id|xxx|redacted/i;
const GCLOUD_PROJECT_FLAG = /\bgcloud\b[^\n]*?(?:--project(?:=|\s+)|\bconfig\s+set\s+(?:core\/)?project\s+)["']?([^\s"'`;)|]+)/g;
const GCLOUD_ZONE_FLAG = /\bgcloud\b[^\n]*?--zone(?:=|\s+)["']?([^\s"'`;)|]+)/g;
const GCP_ZONE_SHAPE = /^[a-z]+-[a-z]+\d+-[a-z]$/;
const SERVICE_ACCOUNT = /\b[a-z0-9][a-z0-9._-]*@([a-z0-9-]+)\.iam\.gserviceaccount\.com\b/gi;
const PLACEHOLDER_SERVICE_ACCOUNT_PROJECT = /^(?:example[\w-]*|sample[\w-]*|project|other|test[\w-]*|my-project|your-project|project-id|placeholder)$/i;

function joinShellContinuations(contents) {
  return contents.replace(/\\\r?\n\s*/g, ' ');
}

function containsGcloudProject(contents) {
  for (const match of joinShellContinuations(contents).matchAll(GCLOUD_PROJECT_FLAG)) {
    if (!PLACEHOLDER_VALUE.test(match[1])) return true;
  }
  return false;
}

function containsGcloudZone(contents) {
  for (const match of joinShellContinuations(contents).matchAll(GCLOUD_ZONE_FLAG)) {
    if (GCP_ZONE_SHAPE.test(match[1]) && !PLACEHOLDER_VALUE.test(match[1])) return true;
  }
  return false;
}

function containsServiceAccount(contents) {
  for (const match of contents.matchAll(SERVICE_ACCOUNT)) {
    if (!PLACEHOLDER_SERVICE_ACCOUNT_PROJECT.test(match[1])) return true;
  }
  return false;
}

const LINUX_HOME_PLACEHOLDER = '(?:runner|user|username|example[\\w-]*|sample[\\w-]*|test[\\w-]*|demo|owner|alice|bob|carol|sam|you|me|x|node|bun|deno|ubuntu|kordi|app|git|linuxbrew|vscode|codespace|coder|nobody|builder|\\*|@[A-Z_]+@)';

export const INFRASTRUCTURE_TEXT_RULES = [
  {
    id: 'public-ip-address',
    description: 'public IP address outside documentation and well-known service ranges',
    test: (contents) => containsPublicIpv4(contents) || containsPublicIpv6(contents),
  },
  {
    id: 'ip-embedding-hostname',
    description: 'DNS name that embeds a public IP address',
    test: containsPublicIpDnsName,
  },
  {
    id: 'cloud-reverse-dns',
    description: 'cloud provider reverse-DNS host name',
    pattern: /\bbc\.googleusercontent\.com\b/i,
  },
  {
    id: 'gcp-project-identifier',
    description: 'concrete Google Cloud project identifier',
    pattern: /\bproject-[0-9a-f]{8}-[0-9a-f]{4}-|\bprojects\/\d{10,13}\b/i,
  },
  {
    id: 'gcloud-project-flag',
    description: 'gcloud command with a literal project',
    test: containsGcloudProject,
  },
  {
    id: 'gcloud-zone-flag',
    description: 'gcloud command with a literal zone',
    test: containsGcloudZone,
  },
  {
    id: 'gcp-service-account',
    description: 'concrete Google Cloud service account',
    test: (contents) => containsServiceAccount(contents)
      || /\b\d{6,}(?:-compute@developer|@cloudservices|@cloudbuild)\.gserviceaccount\.com\b/i.test(contents),
  },
  {
    id: 'gcp-internal-hostname',
    description: 'Google Cloud internal DNS name',
    pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)?\.c\.[a-z][a-z0-9-]{4,28}[a-z0-9]\.internal\b/i,
  },
  {
    id: 'gcp-instance-id',
    description: 'numeric Google Compute Engine instance identifier',
    pattern: /\bcompute\.\d{15,}\b/,
  },
  {
    id: 'linux-home-path',
    description: 'Linux home-directory path',
    pattern: new RegExp(`(?<![\\w./-])/home/(?!${LINUX_HOME_PLACEHOLDER}(?:[/\\s"'\`)\\]>,;:]|$))[a-z_][a-z0-9_-]*(?:[/\\s"'\`)\\]>,;:]|$)`),
  },
];
