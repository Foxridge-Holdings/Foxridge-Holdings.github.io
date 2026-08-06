// Combines every purchase lot for one symbol and owner into a single position.
// If an owner is not supplied, the first matching lot provides the owner so
// older symbol-only detail URLs keep working.
export function aggregateHoldingLots(holdings, symbol, requestedOwner = "") {
  const symbolLots = holdings.filter((h) => h.symbol === symbol);
  if (!symbolLots.length) return null;

  const owner = requestedOwner || symbolLots[0].owner;
  const lots = symbolLots.filter((h) => h.owner === owner);
  if (!lots.length) return null;

  const shares = lots.reduce((sum, h) => sum + h.shares, 0);
  const totalCostNative = lots.reduce((sum, h) => sum + h.totalCostNative, 0);
  const totalCostUsd = lots.every((h) => isFinite(h.totalCostUsd))
    ? lots.reduce((sum, h) => sum + h.totalCostUsd, 0)
    : NaN;
  const joinUnique = (field) => [
    ...new Set(lots.map((h) => h[field]).filter(Boolean)),
  ].join(", ");

  return {
    ...lots[0],
    owner,
    shares,
    unitCost: shares > 0 ? totalCostNative / shares : 0,
    totalCostNative,
    totalCostUsd,
    client: lots.some((h) => h.client),
    platform: joinUnique("platform"),
    note: joinUnique("note"),
  };
}
