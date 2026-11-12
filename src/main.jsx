import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/newsreader/latin-500.css';
import React from 'react';
import {createRoot} from 'react-dom/client';

const mode=import.meta.env.VITE_WIMBLO_APP_MODE||'legacy';
async function loadEntry(){
 if(mode==='production'){const {default:ProductionApp}=await import('./production/ProductionApp.jsx');return <ProductionApp mode="production"/>;}
 if(mode==='synthetic-evaluation'){
  const [{default:ProductionApp},{createSyntheticEvaluationClient}]=await Promise.all([import('./production/ProductionApp.jsx'),import('./production/syntheticEvaluationClient.js')]);
  return <ProductionApp mode="synthetic-evaluation" client={createSyntheticEvaluationClient()}/>;
 }
 if(mode!=='legacy')throw new Error(`Unsupported Wimblo application mode: ${mode}`);
 await Promise.all([import('./styles.css'),import('./wimblo.css'),import('./styles/messaging.css'),import('./styles/giving.css'),import('./styles/programs.css'),import('./styles/reporting-packs.css'),import('./styles/administration.css'),import('./styles/quality.css')]);
 const {default:App}=await import('./App.jsx');return <App/>;
}
loadEntry().then(element=>createRoot(document.getElementById('root')).render(element));
