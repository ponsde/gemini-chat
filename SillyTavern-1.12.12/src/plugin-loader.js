import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import express from 'express';
import { default as git } from 'simple-git';
import { sync as commandExistsSync } from 'command-exists';
import { getConfigValue, color } from './util.js';

const enableServerPlugins = !!getConfigValue('enableServerPlugins', false);
const enableServerPluginsAutoUpdate = !!getConfigValue('enableServerPluginsAutoUpdate', true);

/**
 * Map of loaded plugins.
 * @type {Map<string, any>}
 */
const loadedPlugins = new Map();

/**
 * Determine if a file is a CommonJS module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is a CommonJS module
 */
const isCommonJS = (file) => path.extname(file) === '.js' || path.extname(file) === '.cjs';

/**
 * Determine if a file is an ECMAScript module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is an ECMAScript module
 */
const isESModule = (file) => path.extname(file) === '.mjs';

/**
 * Load and initialize server plugins from a directory if they are enabled.
 * @param {import('express').Express} app Express app
 * @param {string} pluginsPath Path to plugins directory
 * @returns {Promise<Function>} Promise that resolves when all plugins are loaded. Resolves to a "cleanup" function to
 * be called before the server shuts down.
 */
export async function loadPlugins(app, pluginsPath) {
    const exitHooks = [];
    const emptyFn = () => { };

    // Server plugins are disabled.
    if (!enableServerPlugins) {
        return emptyFn;
    }

    // Plugins directory does not exist.
    if (!fs.existsSync(pluginsPath)) {
        return emptyFn;
    }

    const files = fs.readdirSync(pluginsPath);

    // No plugins to load.
    if (files.length === 0) {
        return emptyFn;
    }

    await updatePlugins(pluginsPath);

    for (const file of files) {
        const pluginFilePath = path.join(pluginsPath, file);

        if (fs.statSync(pluginFilePath).isDirectory()) {
            await loadFromDirectory(app, pluginFilePath, exitHooks);
            continue;
        }

        // Not a JavaScript file.
        if (!isCommonJS(file) && !isESModule(file)) {
            continue;
        }

        await loadFromFile(app, pluginFilePath, exitHooks);
    }

    if (loadedPlugins.size > 0) {
        console.log(`${loadedPlugins.size} server plugin(s) are currently loaded. Make sure you know exactly what they do, and only install plugins from trusted sources!`);
    }

    // Call all plugin "exit" functions at once and wait for them to finish
    return () => Promise.all(exitHooks.map(exitFn => exitFn()));
}

async function loadFromDirectory(app, pluginDirectoryPath, exitHooks) {
    const files = fs.readdirSync(pluginDirectoryPath);

    // No plugins to load.
    if (files.length === 0) {
        return;
    }

    // Plugin is an npm package.
    const packageJsonFilePath = path.join(pluginDirectoryPath, 'package.json');
    if (fs.existsSync(packageJsonFilePath)) {
        if (await loadFromPackage(app, packageJsonFilePath, exitHooks)) {
            return;
        }
    }

    // Plugin is a module file.
    const fileTypes = ['index.js', 'index.cjs', 'index.mjs'];

    for (const fileType of fileTypes) {
        const filePath = path.join(pluginDirectoryPath, fileType);
        if (fs.existsSync(filePath)) {
            if (await loadFromFile(app, filePath, exitHooks)) {
                return;
            }
        }
    }
}

/**
 * Loads and initializes a plugin from an npm package.
 * @param {import('express').Express} app Express app
 * @param {string} packageJsonPath Path to package.json file
 * @param {Array<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromPackage(app, packageJsonPath, exitHooks) {
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.main) {
            const pluginFilePath = path.join(path.dirname(packageJsonPath), packageJson.main);
            return await loadFromFile(app, pluginFilePath, exitHooks);
        }
    } catch (error) {
        console.error(`Failed to load plugin from ${packageJsonPath}: ${error}`);
    }
    return false;
}

/**
 * Loads and initializes a plugin from a file.
 * @param {import('express').Express} app Express app
 * @param {string} pluginFilePath Path to plugin directory
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromFile(app, pluginFilePath, exitHooks) {
    try {
        const fileUrl = url.pathToFileURL(pluginFilePath).toString();
        const plugin = await import(fileUrl);
        console.log(`Initializing plugin from ${pluginFilePath}`);
        return await initPlugin(app, plugin, exitHooks);
    } catch (error) {
        console.error(`Failed to load plugin from ${pluginFilePath}: ${error}`);
        return false;
    }
}

/**
 * Check whether a plugin ID is valid (only lowercase alphanumeric, hyphens, and underscores).
 * @param {string} id The plugin ID to check
 * @returns {boolean} True if the plugin ID is valid.
 */
function isValidPluginID(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Initializes a plugin module.
 * @param {import('express').Express} app Express app
 * @param {any} plugin Plugin module
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was initialized successfully
 */
async function initPlugin(app, plugin, exitHooks) {
    const info = plugin.info || plugin.default?.info;
    if (typeof info !== 'object') {
        console.error('Failed to load plugin module; plugin info not found');
        return false;
    }

    // We don't currently use "name" or "description" but it would be nice to have a UI for listing server plugins, so
    // require them now just to be safe
    for (const field of ['id', 'name', 'description']) {
        if (typeof info[field] !== 'string') {
            console.error(`Failed to load plugin module; plugin info missing field '${field}'`);
            return false;
        }
    }

    const init = plugin.init || plugin.default?.init;
    if (typeof init !== 'function') {
        console.error('Failed to load plugin module; no init function');
        return false;
    }

    const { id } = info;

    if (!isValidPluginID(id)) {
        console.error(`Failed to load plugin module; invalid plugin ID '${id}'`);
        return false;
    }

    if (loadedPlugins.has(id)) {
        console.error(`Failed to load plugin module; plugin ID '${id}' is already in use`);
        return false;
    }

    // Allow the plugin to register API routes under /api/plugins/[plugin ID] via a router
    const router = express.Router();

    await init(router);

    loadedPlugins.set(id, plugin);

    // Add API routes to the app if the plugin registered any
    if (router.stack.length > 0) {
        app.use(`/api/plugins/${id}`, router);
    }

    const exit = plugin.exit || plugin.default?.exit;
    if (typeof exit === 'function') {
        exitHooks.push(exit);
    }

    return true;
}

/**
 * Automatically update all git plugins in the ./plugins directory
 * @param {string} pluginsPath Path to plugins directory
 */
async function updatePlugins(pluginsPath) {
    if (!enableServerPluginsAutoUpdate) {
        return;
    }

    const directories = fs.readdirSync(pluginsPath)
        .filter(file => !file.startsWith('.'))
        .filter(file => fs.statSync(path.join(pluginsPath, file)).isDirectory());

    if (directories.length === 0) {
        return;
    }

    console.log(color.blue('Auto-updating server plugins... Set'), color.yellow('enableServerPluginsAutoUpdate: false'), color.blue('in config.yaml to disable this feature.'));

    if (!commandExistsSync('git')) {
        console.error(color.red('Git is not installed. Please install Git to enable auto-updating of server plugins.'));
        return;
    }

    let pluginsToUpdate = 0;

    for (const directory of directories) {
        try {
            const pluginPath = path.join(pluginsPath, directory);
            const pluginRepo = git(pluginPath);

            const isRepo = await pluginRepo.checkIsRepo();
            if (!isRepo) {
                continue;
            }

            await pluginRepo.fetch();
            const commitHash = await pluginRepo.revparse(['HEAD']);
            const trackingBranch = await pluginRepo.revparse(['--abbrev-ref', '@{u}']);
            const log = await pluginRepo.log({
                from: commitHash,
                to: trackingBranch,
            });

            if (log.total === 0) {
                continue;
            }

            pluginsToUpdate++;
            await pluginRepo.pull();
            const latestCommit = await pluginRepo.revparse(['HEAD']);
            console.log(`Plugin ${color.green(directory)} updated to commit ${color.cyan(latestCommit)}`);
        } catch (error) {
            console.error(color.red(`Failed to update plugin ${directory}: ${error.message}`));
        }
    }

    if (pluginsToUpdate === 0) {
        console.log('All plugins are up to date.');
    }
}
