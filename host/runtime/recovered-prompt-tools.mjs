import { constructRecoveredModules } from './recovered-modules.mjs';
import { fileTransferPromptToolOverrides, wrapFileTransferPromptTools } from './file-transfer.mjs';
import { LOCAL_MODEL_IDENTITY_PROMPT_LINE } from './model-identity.mjs';

/** Recovered exports replaced before any dependent Prompt/tools module captures them. */
export const promptToolsOverrides = Object.freeze({
  SAND_MODEL_IDENTITY_PROMPT_LINE: () => LOCAL_MODEL_IDENTITY_PROMPT_LINE,
});

export async function installRecoveredPromptTools(library, directory) {
  const constructed = await constructRecoveredModules(
    library.promptToolsRecoveryPlan,
    wrapFileTransferPromptTools(library.getPromptToolsRecoveryBindings()),
    directory,
    'Prompt/tools',
    { overrides: { ...fileTransferPromptToolOverrides(), ...promptToolsOverrides } },
  );
  const bindings = library.installRecoveredPromptTools(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, after Computer/Box and before Harness construction',
    bindings, sharedBindings: library.promptToolsRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
