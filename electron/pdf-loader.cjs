// Native import stays in a CommonJS file so TypeScript does not rewrite PDF.js ESM to require().
module.exports = specifier => import(specifier);
