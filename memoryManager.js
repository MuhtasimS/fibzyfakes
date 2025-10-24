import axios from 'axios';
import crypto from 'crypto';

const CHROMA_URL = process.env.CHROMA_URL || 'http://127.0.0.1:8000';
const CHROMA_TENANT = process.env.CHROMA_TENANT;
const CHROMA_DATABASE = process.env.CHROMA_DATABASE;
const COLLECTION_PREFIX = process.env.CHROMA_COLLECTION_PREFIX || 'fibz';
const EMBEDDING_MODEL = process.env.VERTEX_EMBEDDING_MODEL || 'models/text-embedding-005';
const MAX_DOCUMENT_LENGTH = 6000;
const DEFAULT_BATCH_SIZE = 8;

const COLLECTION_KEYS = {
  messages: 'messages',
  self: 'self_context',
  entities: 'entities',
  archives: 'archives',
};

let chromaAvailable = true;
let hasLoggedFailure = false;
let genAIClient = null;
let selfContextCache = [];
const collectionCache = new Map();

function headers() {
  const baseHeaders = {};
  if (CHROMA_TENANT) {
    baseHeaders['X-Chroma-Tenant'] = CHROMA_TENANT;
  }
  if (CHROMA_DATABASE) {
    baseHeaders['X-Chroma-Database'] = CHROMA_DATABASE;
  }
  return baseHeaders;
}

async function safeRequest(method, path, data) {
  if (!chromaAvailable) {
    return { data: null, notFound: false };
  }
  try {
    const response = await axios({
      method,
      url: `${CHROMA_URL}${path}`,
      data,
      headers: headers(),
      timeout: 10000,
    });
    return { data: response.data, notFound: false };
  } catch (error) {
    const status = error.response?.status;
    if (status === 404) {
      return { data: null, notFound: true };
    }
    if (!hasLoggedFailure) {
      console.warn(`[memory] Failed Chroma request ${method.toUpperCase()} ${path}: ${error.message}`);
      hasLoggedFailure = true;
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || (status && status >= 500)) {
      chromaAvailable = false;
    }
    return { data: null, notFound: false };
  }
}

function createDeterministicId(...parts) {
  const payload = parts.filter(Boolean).join('::');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function sanitizeDocument(document) {
  if (!document) {
    return '';
  }
  if (document.length <= MAX_DOCUMENT_LENGTH) {
    return document;
  }
  return document.slice(0, MAX_DOCUMENT_LENGTH);
}

function baseMetadata(overrides = {}) {
  const metadata = {
    consent: 'unknown',
    modality: 'text',
    version: process.env.MEMORY_SCHEMA_VERSION || 'v1',
    tags: [],
    ...overrides,
  };
  if (!metadata.created_at) {
    metadata.created_at = new Date().toISOString();
  }
  return metadata;
}

async function embedText(text) {
  if (!genAIClient) {
    return null;
  }
  const trimmed = (text || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const response = await genAIClient.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ text: sanitizeDocument(trimmed) }],
        },
      ],
    });
    if (response?.embedding?.values) {
      return response.embedding.values;
    }
    if (Array.isArray(response?.embeddings) && response.embeddings[0]?.values) {
      return response.embeddings[0].values;
    }
    return null;
  } catch (error) {
    if (!hasLoggedFailure) {
      console.warn(`[memory] Embedding failed: ${error.message}`);
    }
    return null;
  }
}

function collectionName(key) {
  return `${COLLECTION_PREFIX}_${COLLECTION_KEYS[key]}`;
}

async function ensureCollection(key, metadata = {}) {
  if (collectionCache.has(key)) {
    return collectionCache.get(key);
  }
  const name = collectionName(key);
  const { data } = await safeRequest('get', '/api/v1/collections');
  if (Array.isArray(data?.collections)) {
    const existing = data.collections.find((col) => col.name === name);
    if (existing) {
      collectionCache.set(key, existing);
      return existing;
    }
  }
  const creation = await safeRequest('post', '/api/v1/collections', {
    name,
    metadata,
  });
  if (creation.data) {
    collectionCache.set(key, creation.data);
    return creation.data;
  }
  return null;
}

async function upsertToCollection(collection, items) {
  if (!collection || !Array.isArray(items) || items.length === 0) {
    return;
  }
  const ids = [];
  const documents = [];
  const metadatas = [];
  const embeddings = [];
  for (const item of items) {
    const document = sanitizeDocument(item.document);
    const embedding = await embedText(document);
    if (!embedding) {
      continue;
    }
    ids.push(item.id);
    documents.push(document);
    metadatas.push(item.metadata || {});
    embeddings.push(embedding);
  }
  if (!ids.length) {
    return;
  }
  await safeRequest('post', `/api/v1/collections/${collection.id}/upsert`, {
    ids,
    documents,
    metadatas,
    embeddings,
  });
}

async function upsertInBatches(collection, items, batchSize = DEFAULT_BATCH_SIZE) {
  for (let i = 0; i < items.length; i += batchSize) {
    const slice = items.slice(i, i + batchSize);
    await upsertToCollection(collection, slice);
  }
}

async function refreshSelfContextCache() {
  const collection = await ensureCollection('self', { type: 'self_context' });
  if (!collection) {
    return;
  }
  const response = await safeRequest('post', `/api/v1/collections/${collection.id}/get`, {
    include: ['documents', 'metadatas', 'ids'],
    limit: 100,
    offset: 0,
  });
  if (!response.data?.documents) {
    return;
  }
  const ids = response.data.ids || [];
  const documents = response.data.documents || [];
  const metadatas = response.data.metadatas || [];
  selfContextCache = documents.map((doc, index) => ({
    id: ids[index],
    document: doc,
    metadata: metadatas[index] || {},
  }));
}

export async function initializeMemory(genAIInstance) {
  genAIClient = genAIInstance;
  if (!chromaAvailable) {
    return;
  }
  await ensureCollection('self', { type: 'self_context' });
  await ensureCollection('messages', { type: 'messages' });
  await ensureCollection('entities', { type: 'entities' });
  await ensureCollection('archives', { type: 'archives' });
  await refreshSelfContextCache();
}

export async function migrateLegacyHistories(histories) {
  if (!histories || !Object.keys(histories).length) {
    return;
  }
  const collection = await ensureCollection('messages', { type: 'messages' });
  if (!collection) {
    return;
  }
  const items = [];
  for (const [historyId, messageGroups] of Object.entries(histories)) {
    if (!messageGroups) continue;
    for (const [messagesId, entries] of Object.entries(messageGroups)) {
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        const text = Array.isArray(entry.content)
          ? entry.content.map((part) => part.text).filter(Boolean).join('\n')
          : '';
        const document = sanitizeDocument(text);
        if (!document) {
          return;
        }
        items.push({
          id: createDeterministicId('legacy', historyId, messagesId, index, entry.role),
          document,
          metadata: baseMetadata({
            history_id: historyId,
            message_group: messagesId,
            role: entry.role,
            tags: ['legacy', 'import'],
          }),
        });
      });
    }
  }
  if (items.length) {
    await upsertInBatches(collection, items);
  }
}

export async function storeSelfContextSnippet(key, content, metadata = {}) {
  if (!content) {
    return;
  }
  const collection = await ensureCollection('self', { type: 'self_context' });
  if (!collection) {
    return;
  }
  const document = sanitizeDocument(content);
  const id = createDeterministicId('self', key);
  await upsertToCollection(collection, [
    {
      id,
      document,
      metadata: baseMetadata({ key, ...metadata, tags: ['self', ...(metadata.tags || [])] }),
    },
  ]);
  await refreshSelfContextCache();
}

export function getSelfContextSnippets(limit = 3) {
  if (!selfContextCache.length) {
    return [];
  }
  return selfContextCache
    .slice(0, limit)
    .map((entry) => ({ document: entry.document, metadata: entry.metadata }));
}

export async function retrieveRelevantMemories({ query, userId, guildId, channelId, limit = 5 }) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    return [];
  }
  const collection = await ensureCollection('messages', { type: 'messages' });
  if (!collection) {
    return [];
  }
  const embedding = await embedText(trimmed);
  if (!embedding) {
    return [];
  }
  const where = {};
  if (guildId) {
    where.guild_id = guildId;
    if (channelId) {
      where.channel_id = channelId;
    }
  } else if (userId) {
    where.user_id = userId;
  }
  const response = await safeRequest('post', `/api/v1/collections/${collection.id}/query`, {
    query_embeddings: [embedding],
    n_results: limit,
    where,
    include: ['documents', 'metadatas', 'distances'],
  });
  const documents = response.data?.documents?.[0] || [];
  const metadatas = response.data?.metadatas?.[0] || [];
  const distances = response.data?.distances?.[0] || [];
  return documents
    .map((doc, index) => ({
      document: doc,
      metadata: metadatas[index] || {},
      distance: typeof distances[index] === 'number' ? distances[index] : null,
    }))
    .filter((entry) => entry.document);
}

export async function storeMessageTurn({
  historyId,
  guildId,
  channelId,
  userId,
  username,
  displayName,
  globalName,
  roles = [],
  userMessageId,
  assistantMessageId,
  userContent,
  assistantContent,
  persona = 'default',
  latencyMs = null,
  tokenCounts = null,
  consent,
  tags = [],
}) {
  const collection = await ensureCollection('messages', { type: 'messages' });
  if (!collection) {
    return;
  }
  const items = [];
  const guildKey = guildId || 'dm';
  const channelKey = channelId || (guildId ? channelId : userId);
  if (userContent && userContent.trim()) {
    items.push({
      id: createDeterministicId('message', guildKey, channelKey, userMessageId || Date.now(), 'user'),
      document: userContent,
      metadata: baseMetadata({
        history_id: historyId,
        guild_id: guildId || null,
        channel_id: channelId || null,
        user_id: userId,
        username,
        display_name: displayName || null,
        global_name: globalName || null,
        roles,
        role: 'user',
        persona,
        message_id: userMessageId || null,
        consent: consent || (guildId ? 'shareable' : 'private'),
        tags: ['user', ...tags],
        latency: latencyMs,
        token_counts: tokenCounts,
      }),
    });
  }
  if (assistantContent && assistantContent.trim()) {
    items.push({
      id: createDeterministicId('message', guildKey, channelKey, assistantMessageId || Date.now(), 'assistant'),
      document: assistantContent,
      metadata: baseMetadata({
        history_id: historyId,
        guild_id: guildId || null,
        channel_id: channelId || null,
        user_id: 'fibz',
        username: 'Fibz',
        display_name: 'Fibz',
        roles: ['bot'],
        role: 'assistant',
        persona,
        message_id: assistantMessageId || null,
        consent: 'shareable',
        tags: ['assistant', ...tags],
        latency: latencyMs,
        token_counts: tokenCounts,
      }),
    });
  }
  if (items.length) {
    await upsertInBatches(collection, items, 2);
  }
}

export async function storeEntityInsight({
  entityId,
  name,
  summary,
  attributes = {},
  guildId = null,
  channelId = null,
  tags = [],
  consent = 'shareable',
  lastMentionedAt = null,
  sourceMessageId = null,
}) {
  if (!entityId || !summary) {
    return;
  }
  const collection = await ensureCollection('entities', { type: 'entities' });
  if (!collection) {
    return;
  }
  const document = sanitizeDocument(summary);
  const metadata = baseMetadata({
    entity_id: entityId,
    name,
    guild_id: guildId,
    channel_id: channelId,
    attributes,
    consent,
    tags: ['entity', ...tags],
    last_mentioned_at: lastMentionedAt || new Date().toISOString(),
    source_message_id: sourceMessageId,
  });
  metadata.aliases = attributes.aliases || [];
  await upsertToCollection(collection, [
    {
      id: createDeterministicId('entity', entityId, guildId || 'global'),
      document,
      metadata,
    },
  ]);
}

export async function retrieveEntityInsights({ query, limit = 5, guildId = null }) {
  const trimmed = (query || '').trim();
  if (!trimmed) {
    return [];
  }
  const collection = await ensureCollection('entities', { type: 'entities' });
  if (!collection) {
    return [];
  }
  const embedding = await embedText(trimmed);
  if (!embedding) {
    return [];
  }
  const where = {};
  if (guildId) {
    where.guild_id = guildId;
  }
  const response = await safeRequest('post', `/api/v1/collections/${collection.id}/query`, {
    query_embeddings: [embedding],
    n_results: limit,
    where,
    include: ['documents', 'metadatas'],
  });
  const documents = response.data?.documents?.[0] || [];
  const metadatas = response.data?.metadatas?.[0] || [];
  return documents
    .map((doc, index) => ({
      document: doc,
      metadata: metadatas[index] || {},
    }))
    .filter((entry) => entry.document);
}

export async function getEntitiesByIds(entityIds = []) {
  if (!Array.isArray(entityIds) || entityIds.length === 0) {
    return [];
  }
  const collection = await ensureCollection('entities', { type: 'entities' });
  if (!collection) {
    return [];
  }
  const results = [];
  for (const entityId of entityIds) {
    const { data } = await safeRequest('post', `/api/v1/collections/${collection.id}/get`, {
      where: { entity_id: entityId },
      include: ['documents', 'metadatas'],
      limit: 1,
    });
    if (data?.documents?.[0]) {
      results.push({
        document: data.documents[0],
        metadata: (data.metadatas && data.metadatas[0]) || {},
      });
    }
  }
  return results;
}

async function deleteFromCollection(collectionKey, where) {
  const collection = await ensureCollection(collectionKey, { type: collectionKey });
  if (!collection) {
    return;
  }
  if (!where || !Object.keys(where).length) {
    return;
  }
  await safeRequest('post', `/api/v1/collections/${collection.id}/delete`, { where });
}

export async function deleteUserMemories({ historyId, guildId, channelId, userId }) {
  const where = {};
  if (historyId) {
    where.history_id = historyId;
  }
  if (userId) {
    where.user_id = userId;
  }
  if (guildId) {
    where.guild_id = guildId;
  }
  if (channelId) {
    where.channel_id = channelId;
  }
  await deleteFromCollection('messages', where);
}

export async function deleteServerMemories(guildId) {
  if (!guildId) {
    return;
  }
  await deleteFromCollection('messages', { guild_id: guildId });
  await deleteFromCollection('entities', { guild_id: guildId });
}
