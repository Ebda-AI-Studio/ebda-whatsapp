import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createSampleSource } from './data/sample';
import './styles.css';

// Live API wiring lands with sign-in (Task B3); until then the inbox runs on labelled sample data.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App source={createSampleSource()} />
  </StrictMode>,
);
