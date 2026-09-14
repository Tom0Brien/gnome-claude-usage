#!/usr/bin/env -S gjs -m
//
// scanner.js - collects Claude usage and prints a summary as JSON.
//
// Two sources, merged:
//
//  1. The real plan limits, asked for directly. Claude Code answers a
//     `get_usage` control request over its stream-json protocol with the same
//     data `/usage` renders: utilization and reset time for the 5-hour session
//     window and the 7-day windows. This is the authoritative number.
//  2. The local transcripts under ~/.claude/projects, which the plan limits say
//     nothing about: cost per model and per project, daily history, token mix.
//
// Run out-of-process (Gio.Subprocess) so neither the ~1.4s `claude` call nor
// parsing tens of megabytes of JSONL ever blocks the compositor.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const WINDOW_DAYS = 30;      // how far back records are kept
const BLOCK_HOURS = 5;       // length of a Claude rate-limit block
const HOUR = 3600 * 1000;
const LIVE_TIMEOUT_SECONDS = 25;  // the CLI needs ~1.5s; this is the give-up point

// [input, output, cache write 5m, cache write 1h, cache read] in $ / 1M tokens.
const PRICES = {
    'claude-fable-5-1':  [10, 50, 12.5, 20, 0.25],
    'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
    'claude-fable-5':    [10, 50, 12.5, 20, 1.00],
    'claude-mythos-5':   [10, 50, 12.5, 20, 1.00],
    'claude-opus-5':     [5, 25, 6.25, 10, 0.50],
    'claude-opus-4-8':   [5, 25, 6.25, 10, 0.50],
    'claude-opus-4-7':   [5, 25, 6.25, 10, 0.50],
    'claude-opus-4-6':   [5, 25, 6.25, 10, 0.50],
    'claude-opus-4-5':   [5, 25, 6.25, 10, 0.50],
    'claude-sonnet-5':   [2, 10, 2.50, 4, 0.20],
    'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.30],
    'claude-sonnet-4-5': [3, 15, 3.75, 6, 0.30],
    'claude-haiku-4-5':  [1, 5, 1.25, 2, 0.10],
};
const FAMILY_FALLBACK = {
    fable: PRICES['claude-fable-5-1'],
    mythos: PRICES['claude-mythos-5-1'],
    opus: PRICES['claude-opus-5'],
    sonnet: PRICES['claude-sonnet-5'],
    haiku: PRICES['claude-haiku-4-5'],
};

function priceFor(model) {
    // Model ids can carry suffixes such as "claude-opus-5[1m]".
    const id = String(model || '').split('[')[0].trim();
    if (PRICES[id])
        return PRICES[id];
    for (const [key, price] of Object.entries(PRICES)) {
        if (id.startsWith(key))
            return price;
    }
    for (const [family, price] of Object.entries(FAMILY_FALLBACK)) {
        if (id.includes(family))
            return price;
    }
    return null;
}

function transcriptRoots() {
    const roots = [];
    const push = path => {
        const dir = GLib.build_filenamev([path, 'projects']);
        if (GLib.file_test(dir, GLib.FileTest.IS_DIR) && !roots.includes(dir))
            roots.push(dir);
    };
    const configured = GLib.getenv('CLAUDE_CONFIG_DIR');
    if (configured) {
        for (const part of configured.split(','))
            push(part.trim());
    }
    push(GLib.build_filenamev([GLib.get_home_dir(), '.claude']));
    push(GLib.build_filenamev([GLib.get_user_config_dir(), 'claude']));
    return roots;
}

function listTranscripts() {
    const out = [];
    for (const root of transcriptRoots()) {
        const rootFile = Gio.File.new_for_path(root);
        let projects;
        try {
            projects = rootFile.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_e) {
            continue;
        }
        let project;
        while ((project = projects.next_file(null)) !== null) {
            if (project.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const projectDir = rootFile.get_child(project.get_name());
            let files;
            try {
                files = projectDir.enumerate_children('standard::name,standard::size,time::modified',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (_e) {
                continue;
            }
            let info;
            while ((info = files.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.jsonl'))
                    continue;
                out.push({
                    path: projectDir.get_child(name).get_path(),
                    project: project.get_name(),
                    size: info.get_size(),
                    mtime: info.get_attribute_uint64('time::modified'),
                });
            }
        }
    }
    return out;
}

// Turn one transcript into the minimal per-message records we care about.
function parseFile(path, project, cutoffMs) {
    const records = [];
    let contents;
    try {
        [, contents] = Gio.File.new_for_path(path).load_contents(null);
    } catch (_e) {
        return records;
    }
    const text = new TextDecoder('utf-8').decode(contents);
    for (const line of text.split('\n')) {
        if (line.length < 2 || !line.includes('"usage"'))
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch (_e) {
            continue;
        }
        const message = entry.message;
        const usage = message && message.usage;
        if (!usage || entry.type !== 'assistant')
            continue;
        const t = Date.parse(entry.timestamp);
        if (!Number.isFinite(t) || t < cutoffMs)
            continue;

        const creation = usage.cache_creation || {};
        const write5 = creation.ephemeral_5m_input_tokens || 0;
        const write1 = creation.ephemeral_1h_input_tokens || 0;
        const writeTotal = usage.cache_creation_input_tokens || (write5 + write1);
        records.push({
            t,
            project,
            model: message.model || 'unknown',
            key: `${entry.requestId || ''}|${message.id || entry.uuid || ''}`,
            i: usage.input_tokens || 0,
            o: usage.output_tokens || 0,
            // If the breakdown is missing, bill the whole write at the 5m rate.
            w5: write5 || (writeTotal - write1),
            w1: write1,
            r: usage.cache_read_input_tokens || 0,
        });
    }
    return records;
}

function cachePath() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage']);
    GLib.mkdir_with_parents(dir, 0o755);
    return GLib.build_filenamev([dir, 'scan-cache.json']);
}

function readCache() {
    try {
        const [ok, bytes] = GLib.file_get_contents(cachePath());
        if (!ok)
            return {};
        return JSON.parse(new TextDecoder('utf-8').decode(bytes)) || {};
    } catch (_e) {
        return {};
    }
}

function writeCache(cache) {
    try {
        GLib.file_set_contents(cachePath(), JSON.stringify(cache));
    } catch (_e) {
        // A missing cache only costs a slower next scan.
    }
}

function collectRecords(cutoffMs) {
    const oldCache = readCache();
    const newCache = {};
    const records = [];
    for (const file of listTranscripts()) {
        const stamp = `${file.size}:${file.mtime}:${cutoffMs}`;
        const hit = oldCache[file.path];
        let parsed;
        if (hit && hit.stamp === stamp)
            parsed = hit.records;
        else
            parsed = parseFile(file.path, file.project, cutoffMs);
        newCache[file.path] = {stamp, records: parsed};
        for (const record of parsed)
            records.push(record);
    }
    writeCache(newCache);
    records.sort((a, b) => a.t - b.t);
    return records;
}


// ---------------------------------------------------------------------------
// Live plan limits, straight from Claude Code
// ---------------------------------------------------------------------------

// Titles match what `/usage` prints, so the drop-down and the slash command
// agree. Anything not listed here is an internal bucket we do not surface.
const WINDOW_TITLES = {
    five_hour: 'Current session',
    seven_day: 'Current week (all models)',
    seven_day_opus: 'Current week (Opus only)',
    seven_day_sonnet: 'Current week (Sonnet only)',
    seven_day_oauth_apps: 'Current week (apps)',
};

// List the names of a directory's entries, or [] if it can't be read.
function listDir(path) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null)
            out.push(info.get_name());
        en.close(null);
    } catch (_e) {
        // Missing or unreadable directory: nothing to contribute.
    }
    return out;
}

// Compare two dotted version strings (e.g. "2.1.205-linux-x64").
// Returns >0 if a is newer, <0 if older, 0 if equal.
function compareVersions(a, b) {
    const pa = a.split('.');
    const pb = b.split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
        if (d)
            return d;
    }
    return 0;
}

// Editors that install the Claude Code extension bundle a full `claude`
// binary inside the extension directory (names look like
// `anthropic.claude-code-2.1.205-linux-x64`). When no standalone CLI is on
// PATH, use the newest bundled copy; it shares the same ~/.claude sign-in.
function editorBundledClaude() {
    const home = GLib.get_home_dir();
    const extensionRoots = [
        [home, '.vscode', 'extensions'],
        [home, '.vscode-insiders', 'extensions'],
        [home, '.vscode-server', 'extensions'],
        [home, '.vscode-server-insiders', 'extensions'],
        [home, '.vscodium', 'extensions'],
        [home, '.cursor', 'extensions'],
        [home, '.windsurf', 'extensions'],
    ];
    const prefix = 'anthropic.claude-code-';
    const matches = [];
    for (const parts of extensionRoots) {
        const root = GLib.build_filenamev(parts);
        for (const name of listDir(root)) {
            if (!name.startsWith(prefix))
                continue;
            const bin = GLib.build_filenamev(
                [root, name, 'resources', 'native-binary', 'claude']);
            if (GLib.file_test(bin, GLib.FileTest.IS_EXECUTABLE))
                matches.push({version: name.slice(prefix.length), bin});
        }
    }
    if (!matches.length)
        return null;
    matches.sort((a, b) => compareVersions(b.version, a.version));
    return matches[0].bin;
}

function claudeBinary() {
    const explicit = GLib.getenv('CLAUDE_USAGE_BIN');
    if (explicit && GLib.file_test(explicit, GLib.FileTest.IS_EXECUTABLE))
        return explicit;
    const found = GLib.find_program_in_path('claude');
    if (found)
        return found;
    // GNOME Shell does not always inherit a login shell's PATH.
    const home = GLib.get_home_dir();
    for (const candidate of [
        GLib.build_filenamev([home, '.local', 'bin', 'claude']),
        GLib.build_filenamev([home, '.claude', 'local', 'claude']),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
    ]) {
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
            return candidate;
    }
    // Fall back to a copy bundled inside an editor's Claude Code extension.
    return editorBundledClaude();
}

function liveCachePath() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage']);
    GLib.mkdir_with_parents(dir, 0o755);
    return GLib.build_filenamev([dir, 'live-usage.json']);
}

function readLiveCache(maxAgeMs) {
    try {
        const [ok, bytes] = GLib.file_get_contents(liveCachePath());
        if (!ok)
            return null;
        const cached = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        if (Date.now() - cached.fetched > maxAgeMs)
            return null;
        return cached;
    } catch (_e) {
        return null;
    }
}

// Shape the raw rate_limits blob into an ordered list the UI can render
// without knowing any of the bucket names.
function shapeLive(payload) {
    const limits = payload.rate_limits;
    const subscription = payload.subscription_type ?? null;
    const result = {
        fetched: Date.now(),
        available: !!payload.rate_limits_available,
        subscription,
        windows: [],
        extraUsage: null,
    };
    if (!limits)
        return result;

    // `/usage` hides the Sonnet-only row on plans where it never applies.
    const showSonnet = subscription === 'max' || subscription === 'team' || subscription === null;

    for (const [key, title] of Object.entries(WINDOW_TITLES)) {
        if (key === 'seven_day_sonnet' && !showSonnet)
            continue;
        const window = limits[key];
        if (!window || window.utilization === null || window.utilization === undefined)
            continue;
        result.windows.push({
            key,
            title,
            utilization: window.utilization,
            resetsAt: window.resets_at ? Date.parse(window.resets_at) : null,
        });
    }

    for (const scoped of limits.model_scoped || []) {
        if (!scoped || scoped.utilization === null || scoped.utilization === undefined)
            continue;
        result.windows.push({
            key: `model_scoped:${scoped.display_name}`,
            title: `Current week (${scoped.display_name} only)`,
            utilization: scoped.utilization,
            resetsAt: scoped.resets_at ? Date.parse(scoped.resets_at) : null,
        });
    }

    const extra = limits.extra_usage;
    if (extra && extra.is_enabled) {
        result.extraUsage = {
            utilization: extra.utilization,
            usedCredits: extra.used_credits,
            monthlyLimit: extra.monthly_limit,
            currency: extra.currency,
        };
    }
    return result;
}

// Ask Claude Code for the structured /usage data. The control request costs no
// tokens and makes no model call; it just needs the CLI's OAuth session.
function fetchLive(maxAgeMs, done) {
    const cached = readLiveCache(maxAgeMs);
    if (cached) {
        done(cached);
        return;
    }
    const claude = claudeBinary();
    if (!claude) {
        done({fetched: Date.now(), available: false, error: 'claude not found', windows: []});
        return;
    }

    let proc;
    try {
        proc = Gio.Subprocess.new(
            [claude, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '-p'],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
            Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        done({fetched: Date.now(), available: false, error: `${e}`, windows: []});
        return;
    }

    const cancellable = new Gio.Cancellable();
    let settled = false;
    const finish = value => {
        if (settled)
            return;
        settled = true;
        if (value.available)
            GLib.file_set_contents(liveCachePath(), JSON.stringify(value));
        done(value);
    };

    // The CLI has to start up, so give it room - but never hang the scan.
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, LIVE_TIMEOUT_SECONDS, () => {
        cancellable.cancel();
        finish({fetched: Date.now(), available: false, error: 'timed out', windows: []});
        return GLib.SOURCE_REMOVE;
    });

    const request = JSON.stringify({
        type: 'control_request',
        request_id: 'gnome-claude-usage',
        request: {subtype: 'get_usage'},
    });
    proc.communicate_utf8_async(`${request}\n`, cancellable, (source, result) => {
        GLib.Source.remove(timeoutId);
        try {
            const [, stdout] = source.communicate_utf8_finish(result);
            for (const line of (stdout || '').split('\n')) {
                if (!line.includes('control_response'))
                    continue;
                const message = JSON.parse(line);
                const payload = message?.response?.response;
                if (payload)
                    return finish(shapeLive(payload));
            }
            finish({fetched: Date.now(), available: false, error: 'no usage in response', windows: []});
        } catch (e) {
            finish({fetched: Date.now(), available: false, error: `${e}`, windows: []});
        }
    });
}

function emptyBucket() {
    return {cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, tokens: 0, messages: 0};
}

function add(bucket, record, cost) {
    bucket.cost += cost;
    bucket.input += record.i;
    bucket.output += record.o;
    bucket.cacheWrite += record.w5 + record.w1;
    bucket.cacheRead += record.r;
    bucket.tokens += record.i + record.o + record.w5 + record.w1 + record.r;
    bucket.messages += 1;
}

function dayKey(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// Group records into 5-hour blocks the way Claude Code's own limits work: a
// block opens at the top of the hour of its first message and closes 5 hours
// later, and any gap of a full block also starts a fresh one.
function buildBlocks(records) {
    const blocks = [];
    let current = null;
    for (const record of records) {
        const startNew = !current ||
            record.t >= current.start + BLOCK_HOURS * HOUR ||
            record.t - current.lastActivity >= BLOCK_HOURS * HOUR;
        if (startNew) {
            current = {
                start: Math.floor(record.t / HOUR) * HOUR,
                lastActivity: record.t,
                totals: emptyBucket(),
            };
            current.end = current.start + BLOCK_HOURS * HOUR;
            blocks.push(current);
        }
        current.lastActivity = record.t;
        add(current.totals, record, record.cost);
    }
    return blocks;
}

function main() {
    // --live-max-age=<seconds>: reuse a cached plan-limit fetch that recent.
    // 0 forces a fresh call, which is what "Refresh now" and opening the menu do.
    let liveMaxAge = 30;
    for (const arg of ARGV) {
        const match = /^--live-max-age=(\d+)$/.exec(arg);
        if (match)
            liveMaxAge = Number(match[1]);
    }

    const now = Date.now();
    const cutoff = startOfLocalDay(now - WINDOW_DAYS * 24 * HOUR);
    const records = collectRecords(cutoff);

    const seen = new Set();
    const unique = [];
    let unpriced = 0;
    for (const record of records) {
        if (record.key !== '|' && seen.has(record.key))
            continue;
        seen.add(record.key);
        // "<synthetic>" entries are placeholders Claude Code writes itself
        // (errors, interruptions); they are not model calls, so skip them.
        if (String(record.model).startsWith('<'))
            continue;
        const price = priceFor(record.model);
        if (!price) {
            unpriced += 1;
            record.cost = 0;
        } else {
            record.cost = (record.i * price[0] + record.o * price[1] +
                record.w5 * price[2] + record.w1 * price[3] + record.r * price[4]) / 1e6;
        }
        unique.push(record);
    }

    const todayStart = startOfLocalDay(now);
    const weekStart = startOfLocalDay(now - 6 * 24 * HOUR);
    const today = emptyBucket();
    const week = emptyBucket();
    const days = new Map();
    const models = new Map();
    const projects = new Map();

    for (const record of unique) {
        const key = dayKey(record.t);
        if (!days.has(key))
            days.set(key, emptyBucket());
        add(days.get(key), record, record.cost);

        if (record.t >= weekStart)
            add(week, record, record.cost);
        if (record.t >= todayStart) {
            add(today, record, record.cost);
            const model = String(record.model).split('[')[0];
            if (!models.has(model))
                models.set(model, emptyBucket());
            add(models.get(model), record, record.cost);
            if (!projects.has(record.project))
                projects.set(record.project, emptyBucket());
            add(projects.get(record.project), record, record.cost);
        }
    }

    const blocks = buildBlocks(unique);
    const last = blocks.length ? blocks[blocks.length - 1] : null;
    let block = null;
    if (last && now < last.end) {
        const elapsedHours = Math.max((now - last.start) / HOUR, 1 / 60);
        block = {
            start: last.start,
            end: last.end,
            lastActivity: last.lastActivity,
            burnPerHour: last.totals.cost / elapsedHours,
            projected: last.totals.cost / elapsedHours * BLOCK_HOURS,
            totals: last.totals,
        };
    }

    const dayList = [];
    for (let i = 13; i >= 0; i--) {
        const ms = now - i * 24 * HOUR;
        const key = dayKey(ms);
        dayList.push({date: key, ...(days.get(key) || emptyBucket())});
    }

    const rank = map => [...map.entries()]
        .map(([name, totals]) => ({name, ...totals}))
        .sort((a, b) => b.cost - a.cost);

    const loop = new GLib.MainLoop(null, false);
    fetchLive(liveMaxAge * 1000, live => {
        print(JSON.stringify({
            generated: now,
            blockHours: BLOCK_HOURS,
            messages: unique.length,
            unpricedMessages: unpriced,
            live,
            block,
            today,
            week,
            days: dayList,
            models: rank(models),
            projects: rank(projects).slice(0, 5),
        }));
        loop.quit();
    });
    loop.run();
}

main();
