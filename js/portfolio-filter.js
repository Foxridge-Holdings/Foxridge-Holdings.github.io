export const ALL = "All";

export function rowsForScope(rows, owner = ALL, country = ALL) {
  return rows.filter((row) =>
    (owner === ALL || row.holding.owner === owner) &&
    (country === ALL || row.holding.market === country),
  );
}

export function cashForScope(cash, owner = ALL, country = ALL) {
  if (country !== ALL) return [];
  return cash.filter((entry) => owner === ALL || entry.owner === owner);
}

export function countriesForOwner(rows, owner = ALL) {
  return [...new Set(
    rowsForScope(rows, owner).map((row) => row.holding.market).filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

export function ownersForPortfolio(rows, cash) {
  return [...new Set([
    ...rows.map((row) => row.holding.owner),
    ...cash.map((entry) => entry.owner),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
