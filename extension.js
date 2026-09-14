import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {resolveTheme, withAlpha} from './themes.js';

const HOUR = 3600 * 1000;
const THEME_KEYS = ['theme', 'custom-theme', 'theme-background'];

function formatCost(value) {
    if (!value)
        return '$0.00';
    if (value >= 1000)
        return `$${Math.round(value).toLocaleString()}`;
    return `$${value.toFixed(2)}`;
}

function formatTokens(value) {
    if (value >= 1e9)
        return `${(value / 1e9).toFixed(2)}B`;
    if (value >= 1e6)
        return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3)
        return `${(value / 1e3).toFixed(1)}K`;
    return String(value);
}

function formatDuration(ms) {
    if (ms <= 0)
        return 'now';
    const minutes = Math.round(ms / 60000);
    const days = Math.floor(minutes / 1440);
    if (days >= 1)
        return `${days}d ${Math.floor((minutes % 1440) / 60)}h`;
    const hours = Math.floor(minutes / 60);
    if (hours <= 0)
        return `${minutes}m`;
    return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function formatAge(ms) {
    if (ms < 90000)
        return 'just now';
    return `${formatDuration(ms)} ago`;
}

function shortModel(id) {
    return String(id).replace(/^claude-/, '').replace(/-/g, ' ');
}

// Claude Code encodes a project path by replacing every "/" with "-", which is
// lossy - so just drop the home-directory prefix and show what is left.
function shortProject(dir) {
    const home = GLib.get_home_dir().replaceAll('/', '-');
    let name = String(dir);
    if (name.startsWith(`${home}-`))
        name = name.slice(home.length + 1);
    return name.replace(/^-+/, '') || dir;
}

// Theme colours go in inline styles, which beat the stylesheet and can change
// without reloading it. A missing colour leaves the stylesheet's fallback.
function colorStyle(color) {
    return color ? `color: ${color};` : null;
}

function backgroundStyle(color) {
    return color ? `background-color: ${color};` : null;
}

// Labels in a fixed-width menu must wrap, or one long line widens the menu.
function wrappingLabel(styleClass, text = '', style = null) {
    const label = new St.Label({text, style_class: styleClass, style, x_expand: true});
    label.clutter_text.line_wrap = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

function levelFor(fraction) {
    if (fraction >= 1)
        return 'over';
    if (fraction >= 0.75)
        return 'high';
    return 'normal';
}

function levelColor(colors, level) {
    if (level === 'over')
        return colors.critical;
    if (level === 'high')
        return colors.warning;
    return colors.accent;
}

// A rounded track with a proportional fill. Clutter has no percentage width,
// so the fill is placed by hand at allocation time.
const UsageBar = GObject.registerClass(
class UsageBar extends St.Widget {
    _init(colors) {
        super._init({
            style_class: 'claude-bar',
            style: backgroundStyle(colors.track),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._colors = colors;
        this._fraction = 0;
        this._fill = new St.Widget({style_class: 'claude-bar-fill'});
        this.add_child(this._fill);
    }

    // colorize: warn as the bar fills. Off for plain proportion bars, where a
    // full bar just means "largest row", not "close to a limit".
    setFraction(fraction, colorize = true) {
        this._fraction = Math.max(0, Math.min(1, fraction || 0));
        const level = colorize ? levelFor(this._fraction) : 'normal';
        this._fill.style = backgroundStyle(levelColor(this._colors, level));
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const fill = new Clutter.ActorBox({
            x1: 0,
            y1: 0,
            x2: Math.round(box.get_width() * this._fraction),
            y2: box.get_height(),
        });
        this._fill.allocate(fill);
    }
});

const Sparkline = GObject.registerClass(
class Sparkline extends St.BoxLayout {
    _init(colors) {
        super._init({style_class: 'claude-sparkline', x_expand: true});
        this._colors = colors;
    }

    setValues(values) {
        this.destroy_all_children();
        const peak = Math.max(...values, 0.0001);
        for (const value of values) {
            const column = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                y_expand: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.END,
            });
            column.add_child(new St.Widget({
                style_class: value > 0 ? 'claude-spark-bar' : 'claude-spark-bar claude-spark-empty',
                style: backgroundStyle(value > 0 ? this._colors.accent : this._colors.track),
                height: Math.max(2, Math.round(28 * (value / peak))),
                x_expand: true,
                y_expand: true,
                y_align: Clutter.ActorAlign.END,
            }));
            this.add_child(column);
        }
    }
});

// One plan-limit window: title, "N% used", a bar, and when it resets.
const WindowRow = GObject.registerClass(
class WindowRow extends St.BoxLayout {
    _init(colors) {
        super._init({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'claude-window',
        });
        this._title = new St.Label({style_class: 'claude-heading', style: colorStyle(colors.muted)});
        this._value = new St.Label({style_class: 'claude-headline'});
        this._bar = new UsageBar(colors);
        this._detail = wrappingLabel('claude-detail', '', colorStyle(colors.muted));
        this.add_child(this._title);
        this.add_child(this._value);
        this.add_child(this._bar);
        this.add_child(this._detail);
    }

    update(window, now) {
        this._title.text = window.title;
        this._value.text = `${Math.floor(window.utilization)}% used`;
        this._bar.setFraction(window.utilization / 100);

        const parts = [];
        if (window.resetsAt) {
            parts.push(`resets in ${formatDuration(window.resetsAt - now)}`);
            // Project the window's finishing utilization from the pace so far.
            const length = window.key === 'five_hour' ? 5 * HOUR : 7 * 24 * HOUR;
            const elapsed = now - (window.resetsAt - length);
            if (elapsed > 10 * 60 * 1000 && window.utilization > 0) {
                const pace = Math.round(window.utilization * (length / elapsed));
                parts.push(`on pace for ${pace}% by reset`);
            }
        }
        this._detail.text = parts.join(' · ');
        this._detail.visible = parts.length > 0;
    }
});

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude Usage');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._data = null;
        this._cancellable = null;
        this._timeoutId = 0;
        this._windowRows = [];
        this._colors = resolveTheme(this._settings);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-usage-symbolic.svg`),
            style_class: 'system-status-icon claude-panel-icon',
            style: colorStyle(this._colors.accent),
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._buildMenu();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval')
                this._restartTimer();
            else if (THEME_KEYS.includes(key))
                this._applyTheme();
            else
                this._render();
        });

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.refresh({fresh: true});
        });

        this.refresh({fresh: true});
        this._restartTimer();
    }

    // Every themed actor takes its colours when it is built, so a theme change
    // just builds the menu again.
    _applyTheme() {
        this._colors = resolveTheme(this._settings);
        this._icon.style = colorStyle(this._colors.accent);
        this.menu.removeAll();
        this._windowRows = [];
        this._buildMenu();
        this._render();
    }

    _buildMenu() {
        const colors = this._colors;
        this.menu.box.style = colors.background
            ? `background-color: ${colors.background}; color: ${colors.text}; ` +
              `border-color: ${withAlpha(colors.text, 0.12)};`
            : null;

        // A non-reactive item takes the shell's insensitive text colour, so the
        // theme's text colour has to be set here rather than inherited.
        const section = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        section.style = colorStyle(colors.text);
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'claude-menu',
        });
        section.add_child(content);
        this.menu.addMenuItem(section);

        // Plan limits, filled in from whatever windows the server reports.
        this._windowBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        content.add_child(this._windowBox);

        const muted = colorStyle(colors.muted);
        this._planNotice = wrappingLabel('claude-detail claude-notice', '', colorStyle(colors.warning));
        content.add_child(this._planNotice);

        this._extra = wrappingLabel('claude-detail', '', muted);
        content.add_child(this._extra);

        // Local transcript detail: what the plan limits cannot tell you.
        content.add_child(new St.Label({text: 'Local activity today', style_class: 'claude-heading', style: muted}));
        this._todayHeadline = new St.Label({text: '—', style_class: 'claude-headline'});
        content.add_child(this._todayHeadline);
        this._todayDetail = wrappingLabel('claude-detail', '', muted);
        content.add_child(this._todayDetail);

        content.add_child(new St.Label({text: 'Last 14 days', style_class: 'claude-heading', style: muted}));
        this._sparkline = new Sparkline(colors);
        content.add_child(this._sparkline);
        this._weekDetail = wrappingLabel('claude-detail', '', muted);
        content.add_child(this._weekDetail);

        this._breakdownHeading = new St.Label({style_class: 'claude-heading', style: muted});
        content.add_child(this._breakdownHeading);
        this._breakdown = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        content.add_child(this._breakdown);

        this._footer = wrappingLabel('claude-detail claude-footer', '', muted);
        content.add_child(this._footer);

        const separator = new PopupMenu.PopupSeparatorMenuItem();
        if (colors.background)
            separator._separator.style = backgroundStyle(withAlpha(colors.text, 0.12));
        this.menu.addMenuItem(separator);
        this._addAction('Refresh now', () => this.refresh({fresh: true}));
        this._addAction('Settings', () => this._extension.openPreferences());
    }

    _addAction(text, callback) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.connect('activate', callback);
        // The shell's hover style assumes its own dark menu, so a themed
        // background needs a hover fill drawn from the theme's text colour.
        const style = () => {
            const {background, text: fg} = this._colors;
            item.style = background
                ? `color: ${fg}; background-color: ${item.active ? withAlpha(fg, 0.1) : 'transparent'};`
                : null;
        };
        item.connect('notify::active', style);
        style();
        this.menu.addMenuItem(item);
    }

    refresh({fresh = false} = {}) {
        if (this._cancellable)
            return;
        const gjs = GLib.find_program_in_path('gjs');
        const scanner = this._extension.dir.get_child('scanner.js').get_path();
        if (!gjs) {
            this._label.text = 'no gjs';
            return;
        }
        // On the timer, a half-interval-old plan fetch is good enough; opening
        // the menu or hitting Refresh always asks Claude Code again.
        const maxAge = fresh ? 0 : Math.max(15, Math.floor(this._settings.get_int('refresh-interval') / 2));
        this._cancellable = new Gio.Cancellable();
        let proc;
        try {
            proc = Gio.Subprocess.new([gjs, '-m', scanner, `--live-max-age=${maxAge}`],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            logError(e, 'claude-usage: cannot start scanner');
            this._cancellable = null;
            return;
        }
        proc.communicate_utf8_async(null, this._cancellable, (source, result) => {
            this._cancellable = null;
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) {
                    log(`claude-usage: scanner failed: ${stderr}`);
                    return;
                }
                this._data = JSON.parse(stdout);
                this._render();
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'claude-usage: scan failed');
            }
        });
    }

    _restartTimer() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        const interval = this._settings.get_int('refresh-interval');
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _windowByKey(key) {
        return this._data?.live?.windows?.find(w => w.key === key) ?? null;
    }

    _renderPanel(data) {
        const mode = this._settings.get_string('panel-mode');
        const session = this._windowByKey('five_hour');
        const week = this._windowByKey('seven_day');

        let text = null;
        let fraction = 0;
        switch (mode) {
        case 'icon-only':
            break;
        case 'week-percent':
            if (week) {
                text = `${Math.floor(week.utilization)}%`;
                fraction = week.utilization / 100;
            }
            break;
        case 'session-cost':
            text = formatCost(data.block ? data.block.totals.cost : 0);
            break;
        case 'today-cost':
            text = formatCost(data.today.cost);
            break;
        default:
            if (session) {
                text = `${Math.floor(session.utilization)}%`;
                fraction = session.utilization / 100;
            }
            break;
        }

        // With no plan limits to show, fall back to the local cost estimate
        // rather than an empty panel.
        if (text === null && mode !== 'icon-only')
            text = formatCost(data.today.cost);

        // The label keeps the top bar's own colour until usage needs attention.
        const level = levelFor(fraction);
        this._label.visible = text !== null;
        this._label.text = text ?? '';
        this._label.style = level === 'normal' ? null : colorStyle(levelColor(this._colors, level));
        this._icon.style = colorStyle(levelColor(this._colors, level));
    }

    _renderWindows(data, now) {
        const live = data.live || {};
        const windows = live.windows || [];

        while (this._windowRows.length > windows.length)
            this._windowRows.pop().destroy();
        while (this._windowRows.length < windows.length) {
            const row = new WindowRow(this._colors);
            this._windowBox.add_child(row);
            this._windowRows.push(row);
        }
        windows.forEach((window, i) => this._windowRows[i].update(window, now));

        if (windows.length) {
            this._planNotice.visible = false;
            return;
        }
        this._planNotice.visible = true;
        this._planNotice.text = live.available
            ? 'Claude Code reported no plan limit windows.'
            : `Plan limits unavailable (${live.error || 'API key or third-party provider'}). ` +
              'Showing local activity only.';
    }

    _renderExtraUsage(live) {
        const extra = live?.extraUsage;
        if (!extra) {
            this._extra.visible = false;
            return;
        }
        this._extra.visible = true;
        const used = extra.usedCredits ?? 0;
        const limit = extra.monthlyLimit;
        this._extra.text = limit
            ? `Extra usage: ${used} of ${limit} ${extra.currency || ''} credits used`
            : `Extra usage: ${used} ${extra.currency || ''} credits used`;
    }

    _renderBreakdown(data) {
        this._breakdown.destroy_all_children();
        const byProject = this._settings.get_boolean('breakdown-by-project');
        const rows = byProject ? data.projects : data.models;
        this._breakdownHeading.text = byProject ? 'By project today' : 'By model today';
        if (!rows.length) {
            this._breakdown.add_child(new St.Label({
                text: 'Nothing yet today.',
                style_class: 'claude-detail',
                style: colorStyle(this._colors.muted),
            }));
            return;
        }
        const top = rows[0].cost || 1;
        for (const row of rows.slice(0, 5)) {
            const line = new St.BoxLayout({x_expand: true, style_class: 'claude-row'});
            const name = new St.Label({
                text: byProject ? shortProject(row.name) : shortModel(row.name),
                x_expand: true,
                style_class: 'claude-row-name',
            });
            // Encoded project paths get long; keep the menu a fixed width.
            name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
            line.add_child(name);
            line.add_child(new St.Label({
                text: formatCost(row.cost),
                style_class: 'claude-row-value',
                style: colorStyle(this._colors.muted),
            }));
            this._breakdown.add_child(line);
            const bar = new UsageBar(this._colors);
            bar.setFraction(row.cost / top, false);
            this._breakdown.add_child(bar);
        }
    }

    _render() {
        const data = this._data;
        if (!data)
            return;
        const now = Date.now();

        this._renderPanel(data);
        this._renderWindows(data, now);
        this._renderExtraUsage(data.live);

        this._todayHeadline.text = formatCost(data.today.cost);
        this._todayDetail.text =
            `${formatTokens(data.today.tokens)} tokens · ${data.today.messages} messages · ` +
            `${formatTokens(data.today.output)} out, ${formatTokens(data.today.cacheRead)} cached in`;

        this._sparkline.setValues(data.days.map(d => d.cost));
        this._weekDetail.text =
            `Last 7 days: ${formatCost(data.week.cost)} · ${formatTokens(data.week.tokens)} tokens · ` +
            `${data.week.messages} messages`;

        this._renderBreakdown(data);

        const live = data.live || {};
        const source = live.available
            ? `Plan limits from Claude Code${live.subscription ? ` (${live.subscription})` : ''}`
            : 'Plan limits unavailable';
        this._footer.text =
            `${source} · local costs are equivalent API rates · updated ${formatAge(now - data.generated)}`;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._addIndicator();
        // addToStatusArea() refuses a role it already holds, so moving the
        // indicator means rebuilding it.
        this._positionChangedId = this._settings.connect('changed::panel-position', () => {
            this._indicator?.destroy();
            this._addIndicator();
        });
    }

    disable() {
        if (this._positionChangedId) {
            this._settings.disconnect(this._positionChangedId);
            this._positionChangedId = 0;
        }
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    _addIndicator() {
        this._indicator = new ClaudeUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0,
            this._settings.get_string('panel-position'));
    }
}
