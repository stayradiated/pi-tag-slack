import { statSync } from 'node:fs';
import { WebClient } from '@slack/web-api';
import { config } from '../config.js';
import { uploadFilesExternal } from './files.js';
import { splitMessage, SLACK_MAX_MESSAGE_LENGTH } from './text.js';

export interface SendRequest {
  channelJid: string;
  text?: string;
  threadTs?: string;
  files: string[];
}

export function normalizeChannelJid(input: string): string {
  const value = input.trim();
  return value.startsWith('sl:') ? value : `sl:${value}`;
}

export function validateSendRequest(
  request: SendRequest,
  options: { maxAttachmentBytes: number; fileStat: (path: string) => { size: number } },
): void {
  const hasText = Boolean(request.text?.trim());

  if (!hasText && request.files.length === 0) {
    throw new Error('Either text or at least one file is required.');
  }

  if (request.files.length > 10) {
    throw new Error('At most 10 files can be sent in a single message.');
  }

  for (const filePath of request.files) {
    let file;

    try {
      file = options.fileStat(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (options.maxAttachmentBytes > 0 && file.size > options.maxAttachmentBytes) {
      throw new Error(
        `File exceeds max attachment size (${options.maxAttachmentBytes} bytes): ${filePath}`,
      );
    }
  }
}

export async function sendFilesToSlack(request: SendRequest): Promise<{ sentFiles: number }> {
  validateSendRequest(request, {
    maxAttachmentBytes: config.maxAttachmentBytes,
    fileStat: (filePath) => statSync(filePath),
  });

  const channelJid = normalizeChannelJid(request.channelJid);
  const channelId = channelJid.slice(3);
  const text = request.text?.trim();

  // Pure Web API: no Socket Mode connection is needed to post outbound.
  const client = new WebClient(config.slackBotToken);

  if (request.files.length === 0) {
    // Text-only; validateSendRequest guarantees text is present here.
    // Split like the gateway does — markdown_text rejects long payloads.
    for (const chunk of splitMessage(text ?? '', SLACK_MAX_MESSAGE_LENGTH)) {
      await client.chat.postMessage({
        channel: channelId,
        markdown_text: chunk,
        thread_ts: request.threadTs,
      });
    }
    return { sentFiles: 0 };
  }

  // A too-long comment would fail the whole upload: post the text as its own
  // (split) message first, then attach the files without a comment.
  let initialComment = text || undefined;
  if (initialComment && initialComment.length > SLACK_MAX_MESSAGE_LENGTH) {
    for (const chunk of splitMessage(initialComment, SLACK_MAX_MESSAGE_LENGTH)) {
      await client.chat.postMessage({
        channel: channelId,
        markdown_text: chunk,
        thread_ts: request.threadTs,
      });
    }
    initialComment = undefined;
  }

  return uploadFilesExternal(
    client,
    request.files.map((filePath) => ({ filePath })),
    { channelId, threadTs: request.threadTs, initialComment },
  );
}
