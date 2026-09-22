// Design tokens. The two palettes mirror the reference dashboard: "race" is light with a
// purple accent, "night" is dark with a green one.

export type ThemeName = 'race' | 'night';

export type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  ink: string;
  ink2: string;
  mut: string;
  hair: string;
  accent: string;
  accentSoft: string;
  accentLine: string;
  onAccent: string;
  blue: string;
  orange: string;
  aqua: string;
  aqua2: string;
  amber: string;
  pos: string;
  neg: string;
  negSoft: string;
};

export const palettes: Record<ThemeName, Palette> = {
  race: {
    bg: '#eef0f4',
    surface: '#ffffff',
    surface2: '#f5f4fa',
    surface3: '#ebe7f7',
    ink: '#1c1442',
    ink2: '#4a4468',
    mut: '#6f6a88',
    hair: 'rgba(28,20,66,0.10)',
    accent: '#4b33b3',
    accentSoft: 'rgba(75,51,179,0.10)',
    accentLine: 'rgba(75,51,179,0.30)',
    onAccent: '#ffffff',
    blue: '#4b33b3',
    orange: '#b92fc6',
    aqua: '#16a064',
    aqua2: '#0d8a52',
    amber: '#b7791f',
    pos: '#0a7c49',
    neg: '#c8323d',
    negSoft: 'rgba(200,50,61,0.10)',
  },
  night: {
    bg: '#0d0d0d',
    surface: '#1a1a19',
    surface2: '#222221',
    surface3: '#2a2a28',
    ink: '#ffffff',
    ink2: '#c3c2b7',
    mut: '#898781',
    hair: 'rgba(255,255,255,0.08)',
    accent: '#2bd894',
    accentSoft: 'rgba(43,216,148,0.14)',
    accentLine: 'rgba(43,216,148,0.35)',
    onAccent: '#0d0d0d',
    blue: '#3987e5',
    orange: '#d95926',
    aqua: '#199e70',
    aqua2: '#2bd894',
    amber: '#e0a33a',
    pos: '#2bd894',
    neg: '#e66767',
    negSoft: 'rgba(230,103,103,0.14)',
  },
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 18, pill: 999 } as const;
export const fontSize = { display: 34, h1: 24, h2: 18, h3: 16, body: 15, small: 13, tiny: 11 } as const;
