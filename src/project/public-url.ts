import { BlockList, isIP } from 'node:net';

const BLOCKED_IPV4_RANGES = [
  { network: '0.0.0.0', prefix: 8, purpose: 'unspecified addresses' },
  { network: '10.0.0.0', prefix: 8, purpose: 'private network' },
  { network: '100.64.0.0', prefix: 10, purpose: 'shared carrier network' },
  { network: '127.0.0.0', prefix: 8, purpose: 'loopback' },
  { network: '169.254.0.0', prefix: 16, purpose: 'link-local network' },
  { network: '172.16.0.0', prefix: 12, purpose: 'private network' },
  { network: '192.0.0.0', prefix: 24, purpose: 'protocol assignments' },
  { network: '192.0.2.0', prefix: 24, purpose: 'documentation examples' },
  { network: '192.168.0.0', prefix: 16, purpose: 'private network' },
  { network: '198.18.0.0', prefix: 15, purpose: 'benchmark testing' },
  { network: '198.51.100.0', prefix: 24, purpose: 'documentation examples' },
  { network: '203.0.113.0', prefix: 24, purpose: 'documentation examples' },
  { network: '224.0.0.0', prefix: 3, purpose: 'multicast and reserved addresses' },
] as const;

const blockedIPv4 = new BlockList();
for (const range of BLOCKED_IPV4_RANGES) blockedIPv4.addSubnet(range.network, range.prefix, 'ipv4');

// Preserve the existing IPv6 policy: global-unicast addresses only, excluding
// the documentation range. Loopback, private, link-local and mapped IPv4 fall
// outside this accepted range.
const globalIPv6 = new BlockList();
globalIPv6.addSubnet('2000::', 3, 'ipv6');
const documentationIPv6 = new BlockList();
documentationIPv6.addSubnet('2001:db8::', 32, 'ipv6');

function publicHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const version = isIP(host);
  if (version === 4) return !blockedIPv4.check(host, 'ipv4');
  if (version === 6)
    return globalIPv6.check(host, 'ipv6') && !documentationIPv6.check(host, 'ipv6');
  const localName = /(?:^|\.)(?:localhost|local|internal|home|lan)$/;
  const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return (
    host.includes('.') &&
    !localName.test(host) &&
    host.split('.').every((label) => domainLabel.test(label))
  );
}

/** Validate URL syntax and literal destinations without making DNS or network requests. */
export function parsePublicHttpsURL(value: string, label: string, cleanWebsite = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a public HTTPS URL.`);
  }
  if (
    /\s/.test(value) ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !publicHostname(url.hostname)
  ) {
    throw new Error(`${label} must be a public HTTPS URL without credentials.`);
  }
  if (cleanWebsite && (url.search || url.hash))
    throw new Error(`${label} cannot contain query parameters or fragments.`);
  return url;
}
