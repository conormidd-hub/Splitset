// https://docs.expo.dev/guides/customizing-metro/
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The recovery map's constants live in data/ at the repo root, shared with the seed scripts and
// the reference model (src/lib/recovery/constants.ts imports them). Metro only resolves files
// inside its watch folders.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../data')];

module.exports = config;
