import { pluginRegistry } from '../registry';
import { createPluginAPI } from '../api';
import { registerHealthClassifier } from './healthClassifier';
import { registerHelmSection } from './helmSection';
import { registerPodActions } from './podActions';
import { registerBuiltinThemes } from './themes';

const BUILTIN_PLUGIN_ID = '@truss/builtin';

let registered = false;

// Register all built-in plugins. Called once at app startup via PluginProvider.
// Guard against double registration (strict-mode double-effect in dev).
export function registerBuiltins(): void {
  if (registered) return;
  registered = true;

  const registrar = pluginRegistry.createRegistrar(BUILTIN_PLUGIN_ID);
  // api is passed for consistency with the plugin interface, not used by builtins
  // since they import directly from the app's modules.
  const _api = createPluginAPI(BUILTIN_PLUGIN_ID);

  registerBuiltinThemes(registrar);
  registerHealthClassifier(registrar);
  registerHelmSection(registrar);
  registerPodActions(registrar);
}
