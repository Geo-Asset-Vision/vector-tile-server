import {
    SEMANTIC_ERROR_CODES,
    type SemanticErrorCode,
} from './contracts.js';

export interface SemanticSearchMetricsSnapshot {
    searchRequests: number;
    searchLatencyTotalMs: number;
    embeddingsComputed: number;
    documentCacheHits: number;
    documentCacheMisses: number;
    queryCacheHits: number;
    queryCacheMisses: number;
    resultCacheHits: number;
    resultCacheMisses: number;
    errorsByCode: Record<SemanticErrorCode, number>;
}

/**
 * Prometheus metrics for the semantic search stack.
 *
 * Deliberately a SEPARATE registry from `src/libs/cache/metrics.ts`: every
 * line below is prefixed `semantic_search_*` so MVT cache semantics and this
 * stack stay cleanly partitionable. Cache metrics there are `mvt_cache_*`.
 */
export class SemanticSearchMetrics {
    private searchRequests = 0;
    private searchLatencyTotalMs = 0;

    private embeddingsComputed = 0;

    private documentCacheHits = 0;
    private documentCacheMisses = 0;
    private queryCacheHits = 0;
    private queryCacheMisses = 0;
    private resultCacheHits = 0;
    private resultCacheMisses = 0;

    private readonly errorsByCode = new Map<SemanticErrorCode, number>(
        SEMANTIC_ERROR_CODES.map((code) => [code, 0]),
    );

    recordSearch(durationMs: number): void {
        this.searchRequests++;
        this.searchLatencyTotalMs += durationMs;
    }

    recordEmbeddingComputed(): void {
        this.embeddingsComputed++;
    }

    recordDocumentCacheHit(): void {
        this.documentCacheHits++;
    }

    recordDocumentCacheMiss(): void {
        this.documentCacheMisses++;
    }

    recordQueryCacheHit(): void {
        this.queryCacheHits++;
    }

    recordQueryCacheMiss(): void {
        this.queryCacheMisses++;
    }

    recordResultCacheHit(): void {
        this.resultCacheHits++;
    }

    recordResultCacheMiss(): void {
        this.resultCacheMisses++;
    }

    recordError(code: SemanticErrorCode): void {
        this.errorsByCode.set(code, (this.errorsByCode.get(code) ?? 0) + 1);
    }

    getSnapshot(): SemanticSearchMetricsSnapshot {
        return {
            searchRequests: this.searchRequests,
            searchLatencyTotalMs: this.searchLatencyTotalMs,
            embeddingsComputed: this.embeddingsComputed,
            documentCacheHits: this.documentCacheHits,
            documentCacheMisses: this.documentCacheMisses,
            queryCacheHits: this.queryCacheHits,
            queryCacheMisses: this.queryCacheMisses,
            resultCacheHits: this.resultCacheHits,
            resultCacheMisses: this.resultCacheMisses,
            errorsByCode: Object.fromEntries(this.errorsByCode) as Record<
                SemanticErrorCode,
                number
            >,
        };
    }

    toPrometheus(): string {
        const s = this.getSnapshot();
        const avgLatencyMs =
            s.searchRequests > 0 ? s.searchLatencyTotalMs / s.searchRequests : 0;
        const lines: string[] = [
            '# HELP semantic_search_requests_total Total semantic search requests',
            '# TYPE semantic_search_requests_total counter',
            `semantic_search_requests_total ${s.searchRequests}`,
            '',
            '# HELP semantic_search_latency_milliseconds Total search latency in ms',
            '# TYPE semantic_search_latency_milliseconds counter',
            `semantic_search_latency_milliseconds ${s.searchLatencyTotalMs}`,
            '',
            '# HELP semantic_search_latency_average_milliseconds Average search latency in ms',
            '# TYPE semantic_search_latency_average_milliseconds gauge',
            `semantic_search_latency_average_milliseconds ${Number(avgLatencyMs.toFixed(2))}`,
            '',
            '# HELP semantic_search_embeddings_total Total embeddings computed',
            '# TYPE semantic_search_embeddings_total counter',
            `semantic_search_embeddings_total ${s.embeddingsComputed}`,
            '',
            '# HELP semantic_search_document_cache_hits_total Document LRU hits',
            '# TYPE semantic_search_document_cache_hits_total counter',
            `semantic_search_document_cache_hits_total ${s.documentCacheHits}`,
            '',
            '# HELP semantic_search_document_cache_misses_total Document LRU misses',
            '# TYPE semantic_search_document_cache_misses_total counter',
            `semantic_search_document_cache_misses_total ${s.documentCacheMisses}`,
            '',
            '# HELP semantic_search_query_cache_hits_total Query LRU hits',
            '# TYPE semantic_search_query_cache_hits_total counter',
            `semantic_search_query_cache_hits_total ${s.queryCacheHits}`,
            '',
            '# HELP semantic_search_query_cache_misses_total Query LRU misses',
            '# TYPE semantic_search_query_cache_misses_total counter',
            `semantic_search_query_cache_misses_total ${s.queryCacheMisses}`,
            '',
            '# HELP semantic_search_result_cache_hits_total Result LRU hits',
            '# TYPE semantic_search_result_cache_hits_total counter',
            `semantic_search_result_cache_hits_total ${s.resultCacheHits}`,
            '',
            '# HELP semantic_search_result_cache_misses_total Result LRU misses',
            '# TYPE semantic_search_result_cache_misses_total counter',
            `semantic_search_result_cache_misses_total ${s.resultCacheMisses}`,
            '',
            '# HELP semantic_search_errors_total Semantic search errors by code',
            '# TYPE semantic_search_errors_total counter',
        ];

        for (const code of SEMANTIC_ERROR_CODES) {
            const count = this.errorsByCode.get(code) ?? 0;
            lines.push(`semantic_search_errors_total{code="${code}"} ${count}`);
        }

        return `${lines.join('\n')}\n`;
    }

    reset(): void {
        this.searchRequests = 0;
        this.searchLatencyTotalMs = 0;
        this.embeddingsComputed = 0;
        this.documentCacheHits = 0;
        this.documentCacheMisses = 0;
        this.queryCacheHits = 0;
        this.queryCacheMisses = 0;
        this.resultCacheHits = 0;
        this.resultCacheMisses = 0;
        for (const code of SEMANTIC_ERROR_CODES) {
            this.errorsByCode.set(code, 0);
        }
    }
}

export const semanticSearchMetrics = new SemanticSearchMetrics();
