const Vue = require('vue');
const serverRenderer = require('@vue/server-renderer');
const { transpileToIIFE } = require('../transpiler');

class VueSSRAdapter {
  async render(componentCode, props) {
    try {
      const iifeCode = await transpileToIIFE(componentCode, 'vue');
      const component = eval(iifeCode);
      const app = Vue.createApp({ 
        render() {
          return Vue.h(component, props);
        }
      });
      const html = await serverRenderer.renderToString(app);
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

module.exports = { VueSSRAdapter };