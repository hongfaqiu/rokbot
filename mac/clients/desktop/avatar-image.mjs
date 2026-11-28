import { rokText } from './i18n.mjs';

// Bot avatar editor > Generate (desktop and Web). The official renderer calls
// desktop.generateAgentAvatarImage({ description }) and loads the result as an image: the official
// main process returns a data: URL string and the renderer shows a thrown error's message. The
// prompt is built by the official main process, which RokBot replaces, so the bare subject goes to
// the Host and the Host wraps it. Shared with the Web client (web/patchers sharedAssets): no Node APIs.
export const AVATAR_IMAGE_ENDPOINT = '/local/avatar/generate';
// The Host gives up at 180 s and answers with its own timeout message.
const TIMEOUT_MS = 200_000;

export function createAvatarImageGenerator({ request }) {
  return async ({ description } = {}) => {
    const subject = typeof description === 'string' ? description.trim() : '';
    if (!subject) throw new Error(rokText('请填写头像描述。', 'Describe the avatar first.'));
    const reply = await request(AVATAR_IMAGE_ENDPOINT, { subject, aspectRatio: '1:1' },
      AbortSignal.timeout(TIMEOUT_MS), 'POST', { Accept: 'application/json' });
    const image = reply?.success;
    if (typeof image?.imageData === 'string' && image.imageData && /^image\/[a-z0-9.+-]+$/i.test(image.mimeType ?? ''))
      return `data:${image.mimeType};base64,${image.imageData}`;
    const reason = typeof reply?.error?.error === 'string' ? reply.error.error.trim() : '';
    throw new Error(reason || rokText('Host 没有返回头像图片。', 'The Host returned no avatar image.'));
  };
}
