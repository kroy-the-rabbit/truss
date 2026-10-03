import { app, session, shell } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { pathToFileURL } from 'url';
import { AppUrlSpec, CONTENT_SECURITY_POLICY, isAppUrl, isExternalHttpUrl } from './urlPolicy';

let appUrlSpec: AppUrlSpec = {};

function openExternalIfHttp(url: string): void {
  if (isExternalHttpUrl(url)) {
    void shell.openExternal(url).catch((err) => console.warn('openExternal failed:', err));
  }
}

function guardWebContents(contents: WebContents): void {
  const onNavigate = (event: Electron.Event, url: string) => {
    if (isAppUrl(url, appUrlSpec)) return;
    event.preventDefault();
    console.warn(`Blocked navigation to ${url}`);
    openExternalIfHttp(url);
  };
  contents.on('will-navigate', onNavigate);
  contents.on('will-redirect', onNavigate);
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfHttp(url);
    return { action: 'deny' };
  });
}

/**
 * Lock down navigation, popups, webviews and (in packaged builds) add a CSP
 * response header. Must be called after app ready and before any window is created.
 */
export function installSecurityGuards(opts: {
  devServerUrl?: string;
  indexHtmlPath: string;
  partitions: string[];
}): void {
  appUrlSpec = opts.devServerUrl
    ? { devServerUrl: opts.devServerUrl }
    : { indexFileUrl: pathToFileURL(opts.indexHtmlPath).href };

  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));

  // file:// responses do pass through onHeadersReceived (verified on Electron 41),
  // so the CSP also applies to any page that is not our index.html. Skipped in dev
  // so the Vite dev server / HMR keeps working.
  if (!opts.devServerUrl) {
    const sessions = [session.defaultSession, ...opts.partitions.map((p) => session.fromPartition(p))];
    for (const ses of sessions) {
      ses.webRequest.onHeadersReceived((details, callback) => {
        if (!details.url.startsWith('file:')) {
          callback({});
          return;
        }
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
          },
        });
      });
    }
  }
}

export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return isAppUrl(event.senderFrame?.url, appUrlSpec);
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) {
    throw new Error('Forbidden IPC sender');
  }
}
