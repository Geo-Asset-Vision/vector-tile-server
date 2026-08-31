import { describe, expect, it } from 'vitest';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import { getTile } from '../src/services/tile.service';

const run = process.env.RUN_VT_INTEGRATION === '1' ? describe : describe.skip;

run('MVT stable feature IDs', () => {
  it.each(['sample_points', 'sample_lines', 'sample_polygons'])('decodes %s ID matching source primary key', async (catalogId) => {
    const result = await getTile({ catalogId, z: 8, x: 203, y: 132 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tile = new VectorTile(new Protobuf(result.data));
    const layer = tile.layers[catalogId];
    expect(layer).toBeDefined();
    const feature = layer.feature(0);
    // Stable ID is external feature id; removed from properties by ST_AsMVT.
    expect(feature.id).toBe(1);
    expect(feature.properties.id).toBeUndefined();
  });
});
