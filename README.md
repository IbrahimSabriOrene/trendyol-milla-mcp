# trendyol-milla-mcp

MCP server for searching clothing on [trendyol-milla.com](https://www.trendyol-milla.com/),
driven through a real Chrome instance via Playwright.

## Setup

```bash
npm install && npm run build
```

Requires Google Chrome installed (the server drives it via `channel: 'chrome'`; no Playwright
browser download needed).

Register it with Claude Code:

```bash
claude mcp add trendyol-milla -- node "/absolute/path/to/trendyol-milla-mcp/dist/index.js"
```

## Tools

**`list_filters`** — the filter tree for a search context: Kategori, Beden, Renk, Marka, Fiyat and
~14 attribute facets (Kalıp, Yaka Tipi, Desen, Boy, Kumaş Tipi, …), each value with an id and a
result count. Call this first to get ids.

**`search_products`** — `query`, `categoryId[]`, `brandId[]`, `gender`, `minPrice`/`maxPrice`,
`colorId[]`, `size`, `attributes`, `sort`, `page`. Returns products with price, rating, category
and a direct URL, plus `appliedFilters` — what the site actually matched, which can differ from
what was asked (a free-text query often resolves to a category on its own).

The site is Turkish: queries and returned names are Turkish, prices TRY, 24 products per page.

## Why a browser

Plain HTTP does not work, and this was measured rather than assumed:

- Fetching the site directly returns **403**.
- The JSON gateway (`apigw.trendyol-milla.com`) returns **400 "Required country information is
  wrong or missing"** even when called with the site's own `_links` URLs.
- **Headless Chrome is blocked by Cloudflare** — with the stealth plugin, and with patchright.
  Headful passes. So the server runs a real Chrome window parked off-screen at
  `--window-position=-32000,-32000`. Set `TRENDYOL_MCP_VISIBLE=1` to watch it while debugging.

Products are read out of the page's own SSR state blob (`window['__single-search-result__PROPS']`),
not scraped from the DOM — so there are no CSS selectors to rot.

## Query parameters

All verified against the live site by checking that a URL reproduces the result count the site's
own filter panel advertises. Only `/sr?...` URLs are built: the human-readable slug paths
(`/kadin-giyim-x-g1-c82`) redirect there anyway, and appending query params to a slug corrupts the
request — the `?` gets swallowed into `q`.

| Param | Meaning | Multi-value |
|---|---|---|
| `q` | free text | — |
| `wc` | category ids | comma |
| `wb` | brand ids | comma |
| `wg` | gender (1 = kadın) | — |
| `prc` | price range, `min-max` | — |
| `wcl` | colour ids | comma |
| `vr` | size, as `size\|group-m` | **no** — extra values silently ignored |
| `attr` | attributes, as `179\|1993,191\|2146` | distinct attributes AND together; **one value per attribute** |
| `sst` | `SCORE` `PRICE_BY_ASC` `PRICE_BY_DESC` `MOST_RECENT` `BEST_SELLER` `MOST_FAVOURITE` `MOST_RATED` | — |
| `pi` | page index | — |

Toggle filters (flash sale, rush delivery, product rating) appear in `list_filters` with
`param: null` — their parameters were not pinned down, so none is invented.

## Verify

```bash
npm run selftest
```

Hits the live site and asserts against it: price range and ascending sort hold, pagination lands
on page 2, a brand filter leaves only that brand, the full 30-group filter tree comes back, and
ids handed out by `list_filters` reproduce their advertised counts through `search_products`.
