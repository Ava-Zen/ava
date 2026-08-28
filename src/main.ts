import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { DebugConsole } from './app/debug/debug-console';
import { isDebugWindow } from './app/services/debug-log';

if (isDebugWindow()) {
  const root = document.querySelector('app-root');
  if (root) root.replaceWith(document.createElement('app-debug-console'));
  bootstrapApplication(DebugConsole, appConfig).catch(err => console.error(err));
} else {
  bootstrapApplication(App, appConfig).catch(err => console.error(err));
}
