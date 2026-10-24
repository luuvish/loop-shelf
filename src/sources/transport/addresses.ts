import { BlockList, isIP } from "node:net";
import { TransportFault, type Address } from "./contracts.ts";

// Conservative special-use exclusions. See docs/SOURCE_TRANSPORT.md for IANA references.
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(value: Address): boolean {
  if (value.address.includes("%") || isIP(value.address) !== value.family) return false;
  if (value.family === 4) return !blocked.check(value.address, "ipv4");
  return globalV6.check(value.address, "ipv6") && !blocked.check(value.address, "ipv6");
}
export function selectAddress(addresses: readonly Address[]): Address {
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address)))
    throw new TransportFault("unsafe_address");
  // No fallback to a new/unvalidated DNS answer if this address fails.
  return { ...addresses[0]! };
}
