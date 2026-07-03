/**
 * Main browser entrypoint.
 *
 * This file should stay intentionally tiny — it's the first module the browser
 * loads after `<script type="module" src="...">` in index.html. Its only jobs
 * are importing global CSS and handing control to the bootstrap module.
 *
 * Everything else (DOM assembly, state management, mode transitions) lives
 * deeper in the module tree so this file never needs to grow.
 */

import './style.css';

import { bootstrapApp } from './app/bootstrap.ts';

// Hand off to the bootstrap module immediately.
bootstrapApp();
