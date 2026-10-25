const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  // Only framework-independent core is outside this application's dependency tree.
  watchFolders: [path.resolve(__dirname, '../../packages/core')],
  resolver: { nodeModulesPaths: [path.resolve(__dirname, 'node_modules')] },
});
