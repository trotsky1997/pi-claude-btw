import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { convertToLlm, serializeConversation, type SessionEntry } from "@mariozechner/pi-coding-agent";

export type SerializedBranchContext = {
  transcript: string;
  messageCount: number;
  droppedTrailingAssistant: boolean;
};

function isTextfulMessage(message: AgentMessage): boolean {
  return Array.isArray(message.content) && message.content.length > 0;
}

function shouldDropTrailingAssistant(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  const stopReason = "stopReason" in message ? message.stopReason : undefined;
  return stopReason === undefined || stopReason === null || stopReason === "aborted" || stopReason === "error";
}

function extractBranchMessages(entries: SessionEntry[]): AgentMessage[] {
  return entries
    .filter((entry): entry is SessionEntry & { type: "message"; message: AgentMessage } => entry.type === "message")
    .map((entry) => entry.message)
    .filter(isTextfulMessage);
}

export function serializeBranchContext(entries: SessionEntry[]): SerializedBranchContext {
  const messages = extractBranchMessages(entries);
  let droppedTrailingAssistant = false;

  while (messages.length > 0 && shouldDropTrailingAssistant(messages[messages.length - 1]!)) {
    messages.pop();
    droppedTrailingAssistant = true;
  }

  const llmMessages = convertToLlm(messages);
  const transcript = serializeConversation(llmMessages);

  return {
    transcript,
    messageCount: messages.length,
    droppedTrailingAssistant,
  };
}
