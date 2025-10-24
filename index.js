import {
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  PermissionsBitField,
  EmbedBuilder,
  AttachmentBuilder,
  ActivityType,
  ComponentType,
  REST,
  Routes,
} from 'discord.js';
import {
  HarmBlockThreshold,
  HarmCategory
} from '@google/genai';
import fs from 'fs/promises';
import {
  createWriteStream
} from 'fs';
import path from 'path';
import {
  getTextExtractor
} from 'office-text-extractor'
import osu from 'node-os-utils';
const {
  mem,
  cpu
} = osu;
import axios from 'axios';

import { Storage } from '@google-cloud/storage';
const storage = new Storage();
const BUCKET_NAME = 'fibzyfakes';

import config from './config.js';
import {
  retrieveRelevantMemories,
  retrieveEntityInsights,
  storeMessageTurn,
  getSelfContextSnippets,
  getEntitiesByIds,
  deleteUserMemories,
  deleteServerMemories,
} from './memoryManager.js';
import { queueInsightAnalysis } from './tools/insightAnalyzer.js';
import { sanitizeContextForHistory } from './tools/historyUtils.js';
import {
  client,
  genAI,
  token,
  activeRequests,
  chatHistoryLock,
  state,
  TEMP_DIR,
  initialize,
  saveStateToFile,
  getHistory,
  updateChatHistory,
  getUserResponsePreference,
  initializeBlacklistForGuild
} from './botManager.js';


if (process.env.NODE_ENV !== 'test') {
  initialize().catch(console.error);
}


// <=====[Configuration]=====>

const MODEL = "gemini-2.5-pro";

/*
`BLOCK_NONE`  -  Always show regardless of probability of unsafe content
`BLOCK_ONLY_HIGH`  -  Block when high probability of unsafe content
`BLOCK_MEDIUM_AND_ABOVE`  -  Block when medium or high probability of unsafe content
`BLOCK_LOW_AND_ABOVE`  -  Block when low, medium or high probability of unsafe content
`HARM_BLOCK_THRESHOLD_UNSPECIFIED`  -  Threshold is unspecified, block using default threshold
*/
const safetySettings = [{
  category: HarmCategory.HARM_CATEGORY_HARASSMENT,
  threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
  category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
  category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  threshold: HarmBlockThreshold.BLOCK_NONE,
},
{
  category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
  threshold: HarmBlockThreshold.BLOCK_NONE,
},
];

const generationConfig = {
  temperature: 1.0,
  topP: 0.95,
  // maxOutputTokens: 1000,
  thinkingConfig: {
    thinkingBudget: -1
  }
};

const defaultResponseFormat = config.defaultResponseFormat;
const defaultTool = config.defaultTool;
const hexColour = config.hexColour;
const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));
const defaultPersonality = config.defaultPersonality;
const defaultServerSettings = config.defaultServerSettings;
const workInDMs = config.workInDMs;
const shouldDisplayPersonalityButtons = config.shouldDisplayPersonalityButtons;
const SEND_RETRY_ERRORS_TO_DISCORD = config.SEND_RETRY_ERRORS_TO_DISCORD;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatRelativeTime(deltaMs) {
  const abs = Math.abs(deltaMs);
  const seconds = Math.floor(abs / 1000);
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'}`;
}

async function resolveReferencedMembers(message, messageContent) {
  const referenced = new Map();
  const guild = message.guild;
  const addMember = (member) => {
    if (!member || !member.user) {
      return;
    }
    if (referenced.has(member.user.id)) {
      return;
    }
    referenced.set(member.user.id, {
      id: member.user.id,
      username: member.user.username,
      displayName: member.displayName,
      globalName: member.user.globalName,
      user: member.user,
    });
  };

  message.mentions?.members?.forEach(addMember);
  if (!guild) {
    return Array.from(referenced.values());
  }

  const rawIdMatches = messageContent.match(/\b\d{17,19}\b/g) || [];
  for (const rawId of rawIdMatches) {
    try {
      const member = await guild.members.fetch(rawId);
      addMember(member);
    } catch (error) {
      // ignore missing members
    }
  }

  const normalizedContent = messageContent.toLowerCase();
  let checked = 0;
  for (const member of guild.members.cache.values()) {
    if (checked > 200) {
      break;
    }
    checked += 1;
    const namesToCheck = [member.displayName, member.user.username, member.user.globalName].filter(Boolean);
    for (const candidate of namesToCheck) {
      const candidateNormalized = candidate.toLowerCase();
      if (candidateNormalized.length < 3) {
        continue;
      }
      const pattern = new RegExp(`\\b${escapeRegex(candidateNormalized)}\\b`, 'i');
      if (pattern.test(normalizedContent)) {
        addMember(member);
        break;
      }
    }
  }
  return Array.from(referenced.values());
}

function isShareableEntity(metadata, requesterId) {
  if (!metadata) {
    return true;
  }
  if (metadata.consent === 'private') {
    return false;
  }
  if (metadata.consent === 'consent_required' && metadata.entity_id !== requesterId) {
    return false;
  }
  return true;
}

function formatEntityInsights(insights) {
  return insights
    .map((entry) => {
      const name = entry.metadata?.name || entry.metadata?.entity_id || 'Entity';
      const lastMention = entry.metadata?.last_mentioned_at ? ` (last mentioned ${entry.metadata.last_mentioned_at})` : '';
      return `- ${name}${lastMention}: ${entry.document.length > 300 ? `${entry.document.slice(0, 300)}…` : entry.document}`;
    })
    .join('\n');
}

import {
  delay,
  retryWithBackoff,
} from './tools/others.js';

// <==========>



// <=====[Register Commands And Activities]=====>

import {
  commands
} from './commands.js';

let activityIndex = 0;
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const rest = new REST().setToken(token);
  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(client.user.id), {
      body: commands
    },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }

  client.user.setPresence({
    activities: [activities[activityIndex]],
    status: 'idle',
  });

  setInterval(() => {
    activityIndex = (activityIndex + 1) % activities.length;
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status: 'idle',
    });
  }, 30000);
});

// <==========>



// <=====[Messages And Interaction]=====>

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.content.startsWith('!')) return;

    const isDM = message.channel.type === ChannelType.DM;

    const shouldRespond = (
      workInDMs && isDM ||
      state.alwaysRespondChannels[message.channelId] ||
      (message.mentions.users.has(client.user.id) && !isDM) ||
      state.activeUsersInChannels[message.channelId]?.[message.author.id]
    );

    if (shouldRespond) {
      if (message.guild) {
        initializeBlacklistForGuild(message.guild.id);
        if (state.blacklistedUsers[message.guild.id].includes(message.author.id)) {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('Blacklisted')
            .setDescription('You are blacklisted and cannot use this bot.');
          return message.reply({
            embeds: [embed]
          });
        }
      }
      if (activeRequests.has(message.author.id)) {
        const embed = new EmbedBuilder()
          .setColor(0xFFFF00)
          .setTitle('Request In Progress')
          .setDescription('Please wait until your previous action is complete.');
        await message.reply({
          embeds: [embed]
        });
      } else {
        activeRequests.add(message.author.id);
        await handleTextMessage(message);
      }
    }
  } catch (error) {
    console.error('Error processing the message:', error);
    if (activeRequests.has(message.author.id)) {
      activeRequests.delete(message.author.id);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error('Error handling interaction:', error.message);
  }
});

async function handleCommandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  const commandHandlers = {
    respond_to_all: handleRespondToAllCommand,
    toggle_channel_chat_history: toggleChannelChatHistory,
    whitelist: handleWhitelistCommand,
    blacklist: handleBlacklistCommand,
    clear_memory: handleClearMemoryCommand,
    settings: showSettings,
    server_settings: showDashboard,
    status: handleStatusCommand
  };

  const handler = commandHandlers[interaction.commandName];
  if (handler) {
    await handler(interaction);
  } else {
    console.log(`Unknown command: ${interaction.commandName}`);
  }
}

async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;

  if (interaction.guild) {
    initializeBlacklistForGuild(interaction.guild.id);
    if (state.blacklistedUsers[interaction.guild.id].includes(interaction.user.id)) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Blacklisted')
        .setDescription('You are blacklisted and cannot use this interaction.');
      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    }
  }

  const buttonHandlers = {
    'server-chat-history': toggleServerWideChatHistory,
    'clear-server': clearServerChatHistory,
    'settings-save-buttons': toggleSettingSaveButton,
    'custom-server-personality': serverPersonality,
    'toggle-server-personality': toggleServerPersonality,
    'download-server-conversation': downloadServerConversation,
    'response-server-mode': toggleServerPreference,
    'toggle-response-server-mode': toggleServerResponsePreference,
    'settings': showSettings,
    'back_to_main_settings': editShowSettings,
    'clear-memory': handleClearMemoryCommand,
    'always-respond': alwaysRespond,
    'custom-personality': handleCustomPersonalityCommand,
    'remove-personality': handleRemovePersonalityCommand,
    'toggle-response-mode': handleToggleResponseMode,
    'download-conversation': downloadConversation,
    'download_message': downloadMessage,
    'general-settings': handleSubButtonInteraction,
  };

  for (const [key, handler] of Object.entries(buttonHandlers)) {
    if (interaction.customId.startsWith(key)) {
      await handler(interaction);
      return;
    }
  }

  if (interaction.customId.startsWith('delete_message-')) {
    const msgId = interaction.customId.replace('delete_message-', '');
    await handleDeleteMessageInteraction(interaction, msgId);
  }
}

async function handleDeleteMessageInteraction(interaction, msgId) {
  const userId = interaction.user.id;
  const userChatHistory = state.chatHistories[userId];
  const channel = interaction.channel;
  const message = channel ? (await channel.messages.fetch(msgId).catch(() => false)) : false;

  if (userChatHistory) {
    if (userChatHistory[msgId]) {
      delete userChatHistory[msgId];
      await deleteMsg();
    } else {
      try {
        const replyingTo = message ? (message.reference ? (await message.channel.messages.fetch(message.reference.messageId)).author.id : 0) : 0;
        if (userId === replyingTo) {
          await deleteMsg();
        } else {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('Not For You')
            .setDescription('This button is not meant for you.');
          return interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
          });
        }
      } catch (error) { }
    }
  }

  async function deleteMsg() {
    await interaction.message.delete()
      .catch('Error deleting interaction message: ', console.error);

    if (channel) {
      if (message) {
        message.delete().catch(() => { });
      }
    }
  }
}

async function handleClearMemoryCommand(interaction) {
  const userId = interaction.user.id;
  const serverChatHistoryEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.serverChatHistory : false;

  if (serverChatHistoryEnabled) {
    // This is the original safety check. If server-wide history is on, we stop here.
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('Feature Disabled')
      .setDescription('Clearing chat history is not enabled for this server, as Server-Wide chat history is active.');
    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
  } else {
    // Server-wide history is OFF, so we can proceed with the confirmation flow.

    // First, check if there's any personal history to clear.
    if (!state.chatHistories[userId]) {
      return await interaction.reply({ content: 'You have no personal chat history to clear.', ephemeral: true });
    }

    // 1. Create the confirmation buttons.
    const confirmButton = new ButtonBuilder()
      .setCustomId('confirm_clear')
      .setLabel('Yes, clear it')
      .setStyle(ButtonStyle.Danger); // Red for a destructive action.

    const cancelButton = new ButtonBuilder()
      .setCustomId('cancel_clear')
      .setLabel('No, cancel')
      .setStyle(ButtonStyle.Secondary); // Grey for a safe action.

    // 2. Create an action row to hold the buttons.
    const row = new ActionRowBuilder()
      .addComponents(confirmButton, cancelButton);

    // 3. Send the confirmation message with the buttons.
    const confirmationMessage = await interaction.reply({
      content: 'Are you sure you want to permanently clear your personal chat history?',
      components: [row],
      ephemeral: true // Only the user who ran the command will see this.
    });

    // 4. Create a collector to listen for a button click from only this user.
    const filter = i => i.user.id === userId;
    const collector = confirmationMessage.createMessageComponentCollector({ filter, time: 60000 }); // Wait for 60 seconds.

    collector.on('collect', async i => {
      if (i.customId === 'confirm_clear') {
        // If "Yes" is clicked, clear the memory.
        delete state.chatHistories[userId];
        await saveStateToFile();
        try {
          await deleteUserMemories({
            historyId: userId,
            userId,
            guildId: interaction.guild ? interaction.guild.id : null,
          });
        } catch (error) {
          console.warn('Failed to purge vectorized user memories:', error.message);
        }
        // Update the message to show success and remove the buttons.
        await i.update({ content: 'Your personal chat history has been cleared.', components: [] });
      } else if (i.customId === 'cancel_clear') {
        // If "No" is clicked, cancel the action.
        await i.update({ content: 'Action canceled. Your chat history was not cleared.', components: [] });
      }
    });

    collector.on('end', collected => {
      // This runs after the 60-second timer is up.
      if (collected.size === 0) {
        // If no button was clicked, edit the message to show it timed out.
        interaction.editReply({ content: 'Confirmation timed out. Your chat history was not cleared.', components: [] });
      }
    });
  }
}

async function handleCustomPersonalityCommand(interaction) {
  const serverCustomEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.customServerPersonality : false;
  if (!serverCustomEnabled) {
    await setCustomPersonality(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('Feature Disabled')
      .setDescription('Custom personality is not enabled for this server, Server-Wide personality is active.');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleRemovePersonalityCommand(interaction) {
  const isServerEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.customServerPersonality : false;
  if (!isServerEnabled) {
    await removeCustomPersonality(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('Feature Disabled')
      .setDescription('Custom personality is not enabled for this server, Server-Wide personality is active.');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleToggleResponseMode(interaction) {
  const serverResponsePreferenceEnabled = interaction.guild ? state.serverSettings[interaction.guild.id]?.serverResponsePreference : false;
  if (!serverResponsePreferenceEnabled) {
    await toggleUserResponsePreference(interaction);
  } else {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('Feature Disabled')
      .setDescription('Toggling Response Mode is not enabled for this server, Server-Wide Response Mode is active.');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function editShowSettings(interaction) {
  await showSettings(interaction, true);
}

// <==========>



// <=====[Messages Handling]=====>

async function handleTextMessage(message) {
  const botId = client.user.id;
  const userId = message.author.id;
  const guildId = message.guild?.id;
  const channelId = message.channel.id;
  let messageContent = message.content.replace(new RegExp(`<@!?${botId}>`), '').trim();

  if (messageContent === '' && !(message.attachments.size > 0 && hasSupportedAttachments(message))) {
    if (activeRequests.has(userId)) {
      activeRequests.delete(userId);
    }
    const embed = new EmbedBuilder()
      .setColor(0x00FFFF)
      .setTitle('Empty Message')
      .setDescription("It looks like you didn't say anything. What would you like to talk about?");
    const botMessage = await message.reply({
      embeds: [embed]
    });
    await addSettingsButton(botMessage);
    return;
  }
  message.channel.sendTyping();
  const typingInterval = setInterval(() => {
    message.channel.sendTyping();
  }, 4000);
  setTimeout(() => {
    clearInterval(typingInterval);
  }, 120000);
  let botMessage = false;
  let parts;
  let initialUrlContextMetadata = null;
  try {
    if (SEND_RETRY_ERRORS_TO_DISCORD) {
      clearInterval(typingInterval);
      const updateEmbedDescription = (textAttachmentStatus, imageAttachmentStatus, finalText) => {
        return `Let me think...\n\n- ${textAttachmentStatus}: Text Attachment Check\n- ${imageAttachmentStatus}: Media Attachment Check\n${finalText || ''}`;
      };

      const embed = new EmbedBuilder()
        .setColor(0x00FFFF)
        .setTitle('Processing')
        .setDescription(updateEmbedDescription('[🔁]', '[🔁]'));
      botMessage = await message.reply({
        embeds: [embed]
      });

      messageContent = await extractFileText(message, messageContent);
      embed.setDescription(updateEmbedDescription('[☑️]', '[🔁]'));
      await botMessage.edit({
        embeds: [embed]
      });

      parts = await processPromptAndMediaAttachments(messageContent, message);
      embed.setDescription(updateEmbedDescription('[☑️]', '[☑️]', '### All checks done. Waiting for the response...'));
      await botMessage.edit({
        embeds: [embed]
      });
    } else {
      messageContent = await extractFileText(message, messageContent);
      parts = await processPromptAndMediaAttachments(messageContent, message);
    }

    const urlEnrichment = await enrichPartsWithUrlContext(parts, messageContent);
    parts = urlEnrichment.parts;
    initialUrlContextMetadata = urlEnrichment.metadata;
  } catch (error) {
    return console.error('Error initialising message', error);
  }

  // --- NEW LOGIC TO CROSS-REFERENCE CONVERSATIONS & INSTRUCTIONS (v4) ---

  const referencedMembers = await resolveReferencedMembers(message, messageContent);
  const mentionedUserEntry = referencedMembers.find((entry) => entry.id !== client.user.id);
  const mentionedUser = mentionedUserEntry ? mentionedUserEntry.user : null;

  if (mentionedUser) {
    console.log(`Referenced user detected: ${mentionedUser.username} (ID: ${mentionedUser.id})`);

    // --- CHAT HISTORY LOOKUP ---
    const otherUserHistory = getHistory(mentionedUser.id);

    if (otherUserHistory && otherUserHistory.length > 0) {
      // TRUNCATION: Only take the last 20 messages from the other user's history.
      const RECENT_MESSAGES_LIMIT = 20;
      const truncatedHistory = otherUserHistory.slice(-RECENT_MESSAGES_LIMIT);

      const historyText = truncatedHistory.map(h => {
        const content = h.parts?.map(p => p.text).join(' ') || '';
        return `${h.role}: ${content}`;
      }).join('\n');
      const historyContextPart = {
        text: `\n\n--- Additional Context: Conversation History ---\nFor my next response, I must consider the last few messages from my conversation history with the user "${mentionedUser.username}". Here is that history:\n\n${historyText}\n\n--- End of Conversation History ---`
      };

      parts.unshift(historyContextPart);
      console.log(`Successfully loaded and prepended the last ${truncatedHistory.length} messages for ${mentionedUser.username}.`);
    } else {
      console.log(`No chat history found via getHistory() for the mentioned user: ${mentionedUser.username}`);
    }

    // --- PERSONALITY INSTRUCTIONS LOOKUP (This part is correct) ---
    const personalityInstructions = state.customInstructions[mentionedUser.id];
    if (personalityInstructions && personalityInstructions.trim() !== '') {
      const instructionContextPart = {
        text: `\n\n--- Additional Context: User's Personality Instructions ---\nFor my next response, I must also consider the personality instructions given to me by "${mentionedUser.username}". Here are those instructions:\n\n"${personalityInstructions}"\n\n--- End of Personality Instructions ---`
      };

      parts.unshift(instructionContextPart);
      console.log(`Successfully loaded and prepended personality instructions for ${mentionedUser.username}.`);
    } else {
      console.log(`No custom instructions found for the mentioned user: ${mentionedUser.username}`);
    }
  }
  // --- END OF NEW LOGIC ---


  let retrievedMemories = [];
  try {
    retrievedMemories = await retrieveRelevantMemories({
      query: messageContent,
      userId,
      guildId,
      channelId,
      limit: 5,
    });
  } catch (error) {
    console.warn('Failed to retrieve long-term memories:', error.message);
  }

  let entityInsights = [];
  try {
    const directEntityIds = referencedMembers.map((entry) => entry.id);
    if (directEntityIds.length) {
      const direct = await getEntitiesByIds(directEntityIds);
      entityInsights.push(...direct);
    }
    const semanticEntities = await retrieveEntityInsights({
      query: messageContent,
      limit: 5,
      guildId,
    });
    entityInsights.push(...semanticEntities);
  } catch (error) {
    console.warn('Failed to retrieve entity insights:', error.message);
  }

  const shareableEntityInsights = [];
  const seenEntityIds = new Set();
  for (const insight of entityInsights) {
    const entityId = insight.metadata?.entity_id || insight.metadata?.name || insight.document.slice(0, 30);
    if (seenEntityIds.has(entityId)) {
      continue;
    }
    if (!isShareableEntity(insight.metadata, userId)) {
      continue;
    }
    shareableEntityInsights.push(insight);
    seenEntityIds.add(entityId);
  }

  if (retrievedMemories.length) {
    const formattedMemories = retrievedMemories
      .map((entry, index) => {
        const label = entry.metadata?.role === 'assistant'
          ? 'Fibz'
          : (entry.metadata?.username || 'User');
        const timestamp = entry.metadata?.created_at ? ` [${entry.metadata.created_at}]` : '';
        const snippet = entry.document.length > 400
          ? `${entry.document.slice(0, 400)}…`
          : entry.document;
        return `${index + 1}. ${label}${timestamp}: ${snippet}`;
      })
      .join('\n');
    parts.unshift({
      text: `\n\n--- Additional Context: Retrieved Long-Term Memory ---\nUse these high-signal memories to ground your reply:\n${formattedMemories}\n--- End of Retrieved Memory ---`,
    });
  }

  if (shareableEntityInsights.length) {
    const formattedEntities = formatEntityInsights(shareableEntityInsights);
    parts.unshift({
      text: `\n\n--- Additional Context: Known Entities ---\nLeverage these entity snapshots when relevant:\n${formattedEntities}\n--- End of Known Entities ---`,
    });
  }


  let instructions;
  if (guildId) {
    if (state.channelWideChatHistory[channelId]) {
      instructions = state.customInstructions[channelId];
    } else if (state.serverSettings[guildId]?.customServerPersonality && state.customInstructions[guildId]) {
      instructions = state.customInstructions[guildId];
    } else {
      instructions = state.customInstructions[userId];
    }
  } else {
    instructions = state.customInstructions[userId];
  }

  let infoStr = '';
  if (guildId) {
    const userInfo = {
      username: message.author.username,
      displayName: message.author.displayName
    };
    infoStr = `\nYou are currently engaging with users in the ${message.guild.name} Discord server.\n\n## Current User Information\nUsername: \`${userInfo.username}\`\nDisplay Name: \`${userInfo.displayName}\``;
  }

  // --- NEW LOGIC TO PREPEND DEFAULT PERSONALITY ---

  // 1. Start with the base defaultPersonality as the foundation for all interactions.
  let finalInstructions = defaultPersonality;

  // 2. If custom instructions exist (from user, channel, or server settings), append them.
  if (instructions) {
    finalInstructions += "\n\n---\n\n" + instructions;
  }

  // 3. Append server and user info if applicable, just like before.
  const isServerChatHistoryEnabled = guildId ? state.serverSettings[guildId]?.serverChatHistory : false;
  if (isServerChatHistoryEnabled && infoStr) {
    finalInstructions += infoStr;
  }

  const selfContextSnippets = getSelfContextSnippets();
  if (selfContextSnippets.length) {
    const summarizedNotes = selfContextSnippets
      .map((snippet) => {
        const title = snippet.metadata?.title || snippet.metadata?.key || 'Note';
        const doc = snippet.document.length > 400 ? `${snippet.document.slice(0, 400)}…` : snippet.document;
        return `- ${title}: ${doc}`;
      })
      .join('\n');
    finalInstructions += `\n\n---\n\n# Fibz Internal Notes\n${summarizedNotes}`;
  }

  const now = new Date();
  const messageTimestamp = message.createdAt;
  const relative = formatRelativeTime(now - messageTimestamp);
  finalInstructions += `\n\n---\n\n# Temporal Context\nCurrent UTC time: ${now.toISOString()}\nMost recent user message timestamp: ${messageTimestamp.toISOString()} (${relative} ago). Use this to distinguish recent events from older history.`;

  finalInstructions += `\n\n---\n\n# Disclosure Guidance\nWhen asked about Fibz or other entities, consult the provided memories and share only items whose consent is shareable or belong to the requester. Decline or request consent before disclosing items marked private or consent_required.`;

  // This part of the logic remains the same.
  const isChannelChatHistoryEnabled = guildId ? state.channelWideChatHistory[channelId] : false;
  const historyId = isChannelChatHistoryEnabled ? (isServerChatHistoryEnabled ? guildId : channelId) : userId;

  // --- END OF NEW LOGIC ---

  // Always enable all three tools: Google Search, URL Context, and Code Execution.
  const tools = [
    { googleSearch: {} },
    // URL context is handled manually to avoid external vector store issues.
    //Disabled Code execution for now as it crashes the system.
  ];

  // Create chat with new Google GenAI API format
  // Create chat with new Google GenAI API format
  const chat = genAI.chats.create({
    model: MODEL,
    config: {
      systemInstruction: {
        role: "system",
        parts: [{ text: finalInstructions }] // The fallback is no longer needed.
      },
      ...generationConfig,
      safetySettings,
      tools
    },
    history: getHistory(historyId)
  });

  await handleModelResponse(botMessage, chat, parts, message, typingInterval, historyId, mentionedUser, initialUrlContextMetadata);
}

function hasSupportedAttachments(message) {
  const supportedFileExtensions = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

  return message.attachments.some((attachment) => {
    const contentType = (attachment.contentType || "").toLowerCase();
    const fileExtension = path.extname(attachment.name) || '';
    return (
      (contentType.startsWith('image/') && contentType !== 'image/gif') ||
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('application/pdf') ||
      contentType.startsWith('application/x-pdf') ||
      supportedFileExtensions.includes(fileExtension)
    );
  });
}

async function downloadFile(url, filePath) {
  await retryWithBackoff(async () => {
    const writer = createWriteStream(filePath);
    try {
      const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: URL_FETCH_TIMEOUT_MS,
      });

      await new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      writer.destroy();
      await fs.rm(filePath, { force: true }).catch(() => {});
      if (error.code === 'ECONNABORTED') {
        const timeoutError = new Error('Request timed out');
        timeoutError.name = 'TimeoutError';
        throw timeoutError;
      }
      throw error;
    }
  });
}

function sanitizeFileName(fileName) {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function processPromptAndMediaAttachments(prompt, message) {
  const attachments = JSON.parse(JSON.stringify(Array.from(message.attachments.values())));
  let parts = [{
    text: prompt
  }];

  if (attachments.length > 0) {
    const validAttachments = attachments.filter(attachment => {
      const contentType = (attachment.contentType || "").toLowerCase();
      return (contentType.startsWith('image/') && contentType !== 'image/gif') ||
        contentType.startsWith('audio/') ||
        contentType.startsWith('video/') ||
        contentType.startsWith('application/pdf') ||
        contentType.startsWith('application/x-pdf');
    });

    if (validAttachments.length > 0) {
      const attachmentParts = await Promise.all(
        validAttachments.map(async (attachment) => {
          const sanitizedFileName = sanitizeFileName(attachment.name);
          const uniqueTempFilename = `${message.author.id}-${attachment.id}-${sanitizedFileName}`;
          const filePath = path.join(TEMP_DIR, uniqueTempFilename);

          try {
            // This part is correct, it downloads the file to a temporary location.
            await downloadFile(attachment.url, filePath);

            // --- NEW GCS UPLOAD LOGIC STARTS HERE ---

            // Define a unique name for the file in the GCS bucket.
            const gcsFileName = `${Date.now()}-${sanitizedFileName}`;

            // Upload the local file from the temp directory to your GCS bucket.
            await retryWithBackoff(() => storage.bucket(BUCKET_NAME).upload(filePath, {
              destination: gcsFileName,
            }));

            // Construct the GCS URI that Vertex AI needs.
            const gcsUri = `gs://${BUCKET_NAME}/${gcsFileName}`;

            // Return the object structure that the Vertex AI API expects for a file.
            // This replaces the old `createPartFromUri` function call.
            return {
              fileData: {
                mimeType: attachment.contentType,
                fileUri: gcsUri,
              },
            };
            // --- END OF NEW LOGIC ---

          } catch (error) {
            console.error(`Error processing attachment ${sanitizedFileName}:`, error);
            return null;
          } finally {
            // This original cleanup logic is perfect and ensures the temporary local file is deleted.
            try {
              await fs.unlink(filePath);
            } catch (unlinkError) {
              if (unlinkError.code !== 'ENOENT') {
                console.error(`Error deleting temporary file ${filePath}:`, unlinkError);
              }
            }
          }
        })
      );
      parts = [...parts, ...attachmentParts.filter(part => part !== null)];
    }
  }
  return parts;
}

const URL_IN_MESSAGE_REGEX = /https?:\/\/[^\s<>()]+/gi;
const MAX_URLS_FOR_CONTEXT = 3;
const MAX_URL_CONTEXT_CHARS = 3000;
const URL_FETCH_TIMEOUT_MS = 8000;
const URL_CONTEXT_USER_AGENT = 'FibzBot/1.0 (+https://github.com/fibzy/fibzyfakes)';

async function enrichPartsWithUrlContext(parts, messageContent) {
  try {
    const urls = extractUrlsFromText(messageContent);
    if (urls.length === 0) {
      return { parts, metadata: null };
    }

    const limitedUrls = urls.slice(0, MAX_URLS_FOR_CONTEXT);
    const contextParts = [];
    const metadata = [];

    for (const url of limitedUrls) {
      try {
        const { content, truncated } = await fetchUrlContext(url);
        if (!content) {
          metadata.push({
            retrieved_url: url,
            url_retrieval_status: 'URL_RETRIEVAL_STATUS_ERROR',
          });
          continue;
        }

        metadata.push({
          retrieved_url: url,
          url_retrieval_status: 'URL_RETRIEVAL_STATUS_SUCCESS',
        });

        let contextText = `\n\n--- Additional Context: URL (${url}) ---\n${content}`;
        if (truncated) {
          contextText += '\n\n(Note: Content truncated for length.)';
        }
        contextText += '\n--- End of URL Context ---';
        contextParts.push({ text: contextText });
      } catch (error) {
        console.warn(`Failed to retrieve URL context for ${url}: ${error.message}`);
        metadata.push({
          retrieved_url: url,
          url_retrieval_status: mapUrlErrorToStatus(error),
        });
      }
    }

    return {
      parts: contextParts.length > 0 ? [...parts, ...contextParts] : parts,
      metadata: metadata.length > 0 ? { url_metadata: metadata } : null,
    };
  } catch (error) {
    console.error('Failed to enrich message with URL context:', error);
    return { parts, metadata: null };
  }
}

function extractUrlsFromText(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const matches = text.match(URL_IN_MESSAGE_REGEX) || [];
  const uniqueUrls = new Set();
  const orderedUrls = [];

  for (const rawUrl of matches) {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized || uniqueUrls.has(normalized)) {
      continue;
    }
    uniqueUrls.add(normalized);
    orderedUrls.push(normalized);
  }

  return orderedUrls;
}

function normalizeUrl(rawUrl) {
  let candidate = rawUrl.trim();

  while (/[),.;!?]$/.test(candidate)) {
    const shortened = candidate.slice(0, -1);
    try {
      const parsed = new URL(shortened);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        candidate = shortened;
        continue;
      }
    } catch (_) {
      // Ignore and break if shortening results in invalid URL.
    }
    break;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

async function fetchUrlContext(url) {
  const { data, headers } = await retryWithBackoff(() => axios.get(url, {
    responseType: 'text',
    transformResponse: value => value,
    timeout: URL_FETCH_TIMEOUT_MS,
    maxContentLength: 2_000_000,
    headers: {
      'User-Agent': URL_CONTEXT_USER_AGENT,
      'Accept': 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
    },
    validateStatus: status => status >= 200 && status < 300,
  }));

  const contentType = (headers['content-type'] || '').toLowerCase();
  let textContent = typeof data === 'string' ? data : String(data ?? '');

  if (contentType.includes('application/json')) {
    try {
      textContent = JSON.stringify(JSON.parse(textContent), null, 2);
    } catch (_) {
      // Keep original textContent if parsing fails.
    }
  } else if (contentType.includes('text/html')) {
    textContent = stripHtmlTags(textContent);
  }

  textContent = decodeBasicEntities(textContent)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (!textContent) {
    return { content: '', truncated: false };
  }

  let truncated = false;
  if (textContent.length > MAX_URL_CONTEXT_CHARS) {
    textContent = `${textContent.slice(0, MAX_URL_CONTEXT_CHARS)}...`;
    truncated = true;
  }

  return { content: textContent, truncated };
}

function stripHtmlTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--.*?-->/gs, ' ')
    .replace(/<(?:br|p|div|li|ul|ol|section|article|header|footer|h[1-6])[^>]*>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|ul|ol|section|article|header|footer|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function decodeBasicEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function mapUrlErrorToStatus(error) {
  const status = error?.response?.status ?? error?.status;
  if (status === 402 || status === 403) {
    return 'URL_RETRIEVAL_STATUS_PAYWALL';
  }
  if (status === 451) {
    return 'URL_RETRIEVAL_STATUS_UNSAFE';
  }
  return 'URL_RETRIEVAL_STATUS_ERROR';
}


async function extractFileText(message, messageContent) {
  if (message.attachments.size > 0) {
    let attachments = Array.from(message.attachments.values());
    for (const attachment of attachments) {
      const fileType = path.extname(attachment.name) || '';
      const fileTypes = ['.html', '.js', '.css', '.json', '.xml', '.csv', '.py', '.java', '.sql', '.log', '.md', '.txt', '.docx', '.pptx'];

      if (fileTypes.includes(fileType)) {
        try {
          let fileContent = await downloadAndReadFile(attachment.url, fileType);
          messageContent += `\n\n[\`${attachment.name}\` File Content]:\n\`\`\`\n${fileContent}\n\`\`\``;
        } catch (error) {
          console.error(`Error reading file ${attachment.name}: ${error.message}`);
        }
      }
    }
  }
  return messageContent;
}

async function downloadAndReadFile(url, fileType) {
  switch (fileType) {
    case 'pptx':
    case 'docx':
      const extractor = getTextExtractor();
      return (await extractor.extractText({
        input: url,
        type: 'url'
      }));
    default:
      return await retryWithBackoff(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            const error = new Error(`Failed to download ${response.statusText}`);
            error.status = response.status;
            throw error;
          }
          return await response.text();
        } catch (error) {
          if (error.name === 'AbortError') {
            const timeoutError = new Error('Fetch timed out');
            timeoutError.name = 'TimeoutError';
            throw timeoutError;
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      });
  }
}

// <==========>



// <=====[Interaction Reply]=====>

async function handleModalSubmit(interaction) {
  if (interaction.customId === 'custom-personality-modal') {
    try {
      const customInstructionsInput = interaction.fields.getTextInputValue('custom-personality-input');
      state.customInstructions[interaction.user.id] = customInstructionsInput.trim();

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Success')
        .setDescription('Custom Personality Instructions Saved!');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.log(error.message);
    }
  } else if (interaction.customId === 'custom-server-personality-modal') {
    try {
      const customInstructionsInput = interaction.fields.getTextInputValue('custom-server-personality-input');
      state.customInstructions[interaction.guild.id] = customInstructionsInput.trim();

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Success')
        .setDescription('Custom Server Personality Instructions Saved!');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.log(error.message);
    }
  }
}

async function clearChatHistory(interaction) {
  try {
    state.chatHistories[interaction.user.id] = {};
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('Chat History Cleared')
      .setDescription('Chat history cleared!');
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(error.message);
  }
}

async function alwaysRespond(interaction) {
  try {
    const userId = interaction.user.id;
    const channelId = interaction.channelId;

    if (interaction.channel.type === ChannelType.DM) {
      const dmDisabledEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Feature Disabled in DMs')
        .setDescription('This feature is disabled in direct messages.');
      await interaction.reply({
        embeds: [dmDisabledEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (!state.activeUsersInChannels[channelId]) {
      state.activeUsersInChannels[channelId] = {};
    }

    if (state.activeUsersInChannels[channelId][userId]) {
      delete state.activeUsersInChannels[channelId][userId];
    } else {
      state.activeUsersInChannels[channelId][userId] = true;
    }

    await handleSubButtonInteraction(interaction, true);
  } catch (error) {
    console.log(error.message);
  }
}

async function handleRespondToAllCommand(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Command Not Available')
        .setDescription('This command cannot be used in DMs.');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Admin Required')
        .setDescription('You need to be an admin to use this command.');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const channelId = interaction.channelId;
    const enabled = interaction.options.getBoolean('enabled');

    if (enabled) {
      state.alwaysRespondChannels[channelId] = true;
      const startRespondEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Bot Response Enabled')
        .setDescription('The bot will now respond to all messages in this channel.');
      await interaction.reply({
        embeds: [startRespondEmbed],
        ephemeral: false
      });
    } else {
      delete state.alwaysRespondChannels[channelId];
      const stopRespondEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('Bot Response Disabled')
        .setDescription('The bot will now stop responding to all messages in this channel.');
      await interaction.reply({
        embeds: [stopRespondEmbed],
        ephemeral: false
      });
    }
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleChannelChatHistory(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Command Not Available')
        .setDescription('This command cannot be used in DMs.');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Admin Required')
        .setDescription('You need to be an admin to use this command.');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const channelId = interaction.channelId;
    const enabled = interaction.options.getBoolean('enabled');
    const instructions = interaction.options.getString('instructions') || defaultPersonality;

    if (enabled) {
      state.channelWideChatHistory[channelId] = true;
      state.customInstructions[channelId] = instructions;

      const enabledEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Channel History Enabled')
        .setDescription(`Channel-wide chat history has been enabled.`);
      await interaction.reply({
        embeds: [enabledEmbed],
        ephemeral: false
      });
    } else {
      delete state.channelWideChatHistory[channelId];
      delete state.customInstructions[channelId];
      delete state.chatHistories[channelId];

      const disabledEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('Channel History Disabled')
        .setDescription('Channel-wide chat history has been disabled.');
      await interaction.reply({
        embeds: [disabledEmbed],
        ephemeral: false
      });
    }
  } catch (error) {
    console.error('Error in toggleChannelChatHistory:', error);
  }
}

async function handleStatusCommand(interaction) {
  try {
    await interaction.deferReply();

    let interval;

    const updateMessage = async () => {
      try {
        const [{
          totalMemMb,
          usedMemMb,
          freeMemMb,
          freeMemPercentage
        }, cpuPercentage] = await Promise.all([
          mem.info(),
          cpu.usage()
        ]);

        const now = new Date();
        const nextReset = new Date();
        nextReset.setHours(0, 0, 0, 0);
        if (nextReset <= now) {
          nextReset.setDate(now.getDate() + 1);
        }
        const timeLeftMillis = nextReset - now;
        const hours = Math.floor(timeLeftMillis / 3600000);
        const minutes = Math.floor((timeLeftMillis % 3600000) / 60000);
        const seconds = Math.floor((timeLeftMillis % 60000) / 1000);
        const timeLeft = `${hours}h ${minutes}m ${seconds}s`;

        const embed = new EmbedBuilder()
          .setColor(hexColour)
          .setTitle('System Information')
          .addFields({
            name: 'Memory (RAM)',
            value: `Total Memory: \`${totalMemMb}\` MB\nUsed Memory: \`${usedMemMb}\` MB\nFree Memory: \`${freeMemMb}\` MB\nPercentage Of Free Memory: \`${freeMemPercentage}\`%`,
            inline: true
          }, {
            name: 'CPU',
            value: `Percentage of CPU Usage: \`${cpuPercentage}\`%`,
            inline: true
          }, {
            name: 'Time Until Next Reset',
            value: timeLeft,
            inline: true
          })
          .setTimestamp();

        await interaction.editReply({
          embeds: [embed]
        });
      } catch (error) {
        console.error('Error updating message:', error);
        if (interval) clearInterval(interval);
      }
    };

    await updateMessage();

    const message = await interaction.fetchReply();
    await addSettingsButton(message);

    interval = setInterval(updateMessage, 2000);

    setTimeout(() => {
      clearInterval(interval);
    }, 30000);

  } catch (error) {
    console.error('Error in handleStatusCommand function:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: 'An error occurred while fetching system status.',
        embeds: [],
        components: []
      });
    } else {
      await interaction.reply({
        content: 'An error occurred while fetching system status.',
        ephemeral: true
      });
    }
  }
}

async function handleBlacklistCommand(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Command Not Available')
        .setDescription('This command cannot be used in DMs.');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Admin Required')
        .setDescription('You need to be an admin to use this command.');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const userId = interaction.options.getUser('user').id;
    const guildId = interaction.guild.id;

    initializeBlacklistForGuild(guildId);

    if (!state.blacklistedUsers[guildId].includes(userId)) {
      state.blacklistedUsers[guildId].push(userId);
      const blacklistedEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('User Blacklisted')
        .setDescription(`<@${userId}> has been blacklisted.`);
      await interaction.reply({
        embeds: [blacklistedEmbed]
      });
    } else {
      const alreadyBlacklistedEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('User Already Blacklisted')
        .setDescription(`<@${userId}> is already blacklisted.`);
      await interaction.reply({
        embeds: [alreadyBlacklistedEmbed]
      });
    }
  } catch (error) {
    console.log(error.message);
  }
}

async function handleWhitelistCommand(interaction) {
  try {
    if (interaction.channel.type === ChannelType.DM) {
      const dmEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Command Not Available')
        .setDescription('This command cannot be used in DMs.');
      return interaction.reply({
        embeds: [dmEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      const adminEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Admin Required')
        .setDescription('You need to be an admin to use this command.');
      return interaction.reply({
        embeds: [adminEmbed],
        flags: MessageFlags.Ephemeral
      });
    }

    const userId = interaction.options.getUser('user').id;
    const guildId = interaction.guild.id;

    initializeBlacklistForGuild(guildId);

    const index = state.blacklistedUsers[guildId].indexOf(userId);
    if (index > -1) {
      state.blacklistedUsers[guildId].splice(index, 1);
      const removedEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('User Whitelisted')
        .setDescription(`<@${userId}> has been removed from the blacklist.`);
      await interaction.reply({
        embeds: [removedEmbed]
      });
    } else {
      const notFoundEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('User Not Found')
        .setDescription(`<@${userId}> is not in the blacklist.`);
      await interaction.reply({
        embeds: [notFoundEmbed]
      });
    }
  } catch (error) {
    console.log(error.message);
  }
}

async function setCustomPersonality(interaction) {
  const customId = 'custom-personality-input';
  const title = 'Enter Custom Personality Instructions';

  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel("What should the bot's personality be like?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter the custom instructions here...")
    .setMinLength(10)
    .setMaxLength(4000);

  const modal = new ModalBuilder()
    .setCustomId('custom-personality-modal')
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function downloadMessage(interaction) {
  try {
    const message = interaction.message;
    let textContent = message.content;
    if (!textContent && message.embeds.length > 0) {
      textContent = message.embeds[0].description;
    }

    if (!textContent) {
      const emptyEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Empty Message')
        .setDescription('The message is empty..?');
      await interaction.reply({
        embeds: [emptyEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
    await fs.writeFile(filePath, textContent, 'utf8');

    const attachment = new AttachmentBuilder(filePath, {
      name: 'message_content.txt'
    });

    const initialEmbed = new EmbedBuilder()
      .setColor(0xFFFFFF)
      .setTitle('Message Content Downloaded')
      .setDescription(`Here is the content of the message.`);

    let response;
    if (interaction.channel.type === ChannelType.DM) {
      response = await interaction.reply({
        embeds: [initialEmbed],
        files: [attachment],
        withResponse: true
      });
    } else {
      try {
        response = await interaction.user.send({
          embeds: [initialEmbed],
          files: [attachment]
        });
        const dmSentEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('Content Sent')
          .setDescription('The message content has been sent to your DMs.');
        await interaction.reply({
          embeds: [dmSentEmbed],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error(`Failed to send DM: ${error}`);
        const failDMEmbed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('Delivery Failed')
          .setDescription('Failed to send the content to your DMs.');
        response = await interaction.reply({
          embeds: [failDMEmbed],
          files: [attachment],
          flags: MessageFlags.Ephemeral,
          withResponse: true
        });
      }
    }

    await fs.unlink(filePath);

    const msgUrl = await uploadText(textContent);
    const updatedEmbed = EmbedBuilder.from(response.embeds[0])
      .setDescription(`Here is the content of the message.\n${msgUrl}`);

    if (interaction.channel.type === ChannelType.DM) {
      await interaction.editReply({
        embeds: [updatedEmbed]
      });
    } else {
      await response.edit({
        embeds: [updatedEmbed]
      });
    }

  } catch (error) {
    console.log('Failed to process download: ', error);
  }
}

const uploadText = async (text) => {
  const siteUrl = 'https://bin.mudfish.net';
  try {
    const response = await retryWithBackoff(() => axios.post(`${siteUrl}/api/text`, {
      text: text,
      ttl: 10080
    }, {
      timeout: URL_FETCH_TIMEOUT_MS,
    }));

    const key = response.data.tid;
    return `\nURL: ${siteUrl}/t/${key}`;
  } catch (error) {
    console.log(error);
    return '\nURL Error :(';
  }
};

async function downloadConversation(interaction) {
  try {
    const userId = interaction.user.id;
    const conversationHistory = getHistory(userId);

    if (!conversationHistory || conversationHistory.length === 0) {
      const noHistoryEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('No History Found')
        .setDescription('No conversation history found.');
      await interaction.reply({
        embeds: [noHistoryEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    let conversationText = conversationHistory.map(entry => {
      const role = entry.role === 'user' ? '[User]' : '[Model]';
      const content = entry.parts.map(c => c.text).join('\n');
      return `${role}:\n${content}\n\n`;
    }).join('');

    const tempFileName = path.join(TEMP_DIR, `conversation_${interaction.id}.txt`);
    await fs.writeFile(tempFileName, conversationText, 'utf8');

    const file = new AttachmentBuilder(tempFileName, {
      name: 'conversation_history.txt'
    });

    try {
      if (interaction.channel.type === ChannelType.DM) {
        await interaction.reply({
          content: "> `Here's your conversation history:`",
          files: [file]
        });
      } else {
        await interaction.user.send({
          content: "> `Here's your conversation history:`",
          files: [file]
        });
        const dmSentEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('History Sent')
          .setDescription('Your conversation history has been sent to your DMs.');
        await interaction.reply({
          embeds: [dmSentEmbed],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const failDMEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Delivery Failed')
        .setDescription('Failed to send the conversation history to your DMs.');
      await interaction.reply({
        embeds: [failDMEmbed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName);
    }
  } catch (error) {
    console.log(`Failed to download conversation: ${error.message}`);
  }
}


async function removeCustomPersonality(interaction) {
  try {
    delete state.customInstructions[interaction.user.id];
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('Removed')
      .setDescription('Custom personality instructions removed!');

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleUserResponsePreference(interaction) {
  try {
    const userId = interaction.user.id;
    const currentPreference = getUserResponsePreference(userId);
    state.userResponsePreference[userId] = currentPreference === 'Normal' ? 'Embedded' : 'Normal';
    await handleSubButtonInteraction(interaction, true);
  } catch (error) {
    console.log(error.message);
  }
}

async function toggleServerWideChatHistory(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Server Command Only')
        .setDescription('This command can only be used in a server.');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].serverChatHistory = !state.serverSettings[serverId].serverChatHistory;
    const statusMessage = `Server-wide Chat History is now \`${state.serverSettings[serverId].serverChatHistory ? "enabled" : "disabled"}\``;

    let warningMessage = "";
    if (state.serverSettings[serverId].serverChatHistory && !state.serverSettings[serverId].customServerPersonality) {
      warningMessage = "\n\n⚠️ **Warning:** Enabling server-side chat history without enhancing server-wide personality management is not recommended. The bot may get confused between its personalities and conversations with different users.";
    }

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].serverChatHistory ? 0x00FF00 : 0xFF0000)
      .setTitle('Chat History Toggled')
      .setDescription(statusMessage + warningMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide chat history:', error.message);
  }
}

async function toggleServerPersonality(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Server Command Only')
        .setDescription('This command can only be used in a server.');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].customServerPersonality = !state.serverSettings[serverId].customServerPersonality;
    const statusMessage = `Server-wide Personality is now \`${state.serverSettings[serverId].customServerPersonality ? "enabled" : "disabled"}\``;

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].customServerPersonality ? 0x00FF00 : 0xFF0000)
      .setTitle('Server Personality Toggled')
      .setDescription(statusMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide personality:', error.message);
  }
}

async function toggleServerResponsePreference(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Server Command Only')
        .setDescription('This command can only be used in a server.');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].serverResponsePreference = !state.serverSettings[serverId].serverResponsePreference;
    const statusMessage = `Server-wide Response Following is now \`${state.serverSettings[serverId].serverResponsePreference ? "enabled" : "disabled"}\``;

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].serverResponsePreference ? 0x00FF00 : 0xFF0000)
      .setTitle('Server Response Preference Toggled')
      .setDescription(statusMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide response preference:', error.message);
  }
}

async function toggleSettingSaveButton(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Server Command Only')
        .setDescription('This command can only be used in a server.');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    state.serverSettings[serverId].settingsSaveButton = !state.serverSettings[serverId].settingsSaveButton;
    const statusMessage = `Server-wide "Settings and Save Button" is now \`${state.serverSettings[serverId].settingsSaveButton ? "enabled" : "disabled"}\``;

    const embed = new EmbedBuilder()
      .setColor(state.serverSettings[serverId].settingsSaveButton ? 0x00FF00 : 0xFF0000)
      .setTitle('Settings Save Button Toggled')
      .setDescription(statusMessage);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log('Error toggling server-wide settings save button:', error.message);
  }
}

async function serverPersonality(interaction) {
  const customId = 'custom-server-personality-input';
  const title = 'Enter Custom Personality Instructions';

  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel("What should the bot's personality be like?")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Enter the custom instructions here...")
    .setMinLength(10)
    .setMaxLength(4000);

  const modal = new ModalBuilder()
    .setCustomId('custom-server-personality-modal')
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(input));

  await interaction.showModal(modal);
}

async function clearServerChatHistory(interaction) {
  try {
    if (!interaction.guild) {
      const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Server Command Only')
        .setDescription('This command can only be used in a server.');
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const serverId = interaction.guild.id;
    initializeBlacklistForGuild(serverId);

    if (state.serverSettings[serverId].serverChatHistory) {
      state.chatHistories[serverId] = {};
      try {
        await deleteServerMemories(serverId);
      } catch (error) {
        console.warn('Failed to purge server memories from vector store:', error.message);
      }
      const clearedEmbed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Chat History Cleared')
        .setDescription('Server-wide chat history cleared!');
      await interaction.reply({
        embeds: [clearedEmbed],
        flags: MessageFlags.Ephemeral
      });
    } else {
      const disabledEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('Feature Disabled')
        .setDescription('Server-wide chat history is disabled for this server.');
      await interaction.reply({
        embeds: [disabledEmbed],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.log('Failed to clear server-wide chat history:', error.message);
  }
}

async function downloadServerConversation(interaction) {
  try {
    const guildId = interaction.guild.id;
    const conversationHistory = getHistory(guildId);

    if (!conversationHistory || conversationHistory.length === 0) {
      const noHistoryEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('No History Found')
        .setDescription('No server-wide conversation history found.');
      await interaction.reply({
        embeds: [noHistoryEmbed],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const conversationText = conversationHistory.map(entry => {
      const role = entry.role === 'user' ? '[User]' : '[Model]';
      const content = entry.parts.map(c => c.text).join('\n');
      return `${role}:\n${content}\n\n`;
    }).join('');

    const tempFileName = path.join(TEMP_DIR, `server_conversation_${interaction.id}.txt`);
    await fs.writeFile(tempFileName, conversationText, 'utf8');

    const file = new AttachmentBuilder(tempFileName, {
      name: 'server_conversation_history.txt'
    });

    try {
      if (interaction.channel.type === ChannelType.DM) {
        await interaction.reply({
          content: "> `Here's the server-wide conversation history:`",
          files: [file]
        });
      } else {
        await interaction.user.send({
          content: "> `Here's the server-wide conversation history:`",
          files: [file]
        });
        const dmSentEmbed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('History Sent')
          .setDescription('Server-wide conversation history has been sent to your DMs.');
        await interaction.reply({
          embeds: [dmSentEmbed],
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (error) {
      console.error(`Failed to send DM: ${error}`);
      const failDMEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Delivery Failed')
        .setDescription('Failed to send the server-wide conversation history to your DMs.');
      await interaction.reply({
        embeds: [failDMEmbed],
        files: [file],
        flags: MessageFlags.Ephemeral
      });
    } finally {
      await fs.unlink(tempFileName);
    }
  } catch (error) {
    console.log(`Failed to download server conversation: ${error.message}`);
  }
}


async function toggleServerPreference(interaction) {
  try {
    const guildId = interaction.guild.id;
    if (state.serverSettings[guildId].responseStyle === "Embedded") {
      state.serverSettings[guildId].responseStyle = "Normal";
    } else {
      state.serverSettings[guildId].responseStyle = "Embedded";
    }
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('Server Response Style Updated')
      .setDescription(`Server response style updated to: ${state.serverSettings[guildId].responseStyle}`);

    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    console.log(error.message);
  }
}

async function showSettings(interaction, edit = false) {
  try {
    if (interaction.guild) {
      initializeBlacklistForGuild(interaction.guild.id);
      if (state.blacklistedUsers[interaction.guild.id].includes(interaction.user.id)) {
        const embed = new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('Blacklisted')
          .setDescription('You are blacklisted and cannot use this interaction.');
        return interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    const mainButtons = [{
      customId: 'clear-memory',
      label: 'Clear Memory',
      emoji: '🧹',
      style: ButtonStyle.Danger
    },
    {
      customId: 'general-settings',
      label: 'General Settings',
      emoji: '⚙️',
      style: ButtonStyle.Secondary
    },
    ];

    const mainButtonsComponents = mainButtons.map(config =>
      new ButtonBuilder()
        .setCustomId(config.customId)
        .setLabel(config.label)
        .setEmoji(config.emoji)
        .setStyle(config.style)
    );

    const mainActionRow = new ActionRowBuilder().addComponents(...mainButtonsComponents);

    const embed = new EmbedBuilder()
      .setColor(0x00FFFF)
      .setTitle('Settings')
      .setDescription('Please choose a category from the buttons below:');
    if (edit) {
      await interaction.update({
        embeds: [embed],
        components: [mainActionRow],
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.reply({
        embeds: [embed],
        components: [mainActionRow],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error('Error showing settings:', error.message);
  }
}

async function handleSubButtonInteraction(interaction, update = false) {
  const channelId = interaction.channel.id;
  const userId = interaction.user.id;
  if (!state.activeUsersInChannels[channelId]) {
    state.activeUsersInChannels[channelId] = {};
  }
  const responseMode = getUserResponsePreference(userId);
  const subButtonConfigs = {
    'general-settings': [{
      customId: 'always-respond',
      label: `Always Respond: ${state.activeUsersInChannels[channelId][userId] ? 'ON' : 'OFF'}`,
      emoji: '↩️',
      style: ButtonStyle.Secondary
    },
    {
      customId: 'toggle-response-mode',
      label: `Toggle Response Mode: ${responseMode}`,
      emoji: '📝',
      style: ButtonStyle.Secondary
    },
    {
      customId: 'download-conversation',
      label: 'Download Conversation',
      emoji: '🗃️',
      style: ButtonStyle.Secondary
    },
    ...(shouldDisplayPersonalityButtons ? [{
      customId: 'custom-personality',
      label: 'Custom Personality',
      emoji: '🙌',
      style: ButtonStyle.Primary
    },
    {
      customId: 'remove-personality',
      label: 'Remove Personality',
      emoji: '🤖',
      style: ButtonStyle.Danger
    },
    ] : []),
    {
      customId: 'back_to_main_settings',
      label: 'Back',
      emoji: '🔙',
      style: ButtonStyle.Secondary
    },
    ],
  };

  if (update || subButtonConfigs[interaction.customId]) {
    const subButtons = subButtonConfigs[update ? 'general-settings' : interaction.customId].map(config =>
      new ButtonBuilder()
        .setCustomId(config.customId)
        .setLabel(config.label)
        .setEmoji(config.emoji)
        .setStyle(config.style)
    );

    const actionRows = [];
    while (subButtons.length > 0) {
      actionRows.push(new ActionRowBuilder().addComponents(subButtons.splice(0, 5)));
    }

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00FFFF)
          .setTitle(`${update ? 'General Settings' : interaction.customId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')}`)
          .setDescription('Please choose an option from the buttons below:'),
      ],
      components: actionRows,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function showDashboard(interaction) {
  if (interaction.channel.type === ChannelType.DM) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('Command Restricted')
      .setDescription('This command cannot be used in DMs.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const embed = new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('Administrator Required')
      .setDescription('You need to be an admin to use this command.');
    return interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }
  initializeBlacklistForGuild(interaction.guild.id);
  const buttonConfigs = [{
    customId: "server-chat-history",
    label: "Toggle Server-Wide Conversation History",
    emoji: "📦",
    style: ButtonStyle.Primary,
  },
  {
    customId: "clear-server",
    label: "Clear Server-Wide Memory",
    emoji: "🧹",
    style: ButtonStyle.Danger,
  },
  {
    customId: "settings-save-buttons",
    label: "Toggle Add Settings And Save Button",
    emoji: "🔘",
    style: ButtonStyle.Primary,
  },
  {
    customId: "toggle-server-personality",
    label: "Toggle Server Personality",
    emoji: "🤖",
    style: ButtonStyle.Primary,
  },
  {
    customId: "custom-server-personality",
    label: "Custom Server Personality",
    emoji: "🙌",
    style: ButtonStyle.Primary,
  },
  {
    customId: "toggle-response-server-mode",
    label: "Toggle Server-Wide Responses Style",
    emoji: "✏️",
    style: ButtonStyle.Primary,
  },
  {
    customId: "response-server-mode",
    label: "Server-Wide Responses Style",
    emoji: "📝",
    style: ButtonStyle.Secondary,
  },
  {
    customId: "download-server-conversation",
    label: "Download Server Conversation",
    emoji: "🗃️",
    style: ButtonStyle.Secondary,
  }
  ];

  const allButtons = buttonConfigs.map((config) =>
    new ButtonBuilder()
      .setCustomId(config.customId)
      .setLabel(config.label)
      .setEmoji(config.emoji)
      .setStyle(config.style)
  );

  const actionRows = [];
  while (allButtons.length > 0) {
    actionRows.push(
      new ActionRowBuilder().addComponents(allButtons.splice(0, 5))
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle('Settings')
    .setDescription('Your Server Settings:');
  await interaction.reply({
    embeds: [embed],
    components: actionRows,
    flags: MessageFlags.Ephemeral
  });
}

// <==========>



// <=====[Others]=====>

async function addDownloadButton(botMessage) {
  try {
    const messageComponents = botMessage.components || [];
    const downloadButton = new ButtonBuilder()
      .setCustomId('download_message')
      .setLabel('Save')
      .setEmoji('⬇️')
      .setStyle(ButtonStyle.Secondary);

    let actionRow;
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
    }

    actionRow.addComponents(downloadButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.error('Error adding download button:', error.message);
    return botMessage;
  }
}

async function addDeleteButton(botMessage, msgId) {
  try {
    const messageComponents = botMessage.components || [];
    const downloadButton = new ButtonBuilder()
      .setCustomId(`delete_message-${msgId}`)
      .setLabel('Delete')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Secondary);

    let actionRow;
    if (messageComponents.length > 0 && messageComponents[0].type === ComponentType.ActionRow) {
      actionRow = ActionRowBuilder.from(messageComponents[0]);
    } else {
      actionRow = new ActionRowBuilder();
    }

    actionRow.addComponents(downloadButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.error('Error adding delete button:', error.message);
    return botMessage;
  }
}

async function addSettingsButton(botMessage) {
  try {
    const settingsButton = new ButtonBuilder()
      .setCustomId('settings')
      .setEmoji('⚙️')
      .setStyle(ButtonStyle.Secondary);

    const actionRow = new ActionRowBuilder().addComponents(settingsButton);
    return await botMessage.edit({
      components: [actionRow]
    });
  } catch (error) {
    console.log('Error adding settings button:', error.message);
    return botMessage;
  }
}

// <==========>



// <=====[Model Response Handling]=====>

async function handleModelResponse(initialBotMessage, chat, parts, originalMessage, typingInterval, historyId, mentionedUser, initialUrlContextMetadata = null) {
  const userId = originalMessage.author.id;
  const userResponsePreference = originalMessage.guild && state.serverSettings[originalMessage.guild.id]?.serverResponsePreference ? state.serverSettings[originalMessage.guild.id].responseStyle : getUserResponsePreference(userId);
  const maxCharacterLimit = userResponsePreference === 'Embedded' ? 3900 : 1900;
  let attempts = 3;
  const startedAt = Date.now();
  const tagsForMemory = [];
  if (mentionedUser) {
    tagsForMemory.push(`mention:${mentionedUser.id}`);
  }
  if (retrievedMemoryCount > 0) {
    tagsForMemory.push('memory:retrieved');
  }
  referencedMembers.forEach((entry) => {
    tagsForMemory.push(`entity:${entry.id}`);
  });

  let updateTimeout;
  let tempResponse = '';
  // Metadata from Google Search and manual URL context enrichment
  let groundingMetadata = null;
  let urlContextMetadata = initialUrlContextMetadata;

  const stopGeneratingButton = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('stopGenerating')
        .setLabel('Stop Generating')
        .setStyle(ButtonStyle.Danger)
    );
  let botMessage;
  if (!initialBotMessage) {
    clearInterval(typingInterval);
    try {
      botMessage = await originalMessage.reply({
        content: 'Let me think..',
        components: [stopGeneratingButton]
      });
    } catch (error) { }
  } else {
    botMessage = initialBotMessage;
    try {
      botMessage.edit({
        components: [stopGeneratingButton]
      });
    } catch (error) { }
  }

  let stopGeneration = false;
  const filter = (interaction) => interaction.customId === 'stopGenerating';
  try {
    const collector = await botMessage.createMessageComponentCollector({
      filter,
      time: 120000
    });
    collector.on('collect', (interaction) => {
      if (interaction.user.id === originalMessage.author.id) {
        try {
          const embed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('Response Stopped')
            .setDescription('Response generation stopped by the user.');

          interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
          });
        } catch (error) {
          console.error('Error sending reply:', error);
        }
        stopGeneration = true;
      } else {
        try {
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('Access Denied')
            .setDescription("It's not for you.");

          interaction.reply({
            embeds: [embed],
            flags: MessageFlags.Ephemeral
          });
        } catch (error) {
          console.error('Error sending unauthorized reply:', error);
        }
      }
    });
  } catch (error) {
    console.error('Error creating or handling collector:', error);
  }

  const updateMessage = () => {
    if (stopGeneration) {
      return;
    }
    if (tempResponse.trim() === "") {
      botMessage.edit({
        content: '...'
      });
    } else if (userResponsePreference === 'Embedded') {
      updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata);
    } else {
      // Add a safety check to prevent crashing on long streaming updates
      if (tempResponse.length < 1950) {
        botMessage.edit({
          content: tempResponse,
          embeds: []
        });
      }
    }
    clearTimeout(updateTimeout);
    updateTimeout = null;
  };

  while (attempts > 0 && !stopGeneration) {
    try {
      let finalResponse = '';
      let isLargeResponse = false;
      const newHistory = [];


      // --- NEW LOGIC TO CREATE PLACEHOLDER FOR SAVED HISTORY ---

      // Create a clean version of the user's prompt for saving.
      const userPartsForHistory = sanitizeContextForHistory(parts, mentionedUser ? mentionedUser.username : null);

      newHistory.push({
        role: 'user',
        content: userPartsForHistory
      });

      // --- END OF NEW LOGIC ---


      async function getResponse(parts) {
        let newResponse = '';
        const messageResult = await chat.sendMessageStream({
          message: parts
        });
        for await (const chunk of messageResult) {
          if (stopGeneration) break;

          const chunkText = (chunk.text || (chunk.codeExecutionResult?.output ? `\n\`\`\`py\n${chunk.codeExecutionResult.output}\n\`\`\`\n` : "") || (chunk.executableCode ? `\n\`\`\`\n${chunk.executableCode}\n\`\`\`\n` : ""));
          if (chunkText && chunkText !== '') {
            finalResponse += chunkText;
            tempResponse += chunkText;
            newResponse += chunkText;
          }

          // Capture grounding metadata from Google Search with URL Context tool
          if (chunk.candidates && chunk.candidates[0]?.groundingMetadata) {
            groundingMetadata = chunk.candidates[0].groundingMetadata;
          }

          // Capture URL context metadata from Google Search with URL Context tool
          if (chunk.candidates && chunk.candidates[0]?.url_context_metadata) {
            urlContextMetadata = chunk.candidates[0].url_context_metadata;
          }

          if (finalResponse.length > maxCharacterLimit) {
            if (!isLargeResponse) {
              isLargeResponse = true;
              const embed = new EmbedBuilder()
                .setColor(0xFFFF00)
                .setTitle('Response Overflow')
                .setDescription('The response got too large, will be sent as a text file once it is completed.');

              botMessage.edit({
                embeds: [embed]
              });
            }
          } else if (!updateTimeout) {
            updateTimeout = setTimeout(updateMessage, 500);
          }
        }
        newHistory.push({
          role: 'assistant',
          content: [{
            text: newResponse
          }]
        });
      }
      await getResponse(parts);

      // Final update to ensure grounding and URL context metadata is displayed in embedded responses
      if (!isLargeResponse && userResponsePreference === 'Embedded') {
        updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata);
      }

      botMessage = await addSettingsButton(botMessage);
      if (isLargeResponse) {
        sendAsTextFile(finalResponse, originalMessage, botMessage.id);
        botMessage = await addDeleteButton(botMessage, botMessage.id);
      } else {
        const shouldAddDownloadButton = originalMessage.guild ? state.serverSettings[originalMessage.guild.id]?.settingsSaveButton : true;
        if (shouldAddDownloadButton) {
          botMessage = await addDownloadButton(botMessage);
          botMessage = await addDeleteButton(botMessage, botMessage.id);
        } else {
          botMessage.edit({
            components: []
          });
        }
      }

      await chatHistoryLock.runExclusive(async () => {
        updateChatHistory(historyId, newHistory, botMessage.id);
        await saveStateToFile();
      });
      const latencyMs = Date.now() - startedAt;
      try {
        await storeMessageTurn({
          historyId,
          guildId: originalMessage.guild ? originalMessage.guild.id : null,
          channelId: originalMessage.channel ? originalMessage.channel.id : null,
          userId: originalMessage.author.id,
          username: originalMessage.author.username,
          displayName: originalMessage.member ? originalMessage.member.displayName : originalMessage.author.displayName,
          globalName: originalMessage.author.globalName || null,
          roles: originalMessage.member ? Array.from(originalMessage.member.roles.cache.keys()) : [],
          userMessageId: originalMessage.id,
          assistantMessageId: botMessage?.id,
          userContent: originalUserPrompt,
          assistantContent: finalResponse,
          persona: personaDescriptor,
          latencyMs,
          consent: originalMessage.guild ? 'shareable' : 'private',
          tags: tagsForMemory,
        });
      } catch (memoryError) {
        console.warn('Failed to persist turn to memory:', memoryError.message);
      }
      queueInsightAnalysis({
        userMessage: {
          author: {
            id: originalMessage.author.id,
            username: originalMessage.author.username,
            displayName: originalMessage.member ? originalMessage.member.displayName : originalMessage.author.displayName,
            globalName: originalMessage.author.globalName || null,
          },
          text: originalUserPrompt,
          referenced_entities: referencedMembers.map((entry) => ({
            id: entry.id,
            username: entry.username,
            displayName: entry.displayName,
            globalName: entry.globalName,
          })),
        },
        assistantMessage: {
          text: finalResponse,
        },
        metadata: {
          guildId: originalMessage.guild ? originalMessage.guild.id : null,
          channelId: originalMessage.channel ? originalMessage.channel.id : null,
          messageId: originalMessage.id,
          timestamp: new Date().toISOString(),
        },
      });
      break;
    } catch (error) {
      if (activeRequests.has(userId)) {
        activeRequests.delete(userId);
      }
      console.error('Generation Attempt Failed: ', error);
      attempts--;

      if (attempts === 0 || stopGeneration) {
        if (!stopGeneration) {
          if (SEND_RETRY_ERRORS_TO_DISCORD) {
            const embed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('Generation Failure')
              .setDescription(`All Generation Attempts Failed :(\n\`\`\`${error.message}\`\`\``);
            const errorMsg = await originalMessage.channel.send({
              content: `<@${originalMessage.author.id}>`,
              embeds: [embed]
            });
            await addSettingsButton(errorMsg);
            await addSettingsButton(botMessage);
          } else {
            const simpleErrorEmbed = new EmbedBuilder()
              .setColor(0xFF0000)
              .setTitle('Bot Overloaded')
              .setDescription('Something seems off, the bot might be overloaded! :(');
            const errorMsg = await originalMessage.channel.send({
              content: `<@${originalMessage.author.id}>`,
              embeds: [simpleErrorEmbed]
            });
            await addSettingsButton(errorMsg);
            await addSettingsButton(botMessage);
          }
        }
        break;
      } else if (SEND_RETRY_ERRORS_TO_DISCORD) {
        const errorMsg = await originalMessage.channel.send({
          content: `<@${originalMessage.author.id}>`,
          embeds: [new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle('Retry in Progress')
            .setDescription(`Generation Attempt(s) Failed, Retrying..\n\`\`\`${error.message}\`\`\``)
          ]
        });
        setTimeout(() => errorMsg.delete().catch(console.error), 5000);
        await delay(500);
      }
    }
  }
  if (activeRequests.has(userId)) {
    activeRequests.delete(userId);
  }
}

function updateEmbed(botMessage, finalResponse, message, groundingMetadata = null, urlContextMetadata = null) {
  try {
    const isGuild = message.guild !== null;
    const embed = new EmbedBuilder()
      .setColor(hexColour)
      .setDescription(finalResponse)
      .setAuthor({
        name: `To ${message.author.displayName}`,
        iconURL: message.author.displayAvatarURL()
      })
      .setTimestamp();

    // Add grounding metadata if user has Google Search tool enabled and Embedded responses selected
    if (groundingMetadata && shouldShowGroundingMetadata(message)) {
      addGroundingMetadataToEmbed(embed, groundingMetadata);
    }

    // Add URL context metadata if user has Google Search tool enabled and Embedded responses selected
    if (urlContextMetadata && shouldShowGroundingMetadata(message)) {
      addUrlContextMetadataToEmbed(embed, urlContextMetadata);
    }

    if (isGuild) {
      embed.setFooter({
        text: message.guild.name,
        iconURL: message.guild.iconURL() || 'https://ai.google.dev/static/site-assets/images/share.png'
      });
    }

    botMessage.edit({
      content: ' ',
      embeds: [embed]
    });
  } catch (error) {
    console.error("An error occurred while updating the embed:", error.message);
  }
}

function addGroundingMetadataToEmbed(embed, groundingMetadata) {
  // Add search queries used by the model
  if (groundingMetadata.webSearchQueries && groundingMetadata.webSearchQueries.length > 0) {
    embed.addFields({
      name: '🔍 Search Queries',
      value: groundingMetadata.webSearchQueries.map(query => `• ${query}`).join('\n'),
      inline: false
    });
  }

  // Add grounding sources with clickable links
  if (groundingMetadata.groundingChunks && groundingMetadata.groundingChunks.length > 0) {
    const chunks = groundingMetadata.groundingChunks
      .slice(0, 5) // Limit to first 5 chunks to avoid embed limits
      .map((chunk, index) => {
        if (chunk.web) {
          return `• [${chunk.web.title || 'Source'}](${chunk.web.uri})`;
        }
        return `• Source ${index + 1}`;
      })
      .join('\n');

    embed.addFields({
      name: '📚 Sources',
      value: chunks,
      inline: false
    });
  }
}

function addUrlContextMetadataToEmbed(embed, urlContextMetadata) {
  // Add URL retrieval status with success/failure indicators
  if (urlContextMetadata.url_metadata && urlContextMetadata.url_metadata.length > 0) {
    const urlList = urlContextMetadata.url_metadata
      .map(urlData => {
        const emoji = urlData.url_retrieval_status === 'URL_RETRIEVAL_STATUS_SUCCESS' ? '✔️' : '❌';
        return `${emoji} ${urlData.retrieved_url}`;
      })
      .join('\n');

    embed.addFields({
      name: '🔗 URL Context',
      value: urlList,
      inline: false
    });
  }
}

function shouldShowGroundingMetadata(message) {
  // Tools are always enabled; only show when user prefers Embedded responses
  const userId = message.author.id;
  const userResponsePreference = message.guild && state.serverSettings[message.guild.id]?.serverResponsePreference
    ? state.serverSettings[message.guild.id].responseStyle
    : getUserResponsePreference(userId);

  return userResponsePreference === 'Embedded';
}

async function sendAsTextFile(text, message, orgId) {
  try {
    const filename = `response-${Date.now()}.txt`;
    const tempFilePath = path.join(TEMP_DIR, filename);
    await fs.writeFile(tempFilePath, text);

    const botMessage = await message.channel.send({
      content: `<@${message.author.id}>, Here is the response:`,
      files: [tempFilePath]
    });
    await addSettingsButton(botMessage);
    await addDeleteButton(botMessage, orgId);

    await fs.unlink(tempFilePath);
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

// <==========>

export { handleModelResponse };

if (process.env.NODE_ENV !== 'test') {
  client.login(token);
}