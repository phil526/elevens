import './ui/styles.css';
import { App } from './app';

const app = new App();
// Automated browser tests read match state through this hook; it is only exposed on request.
if (new URLSearchParams(location.search).has('test')) (window as unknown as { __elevens: App }).__elevens = app;
