export const PRODUCTS = {
  'Aura de-Alpine': 2499,
  'Pine & Essence': 2499,
  'KO HER': 2499,
  'Misty Peaks': 2499
};

export function priceFor(name) {
  return PRODUCTS[name] ?? null;
}
