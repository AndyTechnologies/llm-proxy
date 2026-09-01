/**
 * Content extraction helper.
 *
 * Ported from utils/micro.js `extractContent`. Extracts the "primary" textual
 * result from a completion response whether it arrives in the chat
 * (choices[0].message.content) or legacy (choices[0].text) shape.
 */
/**
 * Extract the primary text content from a completion response.
 */
export function extractContent(
  response: Record<string, unknown> | null | undefined,
): string {
  const choices = response?.choices as
    | Array<Record<string, unknown>>
    | undefined;

  const messageContent =
    choices?.[0]?.message &&
    typeof choices[0].message === "object"
      ? ((choices[0].message as Record<string, unknown>).content as
          | string
          | string[]
          | null
          | undefined)
      : undefined;

  if (typeof messageContent === "string") {
    return messageContent;
  }
  if (Array.isArray(messageContent)) {
    return messageContent.join("\n");
  }

  const text = choices?.[0]?.text;
  if (typeof text === "string") {
    return text;
  }

  return "";
}
