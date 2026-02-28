import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';

import './app/styles/index.css';

import { ErrorBoundary } from './app/components/ErrorBoundary';

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

