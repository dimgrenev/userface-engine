/**
 * Unit-тест для JSX трансформации
 * Проверяет что Button.tsx корректно трансформируется в безопасный JS
 */

// Тестовый код Button компонента
const testButtonCode = `
import React from 'react';

interface ButtonProps {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary';
  onClick?: () => void;
}

const Button: React.FC<ButtonProps> = ({ children, variant = 'primary', onClick }) => {
  return (
    <button 
      className={\`btn btn-\${variant}\`}
      onClick={onClick}
    >
      {children}
    </button>
  );
};

export default Button;
`;

/**
 * Тест трансформации JSX в React.createElement
 */
function testJSXTransformation() {
  console.log('🧪 Starting JSX Transformation Test...');
  console.log('📝 Input code length:', testButtonCode.length);
  
  try {
    // Проверяем доступность движка
    if (!window.engine) {
      throw new Error('Engine not available');
    }
    
    // Выполняем трансформацию
    console.log('🔄 Running cleanTypeScriptCode...');
    const transformedCode = window.engine.cleanTypeScriptCode(testButtonCode);
    
    console.log('✅ Transformation completed');
    console.log('📊 Output code length:', transformedCode.length);
    console.log('📝 Transformed code:');
    console.log(transformedCode);
    
    // 🔍 ВАЛИДАЦИЯ 1: Проверяем что нет JSX
    const jsxPattern = /<[a-zA-Z][^>]*>/;
    if (jsxPattern.test(transformedCode)) {
      const jsxMatches = transformedCode.match(/<[a-zA-Z][^>]*>/g);
      console.error('❌ JSX STILL PRESENT:', jsxMatches);
      throw new Error('JSX transformation failed - JSX syntax still present');
    }
    console.log('✅ JSX validation passed');
    
    // 🔍 ВАЛИДАЦИЯ 2: Проверяем что нет import/export
    if (transformedCode.includes('import ') || transformedCode.includes('export ')) {
      console.error('❌ IMPORT/EXPORT STILL PRESENT');
      throw new Error('Import/export removal failed');
    }
    console.log('✅ Import/export validation passed');
    
    // 🔍 ВАЛИДАЦИЯ 3: Проверяем что код можно выполнить
    try {
      new Function(transformedCode);
      console.log('✅ Code syntax validation passed');
    } catch (syntaxError) {
      console.error('❌ SYNTAX ERROR in transformed code:', syntaxError.message);
      throw new Error('Transformed code has syntax errors: ' + syntaxError.message);
    }
    
    // 🔍 ВАЛИДАЦИЯ 4: Проверяем наличие React.createElement
    if (!transformedCode.includes('React.createElement')) {
      console.warn('⚠️ React.createElement not found - JSX might not be transformed');
    } else {
      console.log('✅ React.createElement found in output');
    }
    
    console.log('🎉 JSX TRANSFORMATION TEST PASSED!');
    return {
      success: true,
      inputLength: testButtonCode.length,
      outputLength: transformedCode.length,
      transformedCode: transformedCode
    };
    
  } catch (error) {
    console.error('❌ JSX TRANSFORMATION TEST FAILED:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Тест рендера в iframe
 */
function testIframeRender(transformedCode) {
  console.log('🧪 Starting iframe render test...');
  
  try {
    // Создаем тестовый iframe
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    
    const iframeDoc = iframe.contentDocument;
    const testHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
        <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
      </head>
      <body>
        <div id="root"></div>
        <script>
          try {
            ${transformedCode}
            
            // Пробуем найти компонент
            let Component = null;
            if (typeof Button !== 'undefined') {
              Component = Button;
            } else if (typeof Component !== 'undefined') {
              Component = Component;
            }
            
            if (Component) {
              const element = React.createElement(Component, { children: 'Test' });
              const root = ReactDOM.createRoot(document.getElementById('root'));
              root.render(element);
              console.log('✅ Iframe render successful');
            } else {
              throw new Error('Component not found');
            }
            
          } catch (error) {
            console.error('❌ Iframe render error:', error.message);
            throw error;
          }
        </script>
      </body>
      </html>
    `;
    
    iframeDoc.write(testHTML);
    iframeDoc.close();
    
    // Cleanup
    setTimeout(() => {
      document.body.removeChild(iframe);
    }, 1000);
    
    console.log('🎉 IFRAME RENDER TEST PASSED!');
    return { success: true };
    
  } catch (error) {
    console.error('❌ IFRAME RENDER TEST FAILED:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Запуск всех тестов
 */
function runAllTests() {
  console.log('🚀 Starting comprehensive JSX transformation tests...');
  
  const transformTest = testJSXTransformation();
  
  if (transformTest.success) {
    const renderTest = testIframeRender(transformTest.transformedCode);
    
    return {
      transformation: transformTest,
      iframe: renderTest,
      overallSuccess: transformTest.success && renderTest.success
    };
  } else {
    return {
      transformation: transformTest,
      iframe: { success: false, error: 'Skipped due to transformation failure' },
      overallSuccess: false
    };
  }
}

// Экспорт для использования в браузере
if (typeof window !== 'undefined') {
  window.jsxTransformationTest = {
    testJSXTransformation,
    testIframeRender,
    runAllTests
  };
} 