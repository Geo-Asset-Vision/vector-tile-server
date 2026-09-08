import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SemanticSearchError } from '@/libs/semantic/contracts';
import { getRetrievalService } from '@/libs/semantic/runtime';
import type { RetrievalService } from '@/libs/semantic/retrieval';
import { registerSemanticSearchTools } from './semantic-search.tools';

vi.mock('@/libs/semantic/runtime', () => ({
    getRetrievalService: vi.fn(),
}));

const mockedGetService = vi.mocked(getRetrievalService);

interface Harness {
    client: Client;
    server: McpServer;
    fake: RetrievalService;
    close: () => Promise<void>;
}

const sampleResponse = {
    query: 'jalan banjir',
    results: [
        {
            layer: { schema: 'public', table: 'site_plan', geometry: 'geom' } as const,
            catalogId: 'public.site_plan',
            geometryType: 'MultiLineStringZ',
            score: 0.79,
            tableDescription: 'Rencana tapak (site plan)',
            geometryDescription: 'Jalan (roads) within the site',
        },
    ],
};

async function makeHarness(): Promise<Harness> {
    const fake = {
        search: vi.fn(),
    } as unknown as RetrievalService;
    mockedGetService.mockResolvedValue(fake);

    const server = new McpServer({ name: 'semantic-test', version: '0.0.0' });
    registerSemanticSearchTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'semantic-test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return {
        client,
        server,
        fake,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}

async function callTool(
    h: Harness,
    args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
    const res = (await h.client.callTool({
        name: 'search_spatial_catalogs',
        arguments: args,
    })) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
    };
    const text = res.content?.[0]?.text ?? '';
    return { text, isError: res.isError };
}

afterEach(() => {
    vi.clearAllMocks();
});

describe('search_spatial_catalogs registration', () => {
    it('lists the tool in the server registry', async () => {
        const server = new McpServer({ name: 'semantic-test', version: '0.0.0' });
        registerSemanticSearchTools(server);
        // Registration is import-lazy: building the server must not build the
        // retrieval service (which would load the model + Valkey).
        expect(mockedGetService).not.toHaveBeenCalled();
    });
});

describe('search_spatial_catalogs happy path', () => {
    it('delegates to RetrievalService with EXACT filters and returns ranked metadata + score only', async () => {
        const h = await makeHarness();
        try {
            vi.mocked(h.fake.search).mockResolvedValue(sampleResponse);

            const { text, isError } = await callTool(h, {
                query: '  jalan banjir  ',
                top_k: 5,
                schema: 'public',
                geometry_type: '  MULTILINESTRING  ',
            });

            expect(isError).toBeUndefined();
            // Trimmed query, filters pass through with case-insensitive
            // normalized geometry_type.
            expect(h.fake.search).toHaveBeenCalledTimes(1);
            expect(h.fake.search).toHaveBeenCalledWith('jalan banjir', {
                topK: 5,
                schema: 'public',
                geometryType: 'multilinestring',
            });

            const parsed = JSON.parse(text) as {
                query: string;
                total_results: number;
                results: Array<Record<string, unknown>>;
            };
            expect(parsed.query).toBe('jalan banjir');
            expect(parsed.total_results).toBe(1);
            const r = parsed.results[0]!;
            expect(r).toEqual({
                layer: { schema: 'public', table: 'site_plan', geometry: 'geom' },
                catalogId: 'public.site_plan',
                geometryType: 'MultiLineStringZ',
                score: 0.79,
                tableDescription: 'Rencana tapak (site plan)',
                geometryDescription: 'Jalan (roads) within the site',
            });
            // Never raw vectors or embedding internals.
            expect(JSON.stringify(parsed)).not.toContain('vector');
        } finally {
            await h.close();
        }
    });

    it('omits top_k when absent (default handled by RetrievalService)', async () => {
        const h = await makeHarness();
        try {
            vi.mocked(h.fake.search).mockResolvedValue({ query: 'tanah', results: [] });
            await callTool(h, { query: 'tanah' });
            expect(h.fake.search).toHaveBeenCalledWith('tanah', {});
        } finally {
            await h.close();
        }
    });
});

describe('search_spatial_catalogs input validation', () => {
    it.each([
        [{ query: '   ' }, /blank/],
        [{ query: '' }, /blank/],
        [{}, /(blank|query)/],
        [{ query: 'x', top_k: 0 }, /top_k/],
        [{ query: 'x', top_k: -1 }, /top_k/],
        [{ query: 'x', top_k: 1.5 }, /top_k/],
        [{ query: 'x', top_k: 101 }, /top_k/],
    ])('rejects invalid args %j', async (args, re) => {
        const h = await makeHarness();
        try {
            const res = (await h.client.callTool({
                name: 'search_spatial_catalogs',
                arguments: args,
            })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
            // The SDK maps a Zod rejection to isError:true with the parse error
            // text (JSON-RPC InvalidParams is caught inside CallTool).
            expect(res.isError).toBe(true);
            const text = res.content?.[0]?.text ?? '';
            expect(text).toMatch(re);
            expect(h.fake.search).not.toHaveBeenCalled();
        } finally {
            await h.close();
        }
    });
});

describe('search_spatial_catalogs typed error mapping', () => {
    it.each([
        ['MODEL_UNAVAILABLE', 'local model missing; run `pnpm semantic:prefetch`'],
        ['INDEX_NOT_FOUND', 'no index manifest has been published; run `pnpm semantic:refresh`'],
        ['INDEX_UNAVAILABLE', 'valkey store degraded'],
        ['VERSION_MISMATCH', 'stored index was embedded with a different model; re-run `pnpm semantic:refresh`'],
        ['INVALID_ARGS', 'search query must not be blank'],
        ['INTERNAL', 'unexpected failure'],
    ] as const)('maps %s to an isError response with code + actionable message', async (code, message) => {
        const h = await makeHarness();
        try {
            vi.mocked(h.fake.search).mockRejectedValue(new SemanticSearchError(code, message));
            const { text, isError } = await callTool(h, { query: 'jalan' });
            expect(isError).toBe(true);
            const parsed = JSON.parse(text) as { code: string; message: string };
            expect(parsed.code).toBe(code);
            expect(parsed.message).toBe(message);
        } finally {
            await h.close();
        }
    });

    it('maps unknown errors to a generic isError response (never a silent empty result)', async () => {
        const h = await makeHarness();
        try {
            vi.mocked(h.fake.search).mockRejectedValue(new Error('boom'));
            const { text, isError } = await callTool(h, { query: 'jalan' });
            expect(isError).toBe(true);
            expect(text).toContain('boom');
        } finally {
            await h.close();
        }
    });
});
