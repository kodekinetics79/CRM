import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './styles.css';
import './wimblo.css';
createRoot(document.getElementById('root')).render(<App/>);
