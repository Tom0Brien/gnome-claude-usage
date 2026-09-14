// Colour themes, shared by the extension and the preferences window, so this
// module must not import anything from GNOME Shell or GTK.

export const CUSTOM = 'custom';
export const DEFAULT = 'claude';

// Signal colours are always applied. Surface colours repaint the drop-down
// itself, and only apply when the theme has them and the user wants them.
export const ROLES = [
    {key: 'accent', title: 'Accent', subtitle: 'Panel icon, bars and sparkline'},
    {key: 'warning', title: 'Warning', subtitle: 'Bars and panel at 75% or more'},
    {key: 'critical', title: 'Critical', subtitle: 'Bars and panel at 100%'},
    {key: 'background', title: 'Background', subtitle: 'Drop-down background', surface: true},
    {key: 'text', title: 'Text', subtitle: 'Figures, names and menu items', surface: true},
    {key: 'muted', title: 'Secondary text', subtitle: 'Headings and details', surface: true},
    {key: 'track', title: 'Track', subtitle: 'Unfilled bars and idle days', surface: true},
];

const theme = (id, name, accent, warning, critical, background, text, muted, track) =>
    ({id, name, colors: {accent, warning, critical, background, text, muted, track}});

export const THEMES = [
    // The default: Claude's colours on whatever menu the shell draws.
    {id: 'claude', name: 'Claude', colors: {accent: '#d97757', warning: '#e0a458', critical: '#d95757'}},
    theme('claude-dark', 'Claude Dark', '#d97757', '#e0a458', '#d95757', '#262624', '#faf9f5', '#a6a39a', '#3a3935'),
    theme('claude-light', 'Claude Light', '#c96442', '#b7791f', '#c53030', '#faf9f5', '#1f1e1d', '#73726c', '#e8e6dc'),
    theme('adwaita-dark', 'Adwaita Dark', '#3584e4', '#f8e45c', '#ff7b63', '#36363a', '#ffffff', '#b0b0b3', '#4a4a4f'),
    theme('adwaita-light', 'Adwaita Light', '#1c71d8', '#9c6e03', '#c01c28', '#fafafb', '#1e1e20', '#6a6a70', '#dcdce0'),
    theme('catppuccin-mocha', 'Catppuccin Mocha', '#cba6f7', '#f9e2af', '#f38ba8', '#1e1e2e', '#cdd6f4', '#a6adc8', '#313244'),
    theme('catppuccin-latte', 'Catppuccin Latte', '#8839ef', '#df8e1d', '#d20f39', '#eff1f5', '#4c4f69', '#6c6f85', '#ccd0da'),
    theme('dracula', 'Dracula', '#bd93f9', '#ffb86c', '#ff5555', '#282a36', '#f8f8f2', '#a4add3', '#44475a'),
    theme('everforest', 'Everforest', '#a7c080', '#dbbc7f', '#e67e80', '#2d353b', '#d3c6aa', '#9da9a0', '#3d484d'),
    theme('github-dark', 'GitHub Dark', '#2f81f7', '#d29922', '#f85149', '#0d1117', '#e6edf3', '#8b949e', '#21262d'),
    theme('github-light', 'GitHub Light', '#0969da', '#9a6700', '#cf222e', '#ffffff', '#1f2328', '#656d76', '#eaeef2'),
    theme('gruvbox-dark', 'Gruvbox Dark', '#83a598', '#fabd2f', '#fb4934', '#282828', '#ebdbb2', '#a89984', '#3c3836'),
    theme('gruvbox-light', 'Gruvbox Light', '#076678', '#b57614', '#9d0006', '#fbf1c7', '#3c3836', '#7c6f64', '#ebdbb2'),
    theme('kanagawa', 'Kanagawa', '#7e9cd8', '#e6c384', '#e46876', '#1f1f28', '#dcd7ba', '#a6a69c', '#2a2a37'),
    theme('monokai', 'Monokai', '#a6e22e', '#e6db74', '#f92672', '#272822', '#f8f8f2', '#a59f85', '#3e3d32'),
    theme('nord', 'Nord', '#88c0d0', '#ebcb8b', '#bf616a', '#2e3440', '#eceff4', '#a5afc0', '#434c5e'),
    theme('one-dark', 'One Dark', '#61afef', '#e5c07b', '#e06c75', '#282c34', '#dcdfe4', '#9da5b4', '#3e4451'),
    theme('rose-pine', 'Rosé Pine', '#ebbcba', '#f6c177', '#eb6f92', '#191724', '#e0def4', '#908caa', '#26233a'),
    theme('solarized-dark', 'Solarized Dark', '#268bd2', '#b58900', '#dc322f', '#002b36', '#eee8d5', '#93a1a1', '#073642'),
    theme('solarized-light', 'Solarized Light', '#268bd2', '#b58900', '#dc322f', '#fdf6e3', '#073642', '#657b83', '#eee8d5'),
    theme('tokyo-night', 'Tokyo Night', '#7aa2f7', '#e0af68', '#f7768e', '#1a1b26', '#c0caf5', '#a9b1d6', '#292e42'),
    theme('high-contrast', 'High Contrast', '#00e5ff', '#ffd600', '#ff4040', '#000000', '#ffffff', '#e0e0e0', '#555555'),
];

export function findTheme(id) {
    return THEMES.find(t => t.id === id) ?? null;
}

// [r, g, b, a] from #rgb, #rrggbb, #rrggbbaa, rgb() or rgba(); null otherwise.
export function parseColor(value) {
    const text = String(value ?? '').trim().toLowerCase();
    let m = text.match(/^#([0-9a-f]{3,8})$/);
    if (m) {
        let hex = m[1];
        if (hex.length === 3)
            hex = [...hex].map(c => c + c).join('');
        if (hex.length !== 6 && hex.length !== 8)
            return null;
        const byte = i => parseInt(hex.slice(i, i + 2), 16);
        return [byte(0), byte(2), byte(4), hex.length === 8 ? byte(6) / 255 : 1];
    }
    m = text.match(/^rgba?\(([^)]*)\)$/);
    if (m) {
        const parts = m[1].split(',').map(p => Number(p.trim()));
        if ((parts.length === 3 || parts.length === 4) && parts.every(Number.isFinite))
            return [...parts.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(v)))), parts[3] ?? 1];
    }
    return null;
}

// The same colour at a given opacity, for hover fills and borders.
export function withAlpha(value, alpha) {
    const rgba = parseColor(value);
    if (!rgba)
        return value;
    return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${(rgba[3] * alpha).toFixed(3)})`;
}

// The palette a theme id stands for, custom colours filled in over Claude Dark.
export function themeColors(id, custom = {}) {
    if (id !== CUSTOM)
        return {...(findTheme(id) ?? findTheme(DEFAULT)).colors};
    const colors = {...findTheme('claude-dark').colors};
    for (const {key} of ROLES) {
        if (parseColor(custom[key]))
            colors[key] = custom[key];
    }
    return colors;
}

// What the extension should paint with the current settings. Surface keys
// are left out entirely when the shell's own menu colours should show.
export function resolveTheme(settings) {
    const custom = settings.get_value('custom-theme').deepUnpack();
    const colors = themeColors(settings.get_string('theme'), custom);
    if (!colors.background || !settings.get_boolean('theme-background')) {
        for (const role of ROLES.filter(r => r.surface))
            delete colors[role.key];
    }
    return colors;
}
