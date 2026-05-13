const svelte = require('svelte/compiler');
const { transpileToIIFE } = require('../transpiler');

class SvelteSSRAdapter {
  async render(componentCode, props) {
    try {
      const iifeCode = await transpileToIIFE(componentCode, 'svelte');
      const component = eval(iifeCode);
      const { html } = component.render(props);
      return {
        html,
        success: true,
      };
    } catch (error) {
      return {
        error: error.message,
        success: false,
      };
    }
  }
}

module.exports = { SvelteSSRAdapter };