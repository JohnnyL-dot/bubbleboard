import { mount } from './ui/app.js';

// ?seed=123 fixerar slumpen (ordning och vänster/höger) i testbygge (TF-8).
const raw = new URLSearchParams(globalThis.location.search).get('seed');
const seed = raw !== null && raw !== '' && Number.isInteger(Number(raw)) ? Number(raw) : undefined;

mount(document.getElementById('app'), { seed });
