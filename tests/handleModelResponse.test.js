import { setupTestEnvironment, teardownTestEnvironment } from './helpers/setupStubs.js';

const { projectRoot, createdStubs } = await setupTestEnvironment();

const { handleModelResponse } = await import('../index.js');

class MockCollector {
  on() {}
}

class MockMessage {
  constructor() {
    this.id = 'bot-message-id';
    this.components = [];
  }

  async edit(payload) {
    if (payload?.components) {
      this.components = payload.components;
    }
    this.lastEdit = payload;
    return this;
  }

  async createMessageComponentCollector() {
    return new MockCollector();
  }
}

const mockBotMessage = new MockMessage();

const chat = {
  async sendMessageStream() {
    async function* generator() {
      yield { text: 'Mock response chunk.' };
    }
    return generator();
  },
};

const parts = [
  { text: '--- Additional Context: memories/personality/history ---' },
  { text: 'User asked something important.' },
];

const originalMessage = {
  id: 'original-message-id',
  author: {
    id: 'user-123',
    username: 'User123',
    displayName: 'User123',
    displayAvatarURL: () => 'https://example.com/avatar.png',
  },
  guild: {
    id: 'guild-123',
    name: 'Test Guild',
    iconURL: () => null,
  },
  channel: {
    id: 'channel-123',
    async send() {
      return new MockMessage();
    },
  },
};

try {
  await handleModelResponse(
    mockBotMessage,
    chat,
    parts,
    originalMessage,
    null,
    'history-123',
    undefined,
    'User asked something important.',
    1,
    'default'
  );
  console.log('handleModelResponse completed without throwing.');
} catch (error) {
  console.error('handleModelResponse threw an error:', error);
  process.exitCode = 1;
} finally {
  await teardownTestEnvironment({ projectRoot, createdStubs });
}