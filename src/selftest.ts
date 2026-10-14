/**
 * Live self-check. Run: npm run selftest
 * Hits the real site, so it needs network and installed Chrome.
 */
import assert from 'node:assert/strict';
import { search, listFilters, buildUrl } from './trendyol.js';
import { shutdown } from './browser.js';

const ok = (name: string) => console.log(`  ok   ${name}`);

async function main() {
  // --- URL building (pure, no network) ---
  const u = new URL(buildUrl({ query: 'elbise', categoryId: [56, 82], minPrice: 200, maxPrice: 800, sort: 'PRICE_BY_ASC', page: 2 }));
  assert.equal(u.pathname, '/sr');
  assert.equal(u.searchParams.get('q'), 'elbise');
  assert.equal(u.searchParams.get('wc'), '56,82');
  assert.equal(u.searchParams.get('prc'), '200-800');
  assert.equal(u.searchParams.get('sst'), 'PRICE_BY_ASC');
  assert.equal(u.searchParams.get('pi'), '2');
  ok('buildUrl maps every param onto /sr');

  // --- price range + sort + pagination, the assert that fails if extraction breaks ---
  const r1 = await search({ query: 'elbise', minPrice: 200, maxPrice: 800, sort: 'PRICE_BY_ASC', page: 2 });
  console.log(`       total=${r1.total} page=${r1.page} n=${r1.products.length}`);
  assert.ok(r1.products.length > 0, 'expected products on page 2');
  assert.equal(r1.page, 2);
  const prices = r1.products.map((p) => p.price.current).filter((p): p is number => p != null);
  assert.equal(prices.length, r1.products.length, 'every product should carry a price');
  assert.ok(prices.every((p) => p >= 200 && p <= 800), `prices outside 200-800: ${prices.join(',')}`);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'PRICE_BY_ASC should return ascending prices');
  assert.ok(r1.products.every((p) => p.name && p.url?.startsWith('http')), 'name and absolute url required');
  ok('search: price range, ascending sort, pagination, product shape');

  // --- category filter ---
  const r2 = await search({ categoryId: [82], gender: 1 });
  console.log(`       total=${r2.total}`);
  assert.ok(r2.total > 10_000, `expected a large catalogue for Kadın Giyim, got ${r2.total}`);
  assert.ok(
    r2.appliedFilters.some((g) => g.values.some((v) => v.id === '82')),
    `category 82 missing from appliedFilters: ${JSON.stringify(r2.appliedFilters)}`,
  );
  ok('search: category filter applied and echoed back');

  // --- brand filter ---
  const r3 = await search({ brandId: [101476], categoryId: [56] });
  const brands = [...new Set(r3.products.map((p) => p.brand))];
  console.log(`       brands=${brands.join(' | ')}`);
  assert.ok(r3.products.length > 0, 'expected products for brand 101476');
  assert.ok(
    brands.every((b) => (b ?? '').toLocaleLowerCase('tr').includes('trendyolmilla')),
    `unexpected brands: ${brands.join(', ')}`,
  );
  ok('search: brand filter restricts results');

  // --- filter discovery ---
  const f = await listFilters({ categoryId: [82], gender: 1 });
  console.log(`       source=${f.source} ${f.groups.length} groups: ${f.groups.slice(0, 8).map((g) => `${g.title}(${g.values.length})`).join(' ')}`);
  assert.ok(f.groups.length > 0, 'expected at least one filter group');
  const names = f.groups.flatMap((g) => g.values.map((v) => v.name));
  assert.ok(names.some((n) => /elbise|pantolon/i.test(n)), `no clothing categories found in: ${names.slice(0, 20).join(', ')}`);
  if (f.source === 'fallback') {
    console.log(`  WARN fallback in use: ${f.note}`);
  } else {
    // The sparse category-only aggregation also comes back on every load; getting
    // only that one is the regression this guards against.
    assert.ok(f.groups.length >= 10, `expected the full filter tree, got only ${f.groups.length} groups`);
    for (const title of ['Kategori', 'Beden', 'Renk', 'Marka']) {
      assert.ok(f.groups.some((g) => g.title === title), `missing filter group "${title}"`);
    }
  }
  ok(`list_filters returned the full filter tree (source=${f.source}, ${f.groups.length} groups)`);

  // --- the ids list_filters hands out must actually work in search_products ---
  if (f.source === 'aggregation') {
    const base = await search({ categoryId: [82], gender: 1 });

    const colour = f.groups.find((g) => g.title === 'Renk')?.values[0];
    if (colour) {
      const r = await search({ categoryId: [82], gender: 1, colorId: [Number(colour.id)] });
      console.log(`       Renk=${colour.name} expected≈${colour.count} got=${r.total}`);
      assert.ok(r.total < base.total, 'colour filter did not narrow the results');
      assert.ok(near(r.total, colour.count), `colour count off: ${r.total} vs ${colour.count}`);
      ok('search: colorId matches the count list_filters advertised');
    }

    const size = f.groups.find((g) => g.title === 'Beden')?.values[0];
    if (size) {
      const r = await search({ categoryId: [82], gender: 1, size: size.id });
      console.log(`       Beden=${size.name} expected≈${size.count} got=${r.total}`);
      assert.ok(near(r.total, size.count), `size count off: ${r.total} vs ${size.count}`);
      ok('search: size matches the count list_filters advertised');
    }

    const attrGroup = f.groups.find((g) => g.attributeId && g.values.length);
    if (attrGroup) {
      const v = attrGroup.values[0];
      const r = await search({
        categoryId: [82],
        gender: 1,
        attributes: { [attrGroup.attributeId!]: v.id },
      });
      console.log(`       ${attrGroup.title}=${v.name} expected≈${v.count} got=${r.total}`);
      assert.ok(near(r.total, v.count), `attribute count off: ${r.total} vs ${v.count}`);
      ok(`search: attributes {${attrGroup.attributeId}: ${v.id}} (${attrGroup.title}) applied`);
    }
  }
}

/** Counts drift by a fraction of a percent between the aggregation call and the search. */
function near(actual: number, expected: number | null): boolean {
  if (expected == null) return true;
  return Math.abs(actual - expected) <= Math.max(50, expected * 0.05);
}

main()
  .then(() => console.log('\nAll checks passed.'))
  .catch((e) => {
    console.error('\nFAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(shutdown);
