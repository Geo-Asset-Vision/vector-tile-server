import env from '@/libs/env'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { openAPIRouteHandler, generateSpecs } from 'hono-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { createMarkdownFromOpenApi } from '@scalar/openapi-to-markdown'
import { logger } from 'hono/logger'
import { disconnect, checkConnection } from '@/libs/db'
import { rateLimiter } from '@/libs/rate-limiter'
import { tileCache } from '@/libs/cache'
import { createCorsMiddleware } from '@/middleware'
import appRouter from '@/routes'

const corsOrigins = (env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
const allowAllOrigins = corsOrigins.includes('*');

if (!await checkConnection()) {
  process.exit(1);
}

if (!env.API_KEY) {
  console.warn(`[SECURITY] => env API_KEY is not set. Set API_KEY in .env file or you can create one using 'pnpm generate:api-key'`);
  console.warn('[SECURITY] => Starting Server Without API Key Protection')
} else {
  console.log('[SECURITY] => API Key Protection is Enabled')
}

if (allowAllOrigins) {
  console.log('[SECURITY] => CORS: Wildcard (*) enabled. All cross-origin browser requests allowed.');
} else if (corsOrigins.length > 0) {
  console.log(`[SECURITY] => CORS: Allowed origins: ${corsOrigins.join(', ')}`);
} else {
  console.warn('[SECURITY] => CORS: No allowed origins configured (CORS_ALLOWED_ORIGINS is empty). Cross-origin browser requests will be rejected.');
}

const app = new Hono()
app.use(logger())
app.get('/', (c) => {
  return c.text(`Vector Tile Server is running. Visit ${env.APP_BASE_URL}/docs for API docs or ${env.APP_BASE_URL}/llms.txt for LLMs.`)
})

app.use('*', createCorsMiddleware(env.CORS_ALLOWED_ORIGINS))

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
})

app.route('/', appRouter)

const openApiDocConfig = {
  documentation: {
    info: {
      title: 'Vector Tile Server API',
      version: '1.0.0',
      description: 'High-performance PostGIS-backed Vector Tile Server API',
    },
    servers: [
      {
        url: env.APP_BASE_URL,
        description: 'Current Environment URL',
      },
    ],
    components: {
      securitySchemes: {
        API_KEY: {
          type: 'apiKey' as const,
          in: 'header' as const,
          name: 'X-API-Key',
        }
      }
    }
  }
}

app.get('/openapi', openAPIRouteHandler(app, openApiDocConfig))

app.get('/docs', Scalar({
  url: `${env.APP_BASE_URL}/openapi`,
  theme: "alternate"
}));

let cachedMarkdown: string | null = null;

app.get('/llms.txt', async (c) => {
  if (!cachedMarkdown) {
    const specs = await generateSpecs(app, openApiDocConfig, c);
    cachedMarkdown = await createMarkdownFromOpenApi(specs);
  }
  return c.text(cachedMarkdown);
});

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
  console.log('Closing database pool & cache...');
  await Promise.allSettled([disconnect(), rateLimiter.disconnect(), tileCache.disconnect()]);
  console.log('Database pool and cache connections closed');
  console.log('Process exiting...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received');
  console.log('Closing HTTP server...');
  server.close();
  console.log('HTTP server closed');
  console.log('Closing database pool & cache...');
  await Promise.allSettled([disconnect(), rateLimiter.disconnect(), tileCache.disconnect()]);
  console.log('Database pool and cache connections closed');
  console.log('Process exiting...');
  process.exit(0);
});