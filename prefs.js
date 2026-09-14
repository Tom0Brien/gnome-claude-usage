import Adw from 'gi://Adw';
import Cairo from 'gi://cairo';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {CUSTOM, ROLES, THEMES, parseColor, themeColors} from './themes.js';

const PANEL_MODES = [
    ['session-percent', 'Session window used (%)'],
    ['week-percent', 'Weekly window used (%)'],
    ['session-cost', 'Cost of the current 5-hour block'],
    ['today-cost', "Today's cost"],
    ['icon-only', 'Icon only'],
];
const POSITIONS = [
    ['left', 'Left'],
    ['center', 'Centre'],
    ['right', 'Right'],
];

function comboRow(settings, key, title, subtitle, choices) {
    const nicks = choices.map(c => c[0]);
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(c => c[1])),
        selected: Math.max(0, nicks.indexOf(settings.get_string(key))),
    });
    row.connect('notify::selected', () => settings.set_string(key, nicks[row.selected]));
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper, step, digits) {
    const isDouble = digits > 0;
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
        digits,
        value: isDouble ? settings.get_double(key) : settings.get_int(key),
    });
    // Bound by hand rather than with settings.bind(): SpinRow's value is always
    // a double, which will not bind to an integer key.
    row.connect('notify::value', () => {
        if (isDouble)
            settings.set_double(key, row.value);
        else
            settings.set_int(key, Math.round(row.value));
    });
    const changed = settings.connect(`changed::${key}`, () => {
        row.value = isDouble ? settings.get_double(key) : settings.get_int(key);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}

// What the shell's own dark menu looks like, for previewing themes that
// leave the surface alone.
const SHELL_SURFACE = {
    background: '#36363a',
    text: '#ffffff',
    muted: 'rgba(255, 255, 255, 0.65)',
    track: 'rgba(255, 255, 255, 0.14)',
};
const THEME_KEYS = ['theme', 'custom-theme', 'theme-background'];

function setSource(cr, color) {
    const [r, g, b, a] = parseColor(color) ?? [255, 0, 255, 1];
    cr.setSourceRGBA(r / 255, g / 255, b / 255, a);
}

function roundedRect(cr, x, y, width, height, radius) {
    radius = Math.min(radius, width / 2, height / 2);
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// A rough sketch of the drop-down in the chosen colours.
function drawPreview(cr, width, height, colors) {
    roundedRect(cr, 0, 0, width, height, 14);
    setSource(cr, colors.background);
    cr.fill();

    const pad = 18;
    const inner = width - pad * 2;
    const text = (content, x, y, size, color, bold = false) => {
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL,
            bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
        cr.setFontSize(size);
        setSource(cr, color);
        cr.moveTo(x, y);
        cr.showText(content);
    };
    const bar = (y, fraction, color) => {
        roundedRect(cr, pad, y, inner, 8, 4);
        setSource(cr, colors.track);
        cr.fill();
        roundedRect(cr, pad, y, inner * fraction, 8, 4);
        setSource(cr, color);
        cr.fill();
    };

    const rows = [
        ['CURRENT SESSION', '42% used', 0.42, colors.accent],
        ['CURRENT WEEK', '81% used', 0.81, colors.warning],
        ['OPUS THIS WEEK', '100% used', 1, colors.critical],
    ];
    rows.forEach(([heading, value, fraction, color], i) => {
        const top = pad + i * 58;
        text(heading, pad, top + 10, 10, colors.muted, true);
        text(value, pad, top + 30, 17, colors.text, true);
        bar(top + 38, fraction, color);
    });

    const sparkTop = pad + rows.length * 58 + 8;
    text('LAST 14 DAYS', pad, sparkTop + 10, 10, colors.muted, true);
    const days = [3, 5, 0, 8, 6, 9, 4, 0, 7, 10, 6, 2, 8, 5];
    const gap = 3;
    const barWidth = (inner - gap * (days.length - 1)) / days.length;
    days.forEach((value, i) => {
        const h = Math.max(2, 30 * value / 10);
        roundedRect(cr, pad + i * (barWidth + gap), sparkTop + 50 - h, barWidth, h, 2);
        setSource(cr, value ? colors.accent : colors.track);
        cr.fill();
    });
}

function toRgba(color) {
    const rgba = new Gdk.RGBA();
    rgba.parse(color);
    return rgba;
}

function appearancePage(settings) {
    const page = new Adw.PreferencesPage({
        title: 'Appearance',
        icon_name: 'applications-graphics-symbolic',
    });

    const choices = [...THEMES.map(t => [t.id, t.name]), [CUSTOM, 'Custom']];
    const ids = choices.map(c => c[0]);
    const customColors = () => settings.get_value('custom-theme').deepUnpack();
    // Every role has a colour to show, even on a theme that leaves the
    // surface to the shell.
    const shownColors = () => ({
        ...themeColors('claude-dark'),
        ...themeColors(settings.get_string('theme'), customColors()),
    });

    const group = new Adw.PreferencesGroup({
        title: 'Theme',
        description: 'Colours for the top-bar icon and the drop-down.',
    });
    page.add(group);

    const preview = new Gtk.DrawingArea({
        content_width: 300,
        content_height: 260,
        halign: Gtk.Align.CENTER,
        margin_bottom: 12,
    });
    preview.set_draw_func((_area, cr, width, height) => {
        const colors = themeColors(settings.get_string('theme'), customColors());
        const surface = colors.background && settings.get_boolean('theme-background');
        drawPreview(cr, width, height, surface ? colors : {...colors, ...SHELL_SURFACE});
        cr.$dispose();
    });
    group.add(preview);

    const themeRow = new Adw.ComboRow({
        title: 'Theme',
        model: Gtk.StringList.new(choices.map(c => c[1])),
    });
    group.add(themeRow);

    const backgroundRow = new Adw.SwitchRow({
        title: 'Theme the drop-down background',
        subtitle: 'Use the theme’s background and text colours instead of the shell’s',
    });
    settings.bind('theme-background', backgroundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(backgroundRow);

    const colorsGroup = new Adw.PreferencesGroup({
        title: 'Colours',
        description: 'Changing a colour saves the current theme, with your change, as the Custom theme.',
    });
    page.add(colorsGroup);

    let syncing = false;
    const buttons = new Map();
    for (const role of ROLES) {
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({title: role.title, with_alpha: true}),
            valign: Gtk.Align.CENTER,
        });
        const row = new Adw.ActionRow({title: role.title, subtitle: role.subtitle, activatable_widget: button});
        row.add_suffix(button);
        colorsGroup.add(row);
        buttons.set(role.key, button);

        button.connect('notify::rgba', () => {
            if (syncing)
                return;
            const id = settings.get_string('theme');
            const colors = {...shownColors(), [role.key]: button.rgba.to_string()};
            // Editing a surface colour means you want to see it. Otherwise a
            // theme that left the surface to the shell keeps doing so.
            if (role.surface)
                settings.set_boolean('theme-background', true);
            else if (id !== CUSTOM && !themeColors(id).background)
                settings.set_boolean('theme-background', false);
            settings.set_value('custom-theme', new GLib.Variant('a{ss}', colors));
            settings.set_string('theme', CUSTOM);
        });
    }

    themeRow.connect('notify::selected', () => {
        if (!syncing)
            settings.set_string('theme', ids[themeRow.selected]);
    });

    const sync = () => {
        syncing = true;
        const id = settings.get_string('theme');
        themeRow.selected = Math.max(0, ids.indexOf(id));
        backgroundRow.sensitive = Boolean(themeColors(id, customColors()).background);
        const colors = shownColors();
        for (const [key, button] of buttons)
            button.rgba = toRgba(colors[key]);
        syncing = false;
        preview.queue_draw();
    };
    const changedIds = THEME_KEYS.map(key => settings.connect(`changed::${key}`, sync));
    page.connect('destroy', () => changedIds.forEach(id => settings.disconnect(id)));
    sync();

    return page;
}

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Claude Usage',
            icon_name: 'utilities-system-monitor-symbolic',
        });
        window.add(page);

        const panel = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'The percentages are your real plan limits, read from Claude Code. ' +
                'The cost figures come from your local transcripts, priced at API rates.',
        });
        page.add(panel);
        panel.add(comboRow(settings, 'panel-mode', 'Display',
            'What the indicator shows next to the icon', PANEL_MODES));
        panel.add(comboRow(settings, 'panel-position', 'Position',
            'Where the indicator sits in the top bar', POSITIONS));
        panel.add(spinRow(settings, 'refresh-interval', 'Refresh interval',
            'Seconds between updates. Each one runs `claude` briefly to read your plan limits.',
            10, 3600, 10, 0));

        const detail = new Adw.PreferencesGroup({title: 'Breakdown'});
        page.add(detail);
        const byProject = new Adw.SwitchRow({
            title: 'Break down by project',
            subtitle: 'Show today’s usage per project directory instead of per model',
        });
        settings.bind('breakdown-by-project', byProject, 'active', Gio.SettingsBindFlags.DEFAULT);
        detail.add(byProject);

        window.add(appearancePage(settings));
    }
}
