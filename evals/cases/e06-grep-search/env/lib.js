export function computeTotal(items) {
  return items.reduce((s, i) => s + i.price, 0);
}
