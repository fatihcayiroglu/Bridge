// babel.config.js — sadece Jest / babel-jest için (.js test dosyaları)
// TypeScript dosyaları ts-jest tarafından derleniyor, bu config'e ihtiyaçları yok.
module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
  ],
};
