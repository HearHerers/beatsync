// Single source of truth for a zone's display name so the shape panel and the
// map tooltip can't drift apart.
//
// The fallback for unnamed zones uses the END of the shape id: ids are either
// `crypto.randomUUID()` or, in non-secure contexts (plain-http LAN testing,
// where randomUUID doesn't exist), `shape-<timestamp>-<random6>`. The tail is
// random in both formats — the head of the second format is the constant
// literal "shape-", which is how every unnamed zone once read as "Zone shape-".
export function zoneDisplayName(shape: { id: string; name?: string }): string {
  return shape.name ?? `Zone ${shape.id.slice(-6)}`;
}
