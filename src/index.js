const React = require('react');
const ReactDOM = require('react-dom/client');
const App = require('./App');

window.addEventListener('DOMContentLoaded', () => {
  const root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(React.createElement(App));
});