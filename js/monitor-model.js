export function thresholdMetrics(price, threshold) {
  if (!isFinite(price) || price <= 0 || !isFinite(threshold) || threshold <= 0) {
    return {
      available: false,
      status: "Price unavailable",
      statusClass: "unavailable",
      statusRank: 2,
      difference: NaN,
      percent: NaN,
      meterPosition: 50,
    };
  }

  const difference = price - threshold;
  const percent = (difference / threshold) * 100;
  const inBuyZone = difference <= 0;

  return {
    available: true,
    status: inBuyZone ? "Buy zone" : "Monitoring",
    statusClass: inBuyZone ? "buy-zone" : "monitoring",
    statusRank: inBuyZone ? 0 : 1,
    difference,
    percent,
    // A fixed ±50% scale: -50% = far left, threshold = center, +50% = far right.
    meterPosition: Math.max(0, Math.min(100, 50 + percent)),
  };
}

export function sortByThreshold(rows) {
  return [...rows].sort((a, b) => {
    const aMetrics = thresholdMetrics(a.quote?.c, a.monitor.buyThreshold);
    const bMetrics = thresholdMetrics(b.quote?.c, b.monitor.buyThreshold);
    if (aMetrics.statusRank !== bMetrics.statusRank) {
      return aMetrics.statusRank - bMetrics.statusRank;
    }

    const aDistance = aMetrics.available ? Math.abs(aMetrics.percent) : Infinity;
    const bDistance = bMetrics.available ? Math.abs(bMetrics.percent) : Infinity;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return a.monitor.symbol.localeCompare(b.monitor.symbol);
  });
}
