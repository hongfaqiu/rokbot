import { join } from 'node:path';
import { JsonStore } from './storage.mjs';
import { check } from './security.mjs';

export const defaultHarnessSettings = Object.freeze({ dreaming: false, browserUse: true, userForm: true,
  browserLoginImport: true, passkeys: true, macComputer: true, teachTask: true,
  // true (default): an answered choice card also posts the answer as a user bubble (upstream behaviour).
  // false: the card alone shows the pick; the bot still receives the full answer text.
  showWidgetAnswerBubble: true });
// Read paths drop these keys when a stored value is not a boolean, so they fall back to the default
// instead of failing the whole settings file. Writes stay strict (400 on a bad value).
const lenientOnRead = ['showWidgetAnswerBubble'];
export function validateHarnessSettings(input) {
  const next = {};
  for (const [key, fallback] of Object.entries(defaultHarnessSettings)) {
    check(input[key] === undefined || typeof input[key] === 'boolean', 400, `Invalid ${key}`);
    next[key] = input[key] ?? fallback;
  }
  return next;
}
/** Stored settings as the Host applies them: like validateHarnessSettings, but lenient for lenientOnRead. */
export function readHarnessSettings(input) {
  const raw = input && typeof input === 'object' ? { ...input } : {};
  for (const key of lenientOnRead) if (typeof raw[key] !== 'boolean') delete raw[key];
  return validateHarnessSettings(raw);
}
export class HarnessSettings {
  constructor(directory) { this.store = new JsonStore(join(directory, 'harness-settings.json'),
    { version: 1, settings: { ...defaultHarnessSettings } }); }
  async load() { await this.store.load(); return this; }
  current() { return readHarnessSettings(this.store.value.settings); }
  async save(input) {
    const settings = validateHarnessSettings(input);
    await this.store.mutate(state => { state.settings = settings; });
    return this.current();
  }
}
