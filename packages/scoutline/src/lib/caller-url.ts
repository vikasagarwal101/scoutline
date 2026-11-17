import { BlockList, isIP } from "node:net";
import { ValidationError } from "./errors.js";

const nonPublicV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublicV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const nonPublicV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) nonPublicV6.addSubnet(address, prefix, "ipv6");

const localNames = ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "home.arpa", "corp"];

/** Screen caller acquisition references without changing their evidence identity.
 * URL normalisation catches short/packed/hex IPv4 and trailing-dot local names.
 * Only global-unicast IPv6 literals outside the special-use ranges are allowed;
 * mapped/translation forms are conservatively refused.
 *
 * Hostnames are not DNS-resolved here. The configured remote Reader owns DNS
 * and redirects; this check is not a provider-side routing/SSRF guarantee.
 * Qualified fixture names such as example.test remain valid synthetic inputs.
 */
export function assertCallerUrl(value: unknown): asserts value is string {
  const refuse = (): never => { throw new ValidationError("Caller URL must reference an external HTTP(S) destination; local and special-use destinations are unsupported."); };
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 8192) return refuse();
  let url: URL;
  try { url = new URL(value); } catch { return refuse(); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) refuse();
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  const family = isIP(host);
  if (family === 4) {
    if (nonPublicV4.check(host, "ipv4")) refuse();
  } else if (family === 6) {
    if (!globalV6.check(host, "ipv6") || nonPublicV6.check(host, "ipv6")) refuse();
  } else {
    if (!host.includes(".") || host.length > 253 ||
        !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        localNames.some(name => host === name || host.endsWith("." + name))) refuse();
  }
}
