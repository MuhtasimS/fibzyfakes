import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeContextForHistory } from '../tools/historyUtils.js';
import { __test as analyzerTest } from '../tools/insightAnalyzer.js';

describe('sanitizeContextForHistory', () => {
  it('replaces contextual blocks with a generic placeholder when no mention exists', () => {
    const parts = [
      { text: 'hello there' },
      { text: '\n--- Additional Context: Something ---' },
      { text: '\n--- Additional Context: Something Else ---' },
    ];
    const sanitized = sanitizeContextForHistory(parts, null);
    assert.equal(sanitized.length, 2);
    assert.equal(
      sanitized[1].text,
      '[Context for this turn included retrieved conversations or persona updates.]',
    );
  });

  it('keeps placeholders unique while preserving original user text', () => {
    const parts = [
      { text: 'primary message' },
      { text: '\n--- Additional Context: Extra ---' },
      { text: 'primary message' },
    ];
    const sanitized = sanitizeContextForHistory(parts, 'alice');
    assert.equal(sanitized.length, 2);
    assert.deepEqual(sanitized[0], { text: 'primary message' });
    assert.equal(sanitized[1].text, '[Context for user @alice was included in this turn.]');
  });
});

describe('background insight helpers', () => {
  it('parses valid JSON while rejecting malformed outputs', () => {
    const { safeJsonParse } = analyzerTest;
    assert.deepEqual(safeJsonParse('{"foo": 1}'), { foo: 1 });
    assert.equal(safeJsonParse('{foo: 1}'), null);
  });

  it('builds prompts that include conversation metadata', () => {
    const { buildAnalyzerPrompt } = analyzerTest;
    const prompt = buildAnalyzerPrompt({
      userMessage: { text: 'hi' },
      assistantMessage: { text: 'hello' },
      metadata: { guildId: '123', messageId: 'abc' },
    });
    assert.ok(prompt.includes('"guildId": "123"'));
    assert.ok(prompt.includes('"assistant"'));
  });
});