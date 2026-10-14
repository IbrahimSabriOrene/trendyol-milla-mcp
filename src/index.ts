#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { search, listFilters, SORTS, PAGE_SIZE, type SearchParams } from './trendyol.js';
import { shutdown } from './browser.js';

const filterShape = {
  query: z.string().optional().describe('Free-text search, in Turkish (e.g. "elbise", "keten pantolon").'),
  categoryId: z
    .array(z.number().int())
    .optional()
    .describe('Category ids from list_filters (e.g. 82 = Kadın Giyim, 56 = Elbise).'),
  brandId: z.array(z.number().int()).optional().describe('Brand ids from list_filters (e.g. 101476 = TRENDYOLMİLLA).'),
  gender: z.number().int().optional().describe('Gender id; 1 = kadın.'),
  minPrice: z.number().nonnegative().optional().describe('Minimum price in TRY.'),
  maxPrice: z.number().nonnegative().optional().describe('Maximum price in TRY.'),
  colorId: z
    .array(z.number().int())
    .optional()
    .describe('Colour ids from the "Renk" group of list_filters. Several colours OR together.'),
  size: z
    .string()
    .optional()
    .describe(
      'One size id from the "Beden" group of list_filters, e.g. "group-m". ' +
        'Only one size at a time — the site ignores additional ones.',
    ),
  attributes: z
    .record(z.string())
    .optional()
    .describe(
      'Attribute filters as {attributeId: valueId}, e.g. {"179":"1993"} for Kalıp=A-line. ' +
        'Take attributeId from a group\'s attributeId and valueId from its values in list_filters. ' +
        'Different attributes AND together; only one value per attribute is honoured.',
    ),
  extraParams: z
    .record(z.string())
    .optional()
    .describe('Raw query params passed straight through, for filter groups list_filters reports with a param but no argument.'),
};

const searchShape = {
  ...filterShape,
  sort: z.enum(SORTS).optional().describe('Result ordering. Defaults to SCORE (site relevance).'),
  page: z.number().int().min(1).optional().describe(`1-based page index; ${PAGE_SIZE} products per page.`),
};

/** At least one real constraint — an unfiltered /sr query returns nothing useful. */
function assertConstrained(a: SearchParams): void {
  if (!a.query && !a.categoryId?.length && !a.brandId?.length && a.gender == null) {
    throw new Error('Provide at least one of: query, categoryId, brandId, gender.');
  }
  if (a.minPrice != null && a.maxPrice != null && a.minPrice > a.maxPrice) {
    throw new Error(`minPrice (${a.minPrice}) is greater than maxPrice (${a.maxPrice}).`);
  }
}

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: 'trendyol-milla', version: '1.0.0' });

server.registerTool(
  'search_products',
  {
    title: 'Search Trendyol Milla products',
    description:
      'Search clothing on trendyol-milla.com with category, brand, price and sort filters. ' +
      'The site is Turkish: queries and returned names are in Turkish, prices in TRY. ' +
      'Call list_filters first to get valid categoryId / brandId values. ' +
      'The response includes appliedFilters — what the site actually matched, which may differ ' +
      'from what was requested (a free-text query often resolves to a category on its own).',
    inputSchema: searchShape,
  },
  async (args) => {
    assertConstrained(args);
    return json(await search(args));
  },
);

server.registerTool(
  'list_filters',
  {
    title: 'List available Trendyol Milla filters',
    description:
      'Return the filter options available within a search context — categories (Kategori), sizes ' +
      '(Beden), colours (Renk), brands (Marka), price bands (Fiyat) and ~14 attribute facets such ' +
      'as Kalıp, Yaka Tipi, Desen, Boy and Kumaş Tipi — each with ids and result counts. ' +
      'Group titles are Turkish. Use this to discover the ids that search_products takes: each ' +
      'group names the search_products argument that carries it, and groups with a param but no ' +
      'argument can be passed through extraParams. ' +
      'If the response has source="fallback", the site\'s filter data did not load and the groups ' +
      'are an incomplete stand-in — see the accompanying note.',
    inputSchema: filterShape,
  },
  async (args) => {
    assertConstrained(args);
    return json(await listFilters(args));
  },
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown().finally(() => process.exit(0)));
}

const transport = new StdioServerTransport();
// Chrome outlives this process if we don't clean up when the client disconnects.
transport.onclose = () => void shutdown().finally(() => process.exit(0));

await server.connect(transport);
