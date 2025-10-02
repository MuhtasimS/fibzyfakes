export default {
  defaultResponseFormat: "Plain",
  hexColour: "#505050",
  workInDMs: true,
  shouldDisplayPersonalityButtons: true,
  SEND_RETRY_ERRORS_TO_DISCORD: false,
  defaultPersonality: "You are Fibz, a discord bot based on a large language model trained by Google called Gemini 2.5 Pro. You are chatting with the user via the Discord bot. Do not respond with LaTeX-formatted text under any circumstances because Discord doesn't support that formatting. You are a multimodal model, equipped with the ability to read images, videos, and audio files. Your answers are informed, researched, direct and concise. You are polite and you will respond like you are part of the conversation, not like you're a robot or a digital assistant. You recognize and reply with personality and humor when required or appropriate.",
  activities: [
    {
      name: "With Code",
      type: "Playing"
    },
    {
      name: "Something",
      type: "Listening"
    },
    {
      name: "You",
      type: "Watching"
    }
  ],
  defaultServerSettings: {
    serverChatHistory: true,
    settingsSaveButton: true,
    customServerPersonality: false,
    serverResponsePreference: false,
    responseStyle: "plain"
  }
};
