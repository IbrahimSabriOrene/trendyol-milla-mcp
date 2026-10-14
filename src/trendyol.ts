import type { Page, Response } from 'playwright-core';
import { withPage } from './browser.js';

const ORIGIN = 'https://www.trendyol-milla.com';
/**
 * Only ever build `/sr?...` URLs. The human-readable slug paths
 * (e.g. /kadin-giyim-x-g1-c82) redirect here anyway, and appending query params
 * to a slug corrupts the request — the `?` gets swallowed into `q`.
 */
const SEARCH_URL = `${ORIGIN}/sr`;
export const PAGE_SIZE = 24;

export const SORTS = [
  'SCORE',
  'PRICE_BY_ASC',
  'PRICE_BY_DESC',
  'MOST_RECENT',
  'BEST_SELLER',
  'MOST_FAVOURITE',
  'MOST_RATED',
] as const;
export type Sort = (typeof SORTS)[number];

export interface SearchParams {
  query?: string;
  categoryId?: number[];
  brandId?: number[];
  gender?: number;
  minPrice?: number;
  maxPrice?: number;
  colorId?: number[];
  size?: string;
  /** attributeId -> valueId. One value per attribute; see buildUrl. */
  attributes?: Record<string, string>;
  sort?: Sort;
  page?: number;
  extraParams?: Record<string, string>;
}

export function buildUrl(p: SearchParams): string {
  const q = new URLSearchParams();
  if (p.query) q.set('q', p.query);
  if (p.categoryId?.length) q.set('wc', p.categoryId.join(','));
  if (p.brandId?.length) q.set('wb', p.brandId.join(','));
  if (p.gender != null) q.set('wg', String(p.gender));
  if (p.minPrice != null || p.maxPrice != null) {
    q.set('prc', `${p.minPrice ?? 0}-${p.maxPrice ?? 999999}`);
  }
  // Colours OR together. Sizes and attributes do not: the backend silently keeps only
  // the first value per attribute, so these stay single-valued rather than lying.
  if (p.colorId?.length) q.set('wcl', p.colorId.join(','));
  if (p.size) q.set('vr', `size|${p.size}`);
  const attrs = Object.entries(p.attributes ?? {});
  if (attrs.length) q.set('attr', attrs.map(([id, v]) => `${id}|${v}`).join(','));
  if (p.sort && p.sort !== 'SCORE') q.set('sst', p.sort);
  if (p.page && p.page > 1) q.set('pi', String(p.page));
  for (const [k, v] of Object.entries(p.extraParams ?? {})) q.set(k, v);
  return `${SEARCH_URL}?${q.toString()}`;
}

export interface Product {
  id: number | null;
  name: string;
  brand: string | null;
  category: { id: number | null; name: string | null } | null;
  price: { current: number | null; original: number | null; currency: string | null };
  discountPercent: number | null;
  rating: { score: number | null; count: number | null };
  url: string | null;
  image: string | null;
  freeCargo: boolean;
  fastDelivery: boolean;
}

export interface SearchResult {
  total: number;
  page: number;
  pageCount: number;
  requestUrl: string;
  appliedFilters: { group: string; values: { id: string; name: string }[] }[];
  products: Product[];
}

/** Read the SSR state blob the page exposes. No DOM scraping, no CSS selectors. */
async function readProps(page: Page): Promise<any> {
  return page.evaluate(() => {
    const p = (window as any)['__single-search-result__PROPS'];
    const d = p?.data ?? {};
    const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    const products = (Array.isArray(d.products) ? d.products : []).map((x: any) => ({
      id: num(x.id),
      name: String(x.name ?? ''),
      brand: x.brand ?? null,
      category: x.category ? { id: num(x.category.id), name: x.category.name ?? null } : null,
      price: {
        current: num(x.price?.current ?? x.price?.discountedPrice),
        original: num(x.price?.originalPrice ?? x.price?.old),
        currency: x.price?.currency ?? null,
      },
      discountPercent: num(typeof x.discount === 'object' ? x.discount?.rate : x.discount),
      rating: {
        // ratingScore is an object on most cards but a bare number on some.
        score: num(typeof x.ratingScore === 'object' ? x.ratingScore?.averageRating : x.ratingScore),
        count: num(x.ratingScore?.totalCount),
      },
      url: x.url ?? null,
      image: x.image ?? (Array.isArray(x.images) ? x.images[0] : null) ?? null,
      freeCargo: !!x.freeCargo,
      fastDelivery: !!x.hasFastDeliveryTag,
    }));

    return {
      total: num(d.total) ?? 0,
      pageIndex: num(d.pageIndex) ?? 1,
      resolvedFilters: d.resolvedQuery?.filters ?? [],
      canonicalFilters: d.canonicalFilters ?? {},
      products,
    };
  });
}

const CDN = 'https://cdn.dsmcdn.com';
const absolutize = (u: string | null, base: string) =>
  !u ? null : u.startsWith('http') ? u : base + (u.startsWith('/') ? u : '/' + u);

/**
 * What the backend *actually* applied. A free-text query silently resolves to a
 * category (q=elbise -> category 56), and unknown ids get dropped — surfacing this
 * is what lets a caller notice and correct a bad request.
 */
function toAppliedFilters(props: any): SearchResult['appliedFilters'] {
  const out = new Map<string, { id: string; name: string }[]>();
  for (const f of props.resolvedFilters ?? []) {
    const vals = (f.filters ?? []).map((v: any) => ({ id: String(v.key), name: String(v.name) }));
    if (vals.length) out.set(String(f.filterKey), vals);
  }
  for (const [group, list] of Object.entries(props.canonicalFilters ?? {})) {
    if (!Array.isArray(list) || !list.length) continue;
    const vals = list
      .filter((v: any) => v && v.key != null)
      .map((v: any) => ({ id: String(v.key), name: String(v.name ?? v.beautifiedName ?? '') }));
    if (vals.length && !out.has(group)) out.set(group, vals);
  }
  return [...out].map(([group, values]) => ({ group, values }));
}

/** Navigate and wait for the SSR blob. Zero-result pages ship `data` with no `products`. */
async function gotoSearch(page: Page, url: string): Promise<void> {
  // The previous page keeps doing client-side navigation after load, which can abort
  // an in-flight goto (ERR_ABORTED). The same URL succeeds immediately on a second try.
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (e) {
    if (!/ERR_ABORTED/.test(String(e))) throw e;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await page.waitForFunction(
    () => {
      const p = (window as any)['__single-search-result__PROPS'];
      return !!p && !!p.data;
    },
    undefined,
    { timeout: 30_000 },
  );
}

export function search(params: SearchParams): Promise<SearchResult> {
  const url = buildUrl(params);
  return withPage(async (page) => {
    await gotoSearch(page, url);
    let props = await readProps(page);
    if (!props.products.length && props.total > 0) {
      // Blob was present but not yet filled; one reload is cheaper than a retry policy.
      await page.reload({ waitUntil: 'domcontentloaded' });
      props = await readProps(page);
    }
    return {
      total: props.total,
      page: props.pageIndex,
      pageCount: Math.ceil(props.total / PAGE_SIZE),
      requestUrl: url,
      appliedFilters: toAppliedFilters(props),
      products: props.products.map((p: Product) => ({
        ...p,
        url: absolutize(p.url, ORIGIN),
        image: absolutize(p.image, CDN),
      })),
    };
  });
}

export interface FilterValue {
  id: string;
  name: string;
  count: number | null;
  /** Exact string to send for this option, when `param` is set. */
  value: string;
}

export interface FilterGroup {
  group: string;
  title: string;
  /** search_products argument that carries this group, if it has one. */
  argument: string | null;
  /** Underlying query param, for use via extraParams when `argument` is null. */
  param: string | null;
  /** Whether several values of this group can be combined. */
  multiple: boolean;
  /** For attribute groups: the key to use in the `attributes` argument. */
  attributeId: string | null;
  values: FilterValue[];
}

export interface FilterResult {
  requestUrl: string;
  total: number;
  source: 'aggregation' | 'fallback';
  note?: string;
  groups: FilterGroup[];
}

/**
 * Map a filter group onto the query param that carries it. Every mapping here was
 * verified against the live site by checking that the resulting URL reproduces the
 * option's own result count:
 *   wc / wb / wg / prc  take bare ids and OR together
 *   wcl=2,3             colours OR together
 *   vr=size|group-m     one size only — extra values are silently ignored
 *   attr=179|1993,191|2146   distinct attributes AND together, one value each
 */
function paramFor(g: any): Pick<FilterGroup, 'argument' | 'param' | 'multiple'> & { encode: (id: string) => string } {
  const bare = (id: string) => id;
  switch (String(g.group)) {
    case 'CATEGORY':
      return { argument: 'categoryId', param: 'wc', multiple: true, encode: bare };
    case 'BRAND':
      return { argument: 'brandId', param: 'wb', multiple: true, encode: bare };
    case 'GENDER':
      return { argument: 'gender', param: 'wg', multiple: false, encode: bare };
    case 'PRICE':
      return { argument: 'minPrice/maxPrice', param: 'prc', multiple: false, encode: bare };
    case 'VARIANT':
      return { argument: 'size', param: 'vr', multiple: false, encode: (id) => `size|${id}` };
    case 'ATTRIBUTE':
      return String(g.type) === 'WebColor'
        ? { argument: 'colorId', param: 'wcl', multiple: true, encode: bare }
        : { argument: 'attributes', param: 'attr', multiple: false, encode: (id) => `${g.id}|${id}` };
    default:
      // TOGGLE groups (flash sale, rush delivery, ratings...) — param not verified,
      // so don't invent one.
      return { argument: null, param: null, multiple: false, encode: bare };
  }
}

function mapAggregation(agg: any[]): FilterGroup[] {
  return (agg ?? [])
    .map((a: any) => {
      const { argument, param, multiple, encode } = paramFor(a);
      const values: FilterValue[] = (a.values ?? [])
        .filter((v: any) => v && v.id != null)
        .map((v: any) => ({
          id: String(v.id),
          name: String(v.text ?? v.beautifiedName ?? ''),
          count: typeof v.count === 'number' ? v.count : null,
          value: encode(String(v.id)),
        }));
      return {
        group: String(a.group ?? ''),
        // Attribute groups are only identifiable by their Turkish title (Renk, Beden, Kalıp...).
        title: String(a.title ?? ''),
        argument,
        param,
        multiple,
        attributeId: argument === 'attributes' ? String(a.id) : null,
        values,
      };
    })
    .filter((g) => g.values.length > 0);
}

export function listFilters(params: SearchParams): Promise<FilterResult> {
  const url = buildUrl(params);
  return withPage(async (page) => {
    // The page fires this more than once, and the extra calls return a cut-down
    // category-only aggregation. Collect them all and keep the richest, or we'd
    // silently serve one group instead of thirty.
    const seen: any[] = [];
    const onResponse = (r: Response) => {
      if (r.url().includes('/api/search/aggregations')) {
        r.json().then((j) => seen.push(j)).catch(() => {});
      }
    };
    page.on('response', onResponse);

    try {
      await gotoSearch(page, url);
      const props = await readProps(page);

      // The sidebar hydrates client-side and the aggregation call follows it.
      const best = () =>
        seen.map((j) => j?.aggregation).filter(Array.isArray).sort((a, b) => b.length - a.length)[0] ?? [];
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && best().length < 2) await page.waitForTimeout(1_000);

      const groups = mapAggregation(best());
      if (groups.length) {
        return { requestUrl: url, total: props.total, source: 'aggregation' as const, groups };
      }

      // Fallback: what we can see without the aggregation endpoint. Narrower by
      // definition — categories only, drawn from the products on this page.
      const byId = new Map<string, { id: string; name: string; count: number | null }>();
      for (const p of props.products as Product[]) {
        if (p.category?.id != null) {
          const id = String(p.category.id);
          const prev = byId.get(id);
          byId.set(id, { id, name: p.category.name ?? '', count: (prev?.count ?? 0) + 1 });
        }
      }
      return {
        requestUrl: url,
        total: props.total,
        source: 'fallback' as const,
        note:
          'The site\'s filter aggregation did not load, so this is only the categories ' +
          'present on page 1 of these results, with per-page counts — not the full filter ' +
          'tree, and no brands, colours or sizes.',
        groups: byId.size
          ? [
              {
                group: 'CATEGORY',
                title: 'Kategori',
                argument: 'categoryId',
                param: 'wc',
                multiple: true,
                attributeId: null,
                values: [...byId.values()].map((v) => ({ ...v, value: v.id })),
              },
            ]
          : [],
      };
    } finally {
      page.off('response', onResponse);
    }
  });
}
