import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
    }
}
