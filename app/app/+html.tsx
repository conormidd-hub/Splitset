import { ScrollViewStyleReset } from 'expo-router/html';
import type { ReactNode } from 'react';

// Web-only: the HTML shell around the app. Backgrounds match the two palettes in
// src/theme/tokens.ts so nothing flashes white in dark mode before React mounts.
export default function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <title>Splitset</title>
        {/* the Splitset logo for the browser tab, the home screen and installs */}
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
body { background-color: #eef0f4; }
@media (prefers-color-scheme: dark) {
  body { background-color: #0d0d0d; }
}`;
