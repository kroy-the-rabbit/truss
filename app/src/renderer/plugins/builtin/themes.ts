import type { PluginRegistrar } from '../types';

// Catppuccin Mocha — the default dark palette.
const DARK_CSS = `
:root {
  --bg-primary: #1e1e2e;
  --bg-secondary: #181825;
  --bg-surface: #313244;
  --bg-hover: #45475a;
  --bg-selected: #585b70;
  --text-primary: #cdd6f4;
  --text-secondary: #a6adc8;
  --text-dim: #6c7086;
  --text-muted: #6c7086;
  --accent: #89b4fa;
  --accent-hover: #74c7ec;
  --color-success: #a6e3a1;
  --success: #a6e3a1;
  --color-error: #f38ba8;
  --error: #f38ba8;
  --color-blue: #89b4fa;
  --warning: #fab387;
  --border: #45475a;
  --pane-focus: #89b4fa;
  --write-mode-bar-bg: #2f2430;
  --write-mode-bar-border: #f2cf66;
  --write-mode-bar-text: #fff4d1;
  --write-mode-bubble-bg: #f2cf66;
  --write-mode-bubble-text: #2a2100;
  --write-mode-bubble-ring: #fff4d1;
}
`.trim();

// Clean blue-tinted light palette.
const LIGHT_CSS = `
:root {
  --bg-primary: #f6f8fc;
  --bg-secondary: #e8edf6;
  --bg-surface: #ffffff;
  --bg-hover: #eef3ff;
  --bg-selected: #dbe8ff;
  --text-primary: #102038;
  --text-secondary: #2f4768;
  --text-dim: #647796;
  --text-muted: #647796;
  --accent: #0066cc;
  --accent-hover: #0052a3;
  --color-success: #1f8a4c;
  --success: #1f8a4c;
  --color-error: #c1322d;
  --error: #c1322d;
  --color-blue: #0066cc;
  --warning: #a36400;
  --border: #c7d3e4;
  --pane-focus: #0066cc;
  --write-mode-bar-bg: #fff7dd;
  --write-mode-bar-border: #cc8b00;
  --write-mode-bar-text: #553700;
  --write-mode-bubble-bg: #ffcd57;
  --write-mode-bubble-text: #3f2700;
  --write-mode-bubble-ring: #fff7dd;
}
`.trim();

export function registerBuiltinThemes(registrar: PluginRegistrar): void {
  registrar.registerTheme({
    id: 'dark',
    label: 'Dark',
    tone: 'dark',
    getCss: () => DARK_CSS,
  });

  registrar.registerTheme({
    id: 'light',
    label: 'Light',
    tone: 'light',
    getCss: () => LIGHT_CSS,
  });
}
