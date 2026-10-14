// Vercel build entry (see vercel.json).
//
// The demo sign-in is switched on by EXPO_PUBLIC_DEMO_EMAIL and EXPO_PUBLIC_DEMO_PASSWORD, which
// Vercel should define for the Preview environment only. This guard makes sure a production
// build never inlines them even if the variables are scoped wrongly, then runs the normal web
// export (app.json: web.output = "single", so dist/ is one index.html plus hashed assets).
import { spawnSync } from 'node:child_process';

if (process.env.VERCEL_ENV === 'production') {
  for (const key of ['EXPO_PUBLIC_DEMO_EMAIL', 'EXPO_PUBLIC_DEMO_PASSWORD']) {
    if (process.env[key]) console.log(`vercel-build: dropping ${key} from the production build`);
    delete process.env[key];
  }
}

const result = spawnSync('npx', ['expo', 'export', '--platform', 'web'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);
