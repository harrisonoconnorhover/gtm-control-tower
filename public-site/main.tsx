import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PublicDemo } from '@/components/public-demo';
import '@/app/globals.css';

const root = document.getElementById('root');

if (!root) throw new Error('The public site root is missing.');

createRoot(root).render(
  <StrictMode>
    <PublicDemo />
  </StrictMode>,
);
