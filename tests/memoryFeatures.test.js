import test from 'node:test';
import assert from 'node:assert/strict';

import { setupTestEnvironment, teardownTestEnvironment } from './helpers/setupStubs.js';

const { projectRoot, createdStubs } = await setupTestEnvironment();

const { resolveReferencedMembers, isShareableEntity } = await import('../index.js');

test('resolveReferencedMembers recognises mentions, ids, and names with rich profiles', async () => {
  const mentionMember = {
    user: {
      id: '111111111111111111',
      username: 'MentionedUser',
      globalName: 'Mentioned Global',
    },
    displayName: 'Mentioned Nick',
  };
  const rawIdMember = {
    user: {
      id: '222222222222222222',
      username: 'RawIdUser',
      globalName: 'Raw Global',
    },
    displayName: 'Raw Nick',
  };
  const nameMatchMember = {
    user: {
      id: '333333333333333333',
      username: 'TopicUser',
      globalName: 'Topic Global',
    },
    displayName: 'Topic',
  };

  const membersCache = new Map([
    [mentionMember.user.id, mentionMember],
    [rawIdMember.user.id, rawIdMember],
    [nameMatchMember.user.id, nameMatchMember],
  ]);

  const message = {
    mentions: {
      members: {
        forEach(callback) {
          callback(mentionMember);
        },
      },
    },
    guild: {
      members: {
        cache: {
          values() {
            return membersCache.values();
          },
        },
        async fetch(id) {
          if (id === rawIdMember.user.id) {
            return rawIdMember;
          }
          throw new Error('Unknown member');
        },
      },
    },
  };

  const result = await resolveReferencedMembers(
    message,
    'Hello 222222222222222222 and Topic! <@111111111111111111>'
  );

  assert.equal(result.length, 3);
  assert.deepEqual(result.find((entry) => entry.id === mentionMember.user.id), {
    id: mentionMember.user.id,
    username: mentionMember.user.username,
    displayName: mentionMember.displayName,
    globalName: mentionMember.user.globalName,
    user: mentionMember.user,
  });
  assert.deepEqual(result.find((entry) => entry.id === rawIdMember.user.id), {
    id: rawIdMember.user.id,
    username: rawIdMember.user.username,
    displayName: rawIdMember.displayName,
    globalName: rawIdMember.user.globalName,
    user: rawIdMember.user,
  });
  assert.deepEqual(result.find((entry) => entry.id === nameMatchMember.user.id), {
    id: nameMatchMember.user.id,
    username: nameMatchMember.user.username,
    displayName: nameMatchMember.displayName,
    globalName: nameMatchMember.user.globalName,
    user: nameMatchMember.user,
  });
});

test('isShareableEntity enforces consent-aware sharing', () => {
  assert.equal(isShareableEntity(null, 'requester'), true);
  assert.equal(isShareableEntity({ consent: 'shareable' }, 'requester'), true);
  assert.equal(isShareableEntity({ consent: 'private' }, 'requester'), false);
  assert.equal(
    isShareableEntity({ consent: 'consent_required', entity_id: 'requester' }, 'requester'),
    true,
  );
  assert.equal(
    isShareableEntity({ consent: 'consent_required', entity_id: 'someone-else' }, 'requester'),
    false,
  );
});

test.after(async () => {
  await teardownTestEnvironment({ projectRoot, createdStubs });
});
