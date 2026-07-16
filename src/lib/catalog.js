// Catalog grouping: one card per parent_asin with children as variant chips.
// bronze.products records standalone items with parent_asin = NULL or the
// literal string '#N/A' (Finale export artifact) — both mean "no parent".

const NO_PARENT = new Set(['', '#N/A', 'N/A', null, undefined]);

export function groupKey(product) {
  return NO_PARENT.has(product.parent_asin) ? product.asin : product.parent_asin;
}

/**
 * Groups products by parent. Returns an array of
 * { key, representative, children } sorted by best sort_weight, then title.
 * `children` is every member (length 1 for standalone products), sorted by
 * sort_weight desc then price asc; `representative` is children[0].
 */
export function groupByParent(products) {
  const groups = new Map();
  for (const p of products) {
    const key = groupKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const result = [];
  for (const [key, members] of groups) {
    members.sort(
      (a, b) => (b.sort_weight ?? 0) - (a.sort_weight ?? 0) || (a.item_price ?? Infinity) - (b.item_price ?? Infinity) || a.asin.localeCompare(b.asin)
    );
    result.push({ key, representative: members[0], children: members });
  }
  result.sort(
    (a, b) =>
      (b.representative.sort_weight ?? 0) - (a.representative.sort_weight ?? 0) ||
      (a.representative.display_title ?? '').localeCompare(b.representative.display_title ?? '')
  );
  return result;
}

/**
 * Short per-variant chip label: the part of the title that differs from its
 * siblings (common prefix/suffix stripped). Falls back to price, then ASIN.
 */
export function variantLabel(product, siblings) {
  if (siblings.length <= 1) return null;
  const titles = siblings.map((s) => s.display_title ?? '');
  const mine = product.display_title ?? '';
  const others = titles.filter((t, i) => siblings[i].asin !== product.asin);

  let prefix = mine.length;
  for (const t of others) {
    let i = 0;
    while (i < prefix && i < t.length && mine[i] === t[i]) i++;
    prefix = Math.min(prefix, i);
  }
  let suffix = mine.length;
  for (const t of others) {
    let i = 0;
    while (i < suffix && i < t.length && mine[mine.length - 1 - i] === t[t.length - 1 - i]) i++;
    suffix = Math.min(suffix, i);
  }
  const distinct = mine.slice(prefix, mine.length - suffix).replace(/^[\s,\-–|]+|[\s,\-–|]+$/g, '');
  if (distinct && distinct.length <= 40) return distinct;
  if (product.item_price != null && siblings.filter((s) => s.item_price === product.item_price).length === 1) {
    return `$${product.item_price.toFixed(2)}`;
  }
  return product.asin;
}

export function formatPrice(value) {
  return value == null ? null : `$${value.toFixed(2)}`;
}
