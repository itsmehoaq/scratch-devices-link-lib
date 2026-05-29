const MAX_ENTRIES = 3000;

/** @type {Array<{ts: string, level: string, text: string}>} */
const entries = [];

/** @type {Set<(entry: {ts: string, level: string, text: string}) => void>} */
const listeners = new Set();

const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
};

/**
 * @param {unknown} value
 * @returns {string}
 */
const stringify = value => {
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
};

/**
 * @param {Array<unknown>} args
 * @returns {string}
 */
const formatArgs = args => args.map(stringify).join(' ');

/**
 * @param {string} level
 * @param {Array<unknown>} args
 */
const append = (level, args) => {
    const entry = {
        ts: new Date().toISOString(),
        level,
        text: formatArgs(args)
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
        entries.splice(0, entries.length - MAX_ENTRIES);
    }
    listeners.forEach(listener => {
        try {
            listener(entry);
        } catch (err) {
            originals.error('[log-buffer] listener failed:', err);
        }
    });
};

/**
 * Capture main-process console output for the in-app log window.
 */
const installLogCapture = () => {
    console.log = (...args) => {
        append('log', args);
        originals.log.apply(console, args);
    };
    console.info = (...args) => {
        append('info', args);
        originals.info.apply(console, args);
    };
    console.warn = (...args) => {
        append('warn', args);
        originals.warn.apply(console, args);
    };
    console.error = (...args) => {
        append('error', args);
        originals.error.apply(console, args);
    };
};

/**
 * @param {(entry: {ts: string, level: string, text: string}) => void} listener
 */
const subscribe = listener => {
    listeners.add(listener);
};

/**
 * @param {(entry: {ts: string, level: string, text: string}) => void} listener
 */
const unsubscribe = listener => {
    listeners.delete(listener);
};

const getEntries = () => entries.slice();

const clearEntries = () => {
    entries.length = 0;
};

module.exports = {
    installLogCapture,
    subscribe,
    unsubscribe,
    getEntries,
    clearEntries
};
