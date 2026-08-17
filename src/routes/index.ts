import { Hono } from "hono";
import catalogRoute from "./catalog.route"
import tileRoute from "./tiles.route"

const routes = new Hono();

routes.route('/catalog', catalogRoute)
routes.route('/tiles', tileRoute)

export default routes;