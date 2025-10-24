import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const noopGenAI = { models: { embedContent: async () => ({}) } };

function createGoneError() {
  const error = new Error('Gone');
  error.response = { status: 410 };
  return error;
}

test('initializeMemory falls back to tenant-scoped collection endpoints', async () => {
  delete process.env.CHROMA_TENANT;
  delete process.env.CHROMA_DATABASE;

  const requests = [];
  const axiosMock = mock.fn(async (config) => {
    requests.push(config);
    if (config.method === 'get' && config.url.endsWith('/api/v1/collections')) {
      throw createGoneError();
    }
    if (config.method === 'get' && config.url.includes('/api/v1/tenants/')) {
      return { data: { collections: [] }, status: 200 };
    }
    if (config.method === 'post' && config.url.includes('/api/v1/tenants/') && config.url.endsWith('/collections')) {
      return { data: { id: `${config.data.name}-id`, name: config.data.name }, status: 200 };
    }
    if (config.method === 'post' && config.url.includes('/collections/') && config.url.endsWith('/get')) {
      return { data: { documents: [], metadatas: [], ids: [] }, status: 200 };
    }
    return { data: {}, status: 200 };
  });

  const memoryModule = await import(`../memoryManager.js?tenantFallback=${Date.now()}`);
  memoryModule.__setHttpClient(axiosMock);

  await memoryModule.initializeMemory(noopGenAI);

  const tenantRequest = requests.find(
    (req) => req.method === 'get' && req.url.includes('/api/v1/tenants/default_tenant/databases/default_database/collections')
  );
  assert.ok(tenantRequest, 'Expected a tenant-scoped collections request after 410 response');
  assert.equal(
    tenantRequest.headers['X-Chroma-Tenant'],
    'default_tenant',
    'Tenant header should default when env vars are unset'
  );
  assert.equal(
    tenantRequest.headers['X-Chroma-Database'],
    'default_database',
    'Database header should default when env vars are unset'
  );

  memoryModule.__setHttpClient(null);
});
