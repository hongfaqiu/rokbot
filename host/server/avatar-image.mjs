import { check, jsonBody } from './security.mjs';

// Bot avatar page, Generate tab. The mobile client asks /aiserver.v1.AiService/RunGenerateImage
// through the same RPC transport as TextToSpeech; the native interceptors map it to
// /local/avatar/generate. Shapes, from the official Android 1.26.0 / 1.27.0 Hermes bundles
// (AvatarGeneration.request / reply / failure):
//   request  { description, modelId, maxMode, aspectRatio }  (description is already the full
//            avatar prompt: context + "Subject: <text>" + guidance, built on the device)
//   success  { success: { imageData: base64, mimeType } }
//   failure  { error: { error, modelRestricted?, providerStatusCode?, contentSafetyBlocked? } }
// A failure with neither providerStatusCode nor contentSafetyBlocked is shown with its `error`
// text verbatim; any non-2xx reply becomes the generic "Unable to generate avatar. Please retry."
// So generation failures are answered as HTTP 200 + a specific `error` message.

export const AVATAR_IMAGE_RPC_PATH = '/aiserver.v1.AiService/RunGenerateImage';
export const AVATAR_IMAGE_LOCAL_PATH = '/local/avatar/generate';
export const AVATAR_IMAGE_TIMEOUT_MS = 180_000;
const MAX_PROMPT = 30_000;

/**
 * Prompt for clients that send only what the user typed (`subject`): the desktop and Web clients,
 * whose official main process would build the prompt. Written for RokBot, not the official text.
 */
export function avatarPrompt(subject) {
  return 'Square profile picture for a chat assistant. It is shown small and cropped to a circle, so keep the '
    + 'subject large and centered on a plain background that contrasts with it, with no border, frame, text, '
    + 'letters, logos or watermark. Unless the description asks for a particular style, use a clean stylized '
    + `illustration rather than a photo.\n\nSubject: ${subject.trim()}`;
}

const messages = {
  zh: {
    invalid: () => '请填写头像描述。',
    'not-configured': () => '未配置图像生成服务：请在 Host 管理页的「媒体服务」中设置默认图像模型。',
    timeout: seconds => `生成头像超时（${seconds} 秒），请稍后重试。`,
    busy: () => '图像生成服务正忙，请稍后重试。',
    provider: detail => `图像生成服务出错：${detail}`,
  },
  en: {
    invalid: () => 'Describe the avatar first.',
    'not-configured': () => 'Image generation is not configured. Set a default image model under Media services in the Host admin.',
    timeout: seconds => `Avatar generation timed out after ${seconds} seconds. Try again later.`,
    busy: () => 'The image service is busy. Try again in a moment.',
    provider: detail => `The image service failed: ${detail}`,
  },
};

/** Chinese unless the client names another language first (the Host's own default). */
const language = header => {
  const first = String(header ?? '').split(',')[0].split(';')[0].trim().toLowerCase();
  return !first || first === '*' || first.startsWith('zh') ? 'zh' : 'en';
};

// Host-generated HttpError text only (provider bodies are never echoed by media-providers); the
// internal job id is noise on a phone.
const detail = error => String(error?.message || 'Media request failed').replace(/\s*\(job [^)]*\)\s*$/, '').slice(0, 300);

export class AvatarImage {
  constructor({ media, timeoutMs = AVATAR_IMAGE_TIMEOUT_MS, log = console } = {}) {
    this.media = media;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  /** -> { reply, failure? }; `reply` is the RunGenerateImageResponse JSON. Never throws. */
  async generate(input, { language: accept, signal } = {}) {
    const text = messages[language(accept)];
    const fail = (failure, message) => ({ failure, reply: { error: { error: message } } });
    // `description`: the official RunGenerateImage field, already the full prompt (mobile clients).
    // `subject`: the bare description (desktop / Web), wrapped here.
    const prompt = typeof input?.description === 'string' ? input.description.trim()
      : typeof input?.subject === 'string' && input.subject.trim() ? avatarPrompt(input.subject) : '';
    if (!prompt || prompt.length > MAX_PROMPT) return fail('invalid', text.invalid());
    if (!(await this.media.available('image').catch(() => false))) return fail('not-configured', text['not-configured']());
    const aspectRatio = typeof input.aspectRatio === 'string' && /^\d{1,2}:\d{1,2}$/.test(input.aspectRatio) ? input.aspectRatio : '';
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    const run = withRatio => this.media.generate('image', { prompt, ...(withRatio ? { aspectRatio } : {}) }, { signal: combined });
    try {
      let result;
      try {
        result = await run(Boolean(aspectRatio));
      } catch (error) {
        // Rejected by the local schema check before anything is submitted, so retrying is free.
        if (!aspectRatio || error?.status !== 400 || !/aspect_ratio/.test(error.message)) throw error;
        result = await run(false);
      }
      const output = result?.outputs?.[0];
      if (!output?.bytes?.length || !/^image\//.test(output.mimeType ?? '')) return fail('provider', text.provider('no image returned'));
      return { reply: { success: { imageData: Buffer.from(output.bytes).toString('base64'), mimeType: output.mimeType } } };
    } catch (error) {
      if (timeout.aborted) return fail('timeout', text.timeout(Math.round(this.timeoutMs / 1000)));
      if (combined.aborted) return fail('cancelled', text.provider('cancelled'));
      if (error?.status === 429) return fail('busy', text.busy());
      if (error?.status === 503 && /No enabled image model/.test(error.message)) return fail('not-configured', text['not-configured']());
      return fail('provider', text.provider(detail(error)));
    }
  }

  /** POST RunGenerateImage JSON; always replies in the RPC JSON shape (HTTP 200 for generation failures). */
  async route(request, response) {
    check(request.method === 'POST', 405, 'Method not allowed');
    const body = await jsonBody(request, 128 * 1024);
    const abort = new AbortController();
    response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    const started = Date.now();
    const { reply, failure } = await this.generate(body, { language: request.headers['accept-language'], signal: abort.signal });
    // Requests used to fall through to a silent 404; leave a trace without the prompt.
    if (failure) this.log.warn?.(`[avatar] generation failed (${failure}) after ${Date.now() - started} ms`);
    else this.log.info?.(`[avatar] generated in ${Date.now() - started} ms`);
    if (response.destroyed) return;
    const payload = Buffer.from(JSON.stringify(reply));
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length,
      'cache-control': 'no-store', ...(failure ? { 'x-rokbot-avatar-failure': failure } : {}) });
    return response.end(payload);
  }
}
