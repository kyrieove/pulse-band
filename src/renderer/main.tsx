import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

console.log('>>> [CodeIsland Renderer] main.tsx running, mounting React App...');

const rootEl = document.getElementById('root');
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
  console.log('>>> [CodeIsland Renderer] React App mounted successfully.');
} else {
  console.error('>>> [CodeIsland Renderer] Could not find #root element in DOM!');
}
