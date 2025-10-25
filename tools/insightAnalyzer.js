import { storeEntityInsight, storeSelfContextSnippet } from '../memoryManager.js';

const ANALYZER_MODEL = process.env.MEMORY_ANALYZER_MODEL || 'gemini-2.5-flash';
const MAX_QUEUE_LENGTH = 5;
let genAIClient = null;
let queueDepth = 0;
let tailPromise = Promise.resolve();

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function buildAnalyzerPrompt(payload) {
  const { userMessage, assistantMessage, metadata } = payload;
  const summary = {
    metadata,
    conversation_turn: {
      user: userMessage,
      assistant: assistantMessage,
    },
  };
  return JSON.stringify(summary, null, 2);
}

async function runAnalysis(payload) {
  if (!genAIClient) {
    return;
  }
  const body = buildAnalyzerPrompt(payload);
  try {
    const result = await genAIClient.models.generateContent({
      model: ANALYZER_MODEL,
      contents: [
        {
          role: 'system',
          parts: [
            {
              text: [
                "You are Fibz's background analyst.",
                'Respond ONLY in JSON with keys `self_context` and `entities`.',
                'For `self_context`, capture new facts about Fibz\'s behaviour, capabilities, preferences, or status.',
                'For `entities`, capture knowledge about people or recurring topics.',
                'Include `entity_id`, `name`, `summary`, and optional attributes where relevant.',
                'Respect consent: mark uncertain or sensitive items as `consent_required` and omit private material.',
                'Return an empty array for any key when there is nothing new.',
              ].join('\n'),
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              text: body,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });
    const candidate = result?.response?.candidates?.[0];
    const raw = (candidate?.content?.parts || []).map((part) => part.text).find(Boolean);
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      return;
    }
    const { metadata } = payload;
    if (Array.isArray(parsed.self_context)) {
      for (const note of parsed.self_context) {
        if (!note?.summary) {
          continue;
        }
        await storeSelfContextSnippet(`insight-${metadata.messageId}-${note.title || 'note'}`, note.summary, {
          title: note.title || 'Insight',
          consent: note.consent || 'shareable',
          tags: ['insight', ...(note.tags || [])],
        });
      }
    }
    if (Array.isArray(parsed.entities)) {
      for (const entity of parsed.entities) {
        if (!entity?.entity_id || !entity?.summary) {
          continue;
        }
        await storeEntityInsight({
          entityId: entity.entity_id,
          name: entity.name || entity.entity_id,
          summary: entity.summary,
          attributes: entity.attributes || {},
          guildId: metadata.guildId || null,
          channelId: metadata.channelId || null,
          tags: entity.tags || [],
          consent: entity.consent || 'shareable',
          lastMentionedAt: metadata.timestamp,
          sourceMessageId: metadata.messageId,
        });
      }
    }
  } catch (error) {
    console.warn('Background insight analysis failed:', error.message);
  }
}

export function configureInsightAnalyzer(genAIInstance) {
  genAIClient = genAIInstance;
}

export function queueInsightAnalysis(payload) {
  if (!genAIClient || queueDepth >= MAX_QUEUE_LENGTH) {
    return;
  }
  queueDepth += 1;
  const wrapped = async () => {
    try {
      await runAnalysis(payload);
    } finally {
      queueDepth = Math.max(0, queueDepth - 1);
    }
  };
  setImmediate(() => {
    tailPromise = tailPromise.then(() => wrapped()).catch(() => {}).then(() => {});
  });
}

export const __test = {
  safeJsonParse,
  buildAnalyzerPrompt,
};