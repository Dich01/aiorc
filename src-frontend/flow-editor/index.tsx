import React from 'react';
import { createRoot } from 'react-dom/client';
import FlowEditor from './FlowEditor';
import './styles.css';

const root = document.getElementById('flow-root');
if (root) {
  createRoot(root).render(<FlowEditor />);
}
