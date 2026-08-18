import { Hono } from "hono";
import catalogRoute from "./catalog.route";
import tileRoute from "./tiles.route";
import { cacheMetrics } from "@/libs/cache";

const routes = new Hono();

routes.route('/catalog', catalogRoute);
routes.route('/tiles', tileRoute);

routes.get('/metrics', (c) => {
    const accept = c.req.header('Accept');
    if (accept && accept.includes('application/json')) {
        return c.json(cacheMetrics.getSnapshot());
    }
    return c.text(cacheMetrics.toPrometheus(), 200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
});

export default routes;