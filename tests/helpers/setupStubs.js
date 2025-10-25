import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const stubTargets = [
  {
    dir: path.join(projectRoot, 'node_modules', 'dotenv'),
    files: {
      'index.js': "export function config() { return {}; }\nexport default { config };\n",
      'package.json': JSON.stringify({ name: 'dotenv', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
  {
    dir: path.join(projectRoot, 'node_modules', '@google', 'genai'),
    files: {
      'index.js': [
        'export class GoogleGenAI {',
        '  constructor() {',
        '    this.models = {',
        '      embedContent: async () => ({ embedding: { values: [] } }),',
        '      generateContent: async () => ({ response: { candidates: [] } }),',
        '    };',
        '  }',
        '}',
        'export function createUserContent(input) { return input; }',
        'export function createPartFromUri(uri) { return { uri }; }',
        'export const HarmBlockThreshold = {};',
        'export const HarmCategory = {};',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: '@google/genai', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
  {
    dir: path.join(projectRoot, 'node_modules', 'axios'),
    files: {
      'index.js': [
        'export default async function axios() { return { data: {} }; }',
        'export const AxiosError = class extends Error {};',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'axios', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
  {
    dir: path.join(projectRoot, 'node_modules', 'office-text-extractor'),
    files: {
      'index.js': [
        'export function getTextExtractor() { return async () => ({ text: "" }); }',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'office-text-extractor', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
  {
    dir: path.join(projectRoot, 'node_modules', 'node-os-utils'),
    files: {
      'index.js': [
        'export const mem = { async info() { return { totalMemMb: 0, usedMemMb: 0, freeMemMb: 0, freeMemPercentage: 100 }; } };',
        'export const cpu = { async usage() { return 0; } };',
        'export default { mem, cpu };',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'node-os-utils', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
  {
    dir: path.join(projectRoot, 'node_modules', '@google-cloud', 'storage'),
    files: {
      'index.js': [
        'export class Storage { bucket() { return { async upload() { return {}; } }; } }',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: '@google-cloud/storage', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
  {
    dir: path.join(projectRoot, 'node_modules', 'discord.js'),
    files: {
      'index.js': [
        "export const MessageFlags = { Ephemeral: 'EPHEMERAL' };",
        "export const ButtonStyle = { Secondary: 'secondary', Danger: 'danger' };",
        "export const ComponentType = { ActionRow: 'ACTION_ROW' };",
        "export const ChannelType = { DM: 'DM', GuildText: 'GUILD_TEXT' };",
        "export const ActivityType = { Playing: 'PLAYING', Listening: 'LISTENING', Watching: 'WATCHING' };",
        "export const TextInputStyle = { Paragraph: 'PARAGRAPH', Short: 'SHORT' };",
        "export const PermissionsBitField = { Flags: { Administrator: 'ADMIN' } };",
        'export class ActionRowBuilder { constructor() { this.components = []; this.type = ComponentType.ActionRow; } static from(row) { const clone = new ActionRowBuilder(); clone.components = [...(row?.components || [])]; return clone; } addComponents(...components) { this.components.push(...components); return this; } }',
        'export class ButtonBuilder { setCustomId(id) { this.customId = id; return this; } setEmoji(emoji) { this.emoji = emoji; return this; } setStyle(style) { this.style = style; return this; } setLabel(label) { this.label = label; return this; } }',
        'export class TextInputBuilder { setCustomId(id) { this.customId = id; return this; } setLabel(label) { this.label = label; return this; } setPlaceholder(text) { this.placeholder = text; return this; } setStyle(style) { this.style = style; return this; } setRequired(required) { this.required = required; return this; } }',
        'export class ModalBuilder { setCustomId(id) { this.customId = id; return this; } setTitle(title) { this.title = title; return this; } addComponents(...components) { this.components = components; return this; } }',
        'export class EmbedBuilder { setColor(color) { this.color = color; return this; } setTitle(title) { this.title = title; return this; } setDescription(description) { this.description = description; return this; } setAuthor(author) { this.author = author; return this; } setTimestamp() { return this; } addFields(...fields) { this.fields = fields; return this; } setFooter(footer) { this.footer = footer; return this; } }',
        'export class AttachmentBuilder { constructor() {} }',
        'export class REST { setToken() { return this; } async put() { return {}; } }',
        "export const Routes = { applicationCommands() { return 'applicationCommands'; } };",
        'export const GatewayIntentBits = {};',
        'export const Partials = {};',
        "export class Client { constructor() { this.user = { id: 'stub-user', tag: 'stub#0000', setPresence: () => {} }; } once() {} on() {} login() { return Promise.resolve('stub-token'); } }",
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ name: 'discord.js', version: '0.0.0-test', type: 'module', main: 'index.js' }),
    },
  },
];

async function ensureStub(dir, files) {
  try {
    await fs.access(path.join(dir, 'index.js'));
    return false;
  } catch {
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(Object.entries(files).map(([name, content]) => fs.writeFile(path.join(dir, name), content)));
    return true;
  }
}

export async function setupTestEnvironment() {
  process.env.NODE_ENV = 'test';
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  process.env.CHROMA_URL = 'http://127.0.0.1:65535';

  const createdStubs = [];
  for (const target of stubTargets) {
    const created = await ensureStub(target.dir, target.files);
    createdStubs.push({ dir: target.dir, created });
  }

  return { projectRoot, createdStubs };
}

export async function teardownTestEnvironment({ projectRoot: root = projectRoot, createdStubs = [] } = {}) {
  await fs.rm(path.join(root, 'config'), { recursive: true, force: true });
  for (const { dir, created } of createdStubs) {
    if (created) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

export { projectRoot };
