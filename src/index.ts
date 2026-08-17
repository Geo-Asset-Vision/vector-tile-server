import env from '@/libs/env'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { openAPIRouteHandler } from 'hono-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { logger } from 'hono/logger'
import { disconnect, checkConnection } from '@/libs/db'
import { cors } from 'hono/cors'
import appRouter from '@/routes'


if (!await checkConnection()) {
  process.exit(1);
}

if (!env.API_KEY) {
  console.warn(`[SECURITY] => env API_KEY is not set. Set API_KEY in .env file or you can create one using 'pnpm generate:api-key'`);
  console.warn('[SECURITY] => Starting Server Without API Key Protection')
} else {
  console.log('[SECURITY] => API Key Protection is Enabled')
}

const app = new Hono()
app.use(logger())
app.use('*', cors())
app.get('/', (c) => {
  return c.text(`Vector Tile Server is running. Visit ${env.APP_BASE_URL}/docs for more information.`)
})

app.route('/', appRouter)

app.get('/openapi', openAPIRouteHandler(app, {
  documentation: {
    components: {
      securitySchemes: {
        API_KEY: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        }
      }
    }
  }
}))

app.get('/docs', Scalar({
  url: '/openapi',
  theme: "alternate"
}));

app.onError((err, c) => {
  console.error(`${err}`)

  if (c.req.header('Accept')?.includes('text/html')) {
    return c.html(`<h1>Internal Server Error</h1><p>Please try again later.</p>`, 500)
  } else {
    return c.json({ error: 'Internal Server Error' }, 500)
  }
})


const server = serve({
  fetch: app.fetch,
  port: env.APP_PORT
}, () => {
  console.log(`[WEB SERVER] => Server is running on ${env.APP_BASE_URL}`)
})


// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received');
  console.log('Closing HTTP server...');
  server.close();
  console.log('HTTP server closed');
  console.log('Closing database pool...');
  await disconnect();
  console.log('Database pool closed');
  console.log('Process exiting...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received');
  console.log('Closing HTTP server...');
  server.close();
  console.log('HTTP server closed');
  console.log('Closing database pool...');
  await disconnect();
  console.log('Database pool closed');
  console.log('Process exiting...');
  process.exit(0);
});