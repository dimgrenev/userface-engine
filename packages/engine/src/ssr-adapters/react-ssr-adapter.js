const React = require('react');
const ReactDOMServer = require('react-dom/server');
const { transpileToIIFE } = require('../transpiler');

class ReactSSRAdapter {
  async render(componentCode, props) {
    try {
      const iifeCode = await transpileToIIFE(componentCode, 'react');
      const component = eval(iifeCode);
      const element = React.createElement(component, props);
      const html = ReactDOMServer.renderToString(element);
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

module.exports = { ReactSSRAdapter };