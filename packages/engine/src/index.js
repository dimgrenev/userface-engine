/**
 * Engine Index - основной экспорт
 */

// Экспортируем UserfaceEngine
export { UserfaceEngine } from './userface-engine.js';

// Также экспортируем для CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = require('./userface-engine.js');
} 