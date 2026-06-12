// client/tests/babel.config.js
// Jest transform için: ESM import/export → CommonJS, TypeScript sözdizimi desteği.
// Yalnızca test ortamında kullanılır — build sistemi etkilenmez.
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
    ['@babel/preset-typescript', { allowDeclareFields: true }],
  ],
};
