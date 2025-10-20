import dotenv from 'dotenv';
dotenv.config();
import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import {
  GoogleGenAI,
  createUserContent,
  createPartFromUri
} from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import {
  fileURLToPath
} from 'url';
import config from './config.js';
import { ChromaClient } from 'chromadb';

// --- Core Client and API Initialization ---
// Using new Google GenAI library instead of deprecated @google/generative-ai
const fsp = fs.promises;

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// Initialize with new API format that requires apiKey object
export const genAI = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
});
export { createUserContent, createPartFromUri };
export const token = process.env.DISCORD_BOT_TOKEN;

// Initialize ChromaDB Client
export const chroma = new ChromaClient();
console.log('ChromaDB client initialized.');


// ---- helpers for image -> genai parts (in-memory, no fs) ----
function guessMimeFromName(name = "") {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".tiff") || lower.endsWith(".tif")) return "image/tiff";
  return "application/octet-stream";
}

function isSupportedImage(attachment) {
  const ct = (attachment.contentType || "").toLowerCase();
  if (ct) return ct.startsWith("image/") && ct !== "image/gif"; // skip GIFs
  // fallback: some Discord uploads have no contentType
  const name = attachment.name || "";
  return /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(name);
}

async function attachmentToInlinePart(a) {
  const res = await fetch(a.url);
  if (!res.ok) throw new Error(`fetch ${a.url} -> ${res.status}`);
  const ab = await res.arrayBuffer();
  const b64 = Buffer.from(ab).toString("base64");
  return {
    inlineData: {
      data: b64,
      mimeType: a.contentType || guessMimeFromName(a.name)
    }
  };
}

async function collectImagePartsFromMessage(message) {
  if (!message?.attachments?.size) return [];
  const parts = [];
  for (const a of message.attachments.values()) {
    try {
      if (!isSupportedImage(a)) continue;
      parts.push(await attachmentToInlinePart(a));
    } catch (e) {
      console.error("collectImageParts error:", e?.message || e);
    }
  }
  return parts;
}





// Pulls the text out of @google/genai responses (no .text() method in this SDK)
function getTextFromGenAI(resp) {
  if (resp?.candidates?.[0]?.content?.parts) {
    return resp.candidates[0].content.parts
      .map(p => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  if (Array.isArray(resp?.output)) {
    return resp.output
      .flatMap(o => (Array.isArray(o?.content) ? o.content : []))
      .map(p => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  // last-ditch fallback if your installed version exposes a plain string
  if (typeof resp?.text === "string") return resp.text;
  return "";
}


// --- Concurrency and Request Management ---

export const activeRequests = new Set();

class Mutex {
  constructor() {
    this._locked = false;
    this._queue = [];
  }

  acquire() {
    return new Promise(resolve => {
      if (!this._locked) {
        this._locked = true;
        resolve();
      } else {
        this._queue.push(resolve);
      }
    });
  }

  release() {
    if (this._queue.length > 0) {
      const nextResolve = this._queue.shift();
      nextResolve();
    } else {
      this._locked = false;
    }
  }

  async runExclusive(callback) {
    await this.acquire();
    try {
      return await callback();
    } finally {
      this.release();
    }
  }
}

export const chatHistoryLock = new Mutex();


// --- State and Data Management ---

let chatHistories = {};
let activeUsersInChannels = {};
let customInstructions = {};
let serverSettings = {};
let userResponsePreference = {};
let alwaysRespondChannels = {};
let channelWideChatHistory = {};
let blacklistedUsers = {};

export const state = {
  get chatHistories() {
    return chatHistories;
  },
  set chatHistories(v) {
    chatHistories = v;
  },
  get activeUsersInChannels() {
    return activeUsersInChannels;
  },
  set activeUsersInChannels(v) {
    activeUsersInChannels = v;
  },
  get customInstructions() {
    return customInstructions;
  },
  set customInstructions(v) {
    customInstructions = v;
  },
  get serverSettings() {
    return serverSettings;
  },
  set serverSettings(v) {
    serverSettings = v;
  },
  get userResponsePreference() {
    return userResponsePreference;
  },
  set userResponsePreference(v) {
    userResponsePreference = v;
  },
  get alwaysRespondChannels() {
    return alwaysRespondChannels;
  },
  set alwaysRespondChannels(v) {
    alwaysRespondChannels = v;
  },
  get channelWideChatHistory() {
    return channelWideChatHistory;
  },
  set channelWideChatHistory(v) {
    channelWideChatHistory = v;
  },
  get blacklistedUsers() {
    return blacklistedUsers;
  },
  set blacklistedUsers(v) {
    blacklistedUsers = v;
  },
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(__dirname, 'config');
const CHAT_HISTORIES_DIR = path.join(CONFIG_DIR, 'chat_histories_4');
export const TEMP_DIR = path.join(__dirname, 'temp');

const FILE_PATHS = {
  activeUsersInChannels: path.join(CONFIG_DIR, 'active_users_in_channels.json'),
  customInstructions: path.join(CONFIG_DIR, 'custom_instructions.json'),
  serverSettings: path.join(CONFIG_DIR, 'server_settings.json'),
  userResponsePreference: path.join(CONFIG_DIR, 'user_response_preference.json'),
  alwaysRespondChannels: path.join(CONFIG_DIR, 'always_respond_channels.json'),
  channelWideChatHistory: path.join(CONFIG_DIR, 'channel_wide_chathistory.json'),
  blacklistedUsers: path.join(CONFIG_DIR, 'blacklisted_users.json')
};

// --- Data Persistence Functions ---

let isSaving = false;
let savePending = false;

export async function saveStateToFile() {
  if (isSaving) {
    savePending = true;
    return;
  }
  isSaving = true;

  try {
    await fs.mkdir(CONFIG_DIR, {
      recursive: true
    });
    await fs.mkdir(CHAT_HISTORIES_DIR, {
      recursive: true
    });

    const chatHistoryPromises = Object.entries(chatHistories).map(([key, value]) => {
      const filePath = path.join(CHAT_HISTORIES_DIR, `${key}.json`);
      return fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
    });

    const filePromises = Object.entries(FILE_PATHS).map(([key, filePath]) => {
      return fs.writeFile(filePath, JSON.stringify(state[key], null, 2), 'utf-8');
    });

    await Promise.all([...chatHistoryPromises, ...filePromises]);
  } catch (error) {
    console.error('Error saving state to files:', error);
  } finally {
    isSaving = false;
    if (savePending) {
      savePending = false;
      saveStateToFile();
    }
  }
}

// --- FINAL CORRECTED MIGRATION FUNCTION ---
async function migrateJsonHistoryToChroma() {
    console.log('Checking if chat history migration to ChromaDB is needed...');

    try {
        const messagesCollection = await chroma.getCollection({ name: "messages" });

        const count = await messagesCollection.count();
        if (count > 0) {
            console.log('ChromaDB "messages" collection is not empty. Migration skipped.');
            return;
        }

        console.log('Starting migration of JSON chat histories to ChromaDB...');
        let totalMessagesMigrated = 0;

        // Loop 1: Iterate over the main history object (keys are user/server IDs from filenames)
        for (const historyId in chatHistories) {
            const subIdEntries = chatHistories[historyId]; // This is the object like {"1425...": [...], "1426...": [...]}

            // Safety check to ensure it's a valid object to loop through
            if (typeof subIdEntries !== 'object' || subIdEntries === null) {
                console.warn(`- Skipping non-object history for ID: ${historyId}`);
                continue;
            }

            // Loop 2: Iterate over the keys of the inner object (the sub-conversation IDs)
            for (const subId in subIdEntries) {
                const messageArray = subIdEntries[subId]; // This is the actual array of messages

                // Final safety check to make sure we have an array
                if (!Array.isArray(messageArray)) {
                    console.warn(`- Skipping non-array entry for subId: ${subId} under historyId: ${historyId}`);
                    continue;
                }

                const documents = [];
                const metadatas = [];
                const ids = [];

                for (const [index, message] of messageArray.entries()) {
                    if (!message.content || !Array.isArray(message.content)) continue;

                    const content = message.content.map(part => part.text).join('\n').trim();
                    if (!content) continue;

                    documents.push(content);
                    metadatas.push({
                        historyId: historyId, // The main user/server ID
                        subId: subId,         // The specific conversation/thread ID
                        role: message.role,
                        migrated_at: Date.now()
                    });
                    // Create a more robust unique ID
                    ids.push(`migrated-${historyId}-${subId}-${index}`);
                }

                if (documents.length > 0) {
                    await messagesCollection.add({
                        ids: ids,
                        documents: documents,
                        metadatas: metadatas,
                    });
                    console.log(`- Migrated ${documents.length} messages for ${historyId} (subId: ${subId})`);
                    totalMessagesMigrated += documents.length;
                }
            }
        }

        console.log(`Migration complete! Total messages moved to ChromaDB: ${totalMessagesMigrated}`);

    } catch (error) {
        console.error('An error occurred during ChromaDB migration:', error);
    }
}
// --- END OF FINAL CORRECTED MIGRATION FUNCTION ---

async function loadStateFromFile() {
  try {
    await fs.mkdir(CONFIG_DIR, {
      recursive: true
    });
    await fs.mkdir(CHAT_HISTORIES_DIR, {
      recursive: true
    });
    await fs.mkdir(TEMP_DIR, {
      recursive: true
    });

    const files = await fs.readdir(CHAT_HISTORIES_DIR);
    const chatHistoryPromises = files
      .filter(file => file.endsWith('.json'))
      .map(async file => {
        const user = path.basename(file, '.json');
        const filePath = path.join(CHAT_HISTORIES_DIR, file);
        try {
          const data = await fs.readFile(filePath, 'utf-8');
          chatHistories[user] = JSON.parse(data);
        } catch (readError) {
          console.error(`Error reading chat history for ${user}:`, readError);
        }
      });
    await Promise.all(chatHistoryPromises);

    const filePromises = Object.entries(FILE_PATHS).map(async ([key, filePath]) => {
      try {
        const data = await fs.readFile(filePath, 'utf-8');
        state[key] = JSON.parse(data);
      } catch (readError) {
        if (readError.code !== 'ENOENT') {
          console.error(`Error reading ${key} from ${filePath}:`, readError);
        }
      }
    });
    await Promise.all(filePromises);

  } catch (error) {
    console.error('Error loading state from files:', error);
  }
}

// --- Daily Cleanup and Initialization ---

function removeFileData(histories) {
  try {
    Object.values(histories).forEach(subIdEntries => {
      subIdEntries.forEach(message => {
        if (message.content) {
          message.content = message.content.filter(contentItem => {
            if (contentItem.fileData) {
              delete contentItem.fileData;
            }
            return Object.keys(contentItem).length > 0;
          });
        }
      });
    });
    console.log('fileData elements have been removed from chat histories.');
  } catch (error) {
    console.error('An error occurred while removing fileData elements:', error);
  }
}

function scheduleDailyReset() {
  try {
    const now = new Date();
    const nextReset = new Date();
    nextReset.setHours(0, 0, 0, 0);
    if (nextReset <= now) {
      nextReset.setDate(now.getDate() + 1);
    }
    const timeUntilNextReset = nextReset - now;

    setTimeout(async () => {
      console.log('Running daily cleanup task...');
      await chatHistoryLock.runExclusive(async () => {
        removeFileData(chatHistories);
        await saveStateToFile();
      });
      console.log('Daily cleanup task finished.');
      scheduleDailyReset();
    }, timeUntilNextReset);

  } catch (error) {
    console.error('An error occurred while scheduling the daily reset:', error);
  }
}

export async function initialize() {
  scheduleDailyReset();
  await loadStateFromFile();
  console.log('Bot state loaded from files.');

  // --- NEW: Initialize ChromaDB Collections ---
  try {
    console.log('Initializing ChromaDB collections...');

    // Collection for regular chat messages
    const messagesCollection = await chroma.getOrCreateCollection({
      name: "messages",
      metadata: { "hnsw:space": "cosine" } // Using cosine for semantic similarity
    });
    console.log(`- "${messagesCollection.name}" collection ready.`);

    // Collection for the bot's own context and identity
    const selfContextCollection = await chroma.getOrCreateCollection({
      name: "self_context",
      metadata: { "hnsw:space": "cosine" }
    });
    console.log(`- "${selfContextCollection.name}" collection ready.`);

    // Collection for recognized entities (people, places, topics)
    const entitiesCollection = await chroma.getOrCreateCollection({
      name: "entities",
      metadata: { "hnsw:space": "cosine" }
    });
    console.log(`- "${entitiesCollection.name}" collection ready.`);

    // Collection for compressed/summarized old conversations
    const archivesCollection = await chroma.getOrCreateCollection({
      name: "archives",
      metadata: { "hnsw:space": "cosine" }
    });
    console.log(`- "${archivesCollection.name}" collection ready.`);

    console.log('ChromaDB collections are set up.');
    // --- NEW: Run the migration ---
    await migrateJsonHistoryToChroma();
    // --- END OF NEW CODE ---
  } catch (error) {
    console.error('Error initializing ChromaDB collections:', error);
  }
  // --- END OF NEW CODE ---
  console.log('Bot state loaded and initialized.');
}


// --- State Helper Functions ---

export function getHistory(id) {
  const historyObject = chatHistories[id] || {};
  let combinedHistory = [];

  // Combine all message histories for this ID
  for (const messagesId in historyObject) {
    if (historyObject.hasOwnProperty(messagesId)) {
      combinedHistory = [...combinedHistory, ...historyObject[messagesId]];
    }
  }

  // Transform to format expected by new Google GenAI API
  return combinedHistory.map(entry => {
    return {
      role: entry.role === 'assistant' ? 'model' : entry.role,
      parts: entry.content
    };
  });
}

// --- NEW: Save new messages directly to ChromaDB ---
// --- FINAL VERSION: Saves all metadata including version and token estimates ---
export async function updateChatHistory(historyId, userMessageParts, modelResponseContent, discordMessage, latency, personaInstructions, botVersion) {
    try {
        const messagesCollection = await chroma.getCollection({ name: "messages" });

        const userContent = userMessageParts.map(part => part.text).join('\n').trim();
        const modelContent = modelResponseContent.trim();
        const timestamp = Date.now();
        const botUser = client.user;
        const messageModality = discordMessage.attachments.size > 0 ? 'multimodal' : 'text';

        // --- NEW: Estimate token counts (a common rule of thumb is 1 token ≈ 4 characters) ---
        const userTokenCount = Math.ceil(userContent.length / 4);
        const modelTokenCount = Math.ceil(modelContent.length / 4);

        // Prepare the user's message
        const userDoc = {
            id: `msg-user-${discordMessage.id}`,
            document: userContent,
            metadata: {
                historyId: historyId,
                guild_id: discordMessage.guild?.id || 'DM',
                channel_id: discordMessage.channel.id,
                user_id: discordMessage.author.id,
                username: discordMessage.author.username,
                role: 'user',
                created_at: discordMessage.createdTimestamp,
                reply_to: discordMessage.reference?.messageId || '',
                modality: messageModality,
                latency: 0,
                persona: '',
                version: botVersion,
                token_count: userTokenCount
            }
        };

        // Prepare the bot's (model) response
        const modelDoc = {
            id: `msg-model-${discordMessage.id}`,
            document: modelContent,
            metadata: {
                historyId: historyId,
                guild_id: discordMessage.guild?.id || 'DM',
                channel_id: discordMessage.channel.id,
                user_id: botUser.id,
                username: botUser.username,
                role: 'model',
                created_at: timestamp,
                reply_to: discordMessage.id,
                modality: 'text',
                latency: latency,
                persona: personaInstructions,
                version: botVersion,
                token_count: modelTokenCount
            }
        };

        await messagesCollection.add({
            ids: [userDoc.id, modelDoc.id],
            documents: [userDoc.document, modelDoc.document],
            metadatas: [userDoc.metadata, modelDoc.metadata]
        });

        console.log(`Saved conversation to ChromaDB (Tokens: ${modelTokenCount}, Latency: ${latency}ms).`);

    } catch (error) {
        console.error('Error updating chat history in ChromaDB:', error);
    }
}

// --- NEW: Retrieve relevant memories from ChromaDB ---
export async function retrieveMemories(queryText, historyId, resultCount = 5) {
    try {
        const messagesCollection = await chroma.getCollection({ name: "messages" });

        // Query the collection to find the most relevant documents
        const results = await messagesCollection.query({
            queryTexts: [queryText],
            nResults: resultCount,
            where: { "historyId": historyId } // IMPORTANT: Only search within the current user/server's history
        });

        // If no results, return null
        if (results.documents[0].length === 0) {
            console.log(`No relevant memories found for historyId: ${historyId}`);
            return null;
        }

        // Format the results into a clean string for the LLM
        const memories = results.documents[0].map((doc, index) => {
            const role = results.metadatas[0][index].role;
            return `${role === 'user' ? 'You previously said' : 'I previously said'}: "${doc}"`;
        }).join('\n');

        console.log(`Retrieved ${results.documents[0].length} memories for historyId: ${historyId}`);
        return memories;

    } catch (error) {
        console.error('Error retrieving memories from ChromaDB:', error);
        return null;
    }
}

// --- FINAL CORRECTED VERSION USING THE DIRECT API CALL ---
// Using: import { GoogleGenAI, createUserContent } from "@google/genai";
// And you already have: const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// requires your existing getTextFromGenAI(resp) helper from earlier
// Using: import { GoogleGenAI, createUserContent } from "@google/genai";
// You already have: const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function extractAndStoreEntities(text, sourceMessage) {
  const trimmed = (text || "").trim();
  const hasText = trimmed.length >= 1; // we’ll allow image-only extraction now

  // also try to collect any image attachments from the message
  const imageParts = await collectImagePartsFromMessage(sourceMessage);
  const hasImages = imageParts.length > 0;

  // if no text and no images, nothing to do
  if (!hasText && !hasImages) return;

  console.log("Attempting to extract entities (text + images)…");
  try {
    // stricter instruction to fuse text + images and return JSON only
    const task =
      `Task: Identify named entities (people, places, organizations, projects, specific topics) ` +
      `from the provided TEXT and IMAGES. Return ONLY a JSON array of strings ` +
      `like ["entity1","entity2"]. If none, return [] and nothing else.`;

    const itemsForUser = [
      task,
      hasText ? `TEXT:\n"""${trimmed}"""` : "TEXT: (none)",
      // image parts get appended here
      ...imageParts
    ];

    const resp = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: createUserContent(itemsForUser),
      config: { responseMimeType: "application/json" }
    });

    const full = getTextFromGenAI(resp); // <-- your working extractor
    if (!full || !full.trim().startsWith("[")) {
      console.log("Entity extraction returned a non-JSON or empty response. Skipping.");
      return;
    }

    let entities;
    try {
      entities = JSON.parse(full);
    } catch {
      console.log("Malformed JSON from model. Skipping.");
      return;
    }

    entities = (Array.isArray(entities) ? entities : [])
      .filter(e => typeof e === "string")
      .map(e => e.trim())
      .filter(Boolean);

    if (entities.length === 0) {
      console.log("No entities were found from text/images.");
      return;
    }

    // dedupe + keep it reasonable
    const unique = Array.from(new Set(entities)).slice(0, 50);

    const entitiesCollection = await chroma.getOrCreateCollection({ name: "entities" });
    const now = Date.now();

    await entitiesCollection.add({
      ids: unique.map(e => `entity-${sourceMessage.id}-${now}-${e.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`),
      documents: unique,
      metadatas: unique.map(() => ({
        source_guild_id: sourceMessage.guild?.id ?? "DM",
        source_channel_id: sourceMessage.channel.id,
        source_user_id: sourceMessage.author.id,
        created_at: now,
        has_text: hasText,
        has_images: hasImages
      }))
    });

    console.log(`Successfully extracted and stored ${unique.length} entities (text/images).`);
  } catch (error) {
    console.error("Failed to extract or store entities (text/images):", error);
  }
}



export function getUserResponsePreference(userId) {
  return state.userResponsePreference[userId] || config.defaultResponseFormat;
}

export function initializeBlacklistForGuild(guildId) {
  try {
    if (!state.blacklistedUsers[guildId]) {
      state.blacklistedUsers[guildId] = [];
    }
    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = config.defaultServerSettings;
    }
  } catch (error) { }
}
