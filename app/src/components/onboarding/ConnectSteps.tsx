import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';

import { Numbered, Prose } from './Prose';
import { StepCard } from './StepCard';
import { useConnectIntervals, useConnection, useVerifyConnection, type VerifiedAthlete, type VerifyState } from '@/api/connections';
import { useProfile, useUpdateProfile, type ProfilePatch } from '@/api/profile';
import { useSyncNow } from '@/api/sync';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Chip';
import { ErrorBanner, errorMessage } from '@/components/ui/States';
import { T } from '@/components/ui/T';
import { TextField } from '@/components/ui/TextField';
import { daysAgoIso } from '@/lib/dates';
import { INTERVALS_SETTINGS, INTERVALS_SIGNUP, openExternal } from '@/lib/openExternal';
import { useUserId } from '@/lib/session';
import { connectProgressKey, storage } from '@/lib/storage';
import { useTheme } from '@/theme/ThemeProvider';
import { space } from '@/theme/tokens';

type Props = {
  /** `welcome` is the first-run wizard; `settings` the same steps reached later from Settings. */
  mode: 'welcome' | 'settings';
  onDone: () => void;
};

type StepId = 'account' | 'signup' | 'garmin' | 'key' | 'sync';
type History = 'year' | 'two' | 'all';

const ALL_STEPS: StepId[] = ['account', 'signup', 'garmin', 'key', 'sync'];

const TITLES: Record<StepId, string> = {
  account: 'Do you use intervals.icu already?',
  signup: 'Create an intervals.icu account',
  garmin: 'Connect your Garmin to intervals.icu',
  key: 'Paste your API key',
  sync: 'Pull your data in',
};

const GARMIN_STEPS = [
  'Find **Garmin** under Connections and tick it. A Garmin window opens: sign in and allow (if it offers historical data, say yes).',
  'Back in intervals.icu, tick **Download wellness data** and the fields it lists (resting HR, HRV, sleep, steps…).',
  'Press **Download old data**, and **Download old wellness data** if you see it, to pull in your history. Garmin sends up to a year and it can take a while; new days arrive on their own from now on.',
];

/** The first backfill starts here. Garmin itself only hands intervals.icu a year, so "Everything" is for older intervals.icu history. */
const OLDEST: Record<History, () => string> = {
  year: () => daysAgoIso(365),
  two: () => daysAgoIso(730),
  all: () => '2015-01-01',
};

const NO_ATHLETE = "intervals.icu accepted the key but didn't say whose it is. Type your athlete ID below: it is near the top of your intervals.icu settings page and looks like i123456.";

// Where the person got to, kept on the device: a phone that reloads the app while they are off
// in intervals.icu or Garmin's sign-in should bring them back to the same step, not step one.
type Progress = { step: StepId; hasAccount: boolean | null; done: StepId[] };
const progressKey = connectProgressKey;
const isStep = (v: unknown): v is StepId => typeof v === 'string' && (ALL_STEPS as string[]).includes(v);

function parseProgress(json: string | null): Progress | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<Progress>;
    if (!isStep(o.step) || !Array.isArray(o.done)) return null;
    return { step: o.step, hasAccount: typeof o.hasAccount === 'boolean' ? o.hasAccount : null, done: o.done.filter(isStep) };
  } catch {
    return null;
  }
}

/** The year in "1990-01-01", when it is one a person could have been born in. */
function birthYearOf(dateOfBirth: string | null): number | null {
  const y = dateOfBirth ? parseInt(dateOfBirth.slice(0, 4), 10) : NaN;
  return y > 1900 && y <= new Date().getFullYear() ? y : null;
}

/**
 * Garmin → intervals.icu → Splitset, as a stepper a friend can follow without knowing what an
 * API is: each hop out to another site is one button, and the only thing they ever paste is the
 * key. The check of that key brings back who they are over there, so the athlete id, time zone,
 * sex and birth year are filled in for them rather than asked for.
 */
export function ConnectSteps({ mode, onDone }: Props) {
  const { palette } = useTheme();
  const uid = useUserId();
  const profile = useProfile();
  const connection = useConnection();
  const verify = useVerifyConnection();
  const connect = useConnectIntervals();
  const fill = useUpdateProfile();
  const tzUpdate = useUpdateProfile();
  const sync = useSyncNow();

  // ---------------------------------------------------------------- the stepper
  const [{ step, done }, setProgress] = useState<{ step: StepId; done: StepId[] }>({ step: 'account', done: [] });
  const setStep = (next: StepId) => setProgress((p) => ({ ...p, step: next }));
  const [hasAccount, setHasAccount] = useState<boolean | null>(null);
  // someone with an account skips the sign-up step; the numbers close up around it
  const steps = hasAccount === true ? ALL_STEPS.filter((s) => s !== 'signup') : ALL_STEPS;

  const [restored, setRestored] = useState(false);
  const connectionKnown = connection.isSuccess || connection.isError;
  const connectedNow = connection.data?.status === 'active';
  useEffect(() => {
    if (!connectionKnown) return;
    let mounted = true;
    storage.getItem(progressKey(uid))
      .then((v) => {
        if (!mounted) return;
        const p = parseProgress(v);
        if (p) {
          // a connect remembered here but gone from the server (a disconnect since) reopens the key step
          const done = connectedNow ? p.done : p.done.filter((s) => s !== 'key' && s !== 'sync');
          setProgress({ step: !connectedNow && p.step === 'sync' ? 'key' : p.step, done });
          setHasAccount(p.hasAccount);
        }
        setRestored(true);
      })
      .catch(() => { if (mounted) setRestored(true); });
    return () => { mounted = false; };
    // the restore happens once the connection is known, not again when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, connectionKnown]);
  useEffect(() => {
    if (!restored) return;
    storage.setItem(progressKey(uid), JSON.stringify({ step, hasAccount, done } satisfies Progress)).catch(() => {});
  }, [restored, uid, step, hasAccount, done]);

  const finish = () => {
    storage.removeItem(progressKey(uid)).catch(() => {});
    onDone();
  };

  /** Mark a step finished and open the next one that isn't. */
  const advance = (from: StepId, order: StepId[] = steps) => {
    setProgress((p) => {
      const nextDone = p.done.includes(from) ? p.done : [...p.done, from];
      const after = order.slice(order.indexOf(from) + 1);
      return { done: nextDone, step: after.find((s) => !nextDone.includes(s)) ?? after[0] ?? from };
    });
  };
  const stateOf = (id: StepId) => (id === step ? 'open' : done.includes(id) ? 'done' : 'todo');

  const chooseAccount = (yes: boolean) => {
    setHasAccount(yes);
    advance('account', yes ? ALL_STEPS.filter((s) => s !== 'signup') : ALL_STEPS);
  };

  // ---------------------------------------------------------------- the key
  const [apiKey, setApiKey] = useState('');
  const [history, setHistory] = useState<History>('two');
  const [advanced, setAdvanced] = useState(false);
  const [typedId, setTypedId] = useState('');

  // where the check and the connect have got to, read off the two hooks rather than kept twice
  const checking = verify.state.state === 'sending' || verify.state.state === 'pending';
  const verified = verify.state.state === 'ok' ? verify.state.athlete : null;
  const connecting = connect.isPending;
  const athleteId = connect.isSuccess ? connect.variables?.athleteId ?? null : null;
  // intervals.icu named no athlete and the person hasn't typed one: the Advanced field opens itself
  const noAthlete = !!verified && !verified.athleteId && !typedId.trim();
  const failure = noAthlete && !connecting && !connect.isSuccess
    ? NO_ATHLETE
    : verify.state.state === 'failed'
      ? verify.state.message
      : connect.error ? errorMessage(connect.error) : null;

  const canPaste = Platform.OS === 'web' && typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;
  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) setApiKey(text);
    } catch {
      // the browser said no; typing it in works the same
    }
  };

  const check = () => {
    const key = apiKey.trim();
    if (!key || checking || connecting) return;
    connect.reset();
    void verify.start(key);
  };

  // the check's answer: an athlete to connect as, and what intervals.icu knows about them
  const onVerified = useEffectEvent((a: VerifiedAthlete) => {
    // what they told intervals.icu about themselves saves asking again, where it is still blank
    const p = profile.data;
    if (p) {
      const patch: ProfilePatch = {};
      const year = birthYearOf(a.dateOfBirth);
      if (p.birth_year == null && year) patch.birth_year = year;
      if (p.sex == null && a.sex) patch.sex = a.sex;
      if (Object.keys(patch).length) fill.mutate(patch);
    }
    const id = (a.athleteId ?? typedId.trim()) || null;
    if (!id) return;
    const order = steps;
    connect.mutate(
      { athleteId: id, apiKey: apiKey.trim(), oldest: OLDEST[history]() },
      { onSuccess: () => advance('key', order) },
    );
  });
  // each answer is acted on once, however many times the effect runs
  const handled = useRef<VerifyState | null>(null);
  useEffect(() => {
    const s = verify.state;
    if (s.state !== 'ok' || handled.current === s) return;
    handled.current = s;
    onVerified(s.athlete);
  }, [verify.state]);

  // ---------------------------------------------------------------- the first sync
  const syncStarted = useRef(false);
  const startSync = sync.start;
  useEffect(() => {
    if (step !== 'sync' || syncStarted.current) return;
    syncStarted.current = true;
    void startSync();
  }, [step, startSync]);

  const syncBusy = sync.phase === 'starting' || sync.phase === 'waiting' || sync.phase === 'running';
  const notConfigured = !!sync.message && /GitHub token/.test(sync.message);
  const syncLine = sync.phase === 'starting'
    ? 'Starting a sync…'
    : sync.phase === 'waiting' || sync.phase === 'running'
      ? 'Syncing… the first one brings in your history, so give it a minute.'
      : sync.phase === 'done'
        ? sync.message ?? 'Synced.'
        : sync.phase === 'failed'
          ? 'The first sync did not finish. Your data arrives at the next scheduled sync, twice a day.'
          : notConfigured || !sync.message
            ? 'Your data arrives at the next scheduled sync, twice a day.'
            : sync.message;

  const tz = verified?.timezone && profile.data && verified.timezone !== profile.data.timezone ? verified.timezone : null;
  const wellnessOff = verified ? verified.garminHealth === false || verified.garminWellness === false : false;

  const n = (id: StepId) => steps.indexOf(id) + 1;

  return (
    <View style={{ gap: space.md }}>
      <StepCard
        n={n('account')}
        title={TITLES.account}
        state={stateOf('account')}
        summary={hasAccount ? 'You already use intervals.icu' : 'A new intervals.icu account'}
        onOpen={() => setStep('account')}>
        <Button title="Yes, I have an account" onPress={() => chooseAccount(true)} />
        <Button title="No, set one up" variant="secondary" onPress={() => chooseAccount(false)} />
        <T variant="small" tone="mut">
          intervals.icu is a free training site. It is how your watch&apos;s data reaches Splitset: Garmin → intervals.icu → here.
        </T>
      </StepCard>

      {steps.includes('signup') ? (
        <StepCard n={n('signup')} title={TITLES.signup} state={stateOf('signup')} summary="Account created" onOpen={() => setStep('signup')}>
          <Button title="Open intervals.icu sign-up" variant="secondary" onPress={() => openExternal(INTERVALS_SIGNUP)} />
          <Prose text="Sign up with your email (or Strava), then come back here." />
          <Button title="Done, next" onPress={() => advance('signup')} />
        </StepCard>
      ) : null}

      <StepCard n={n('garmin')} title={TITLES.garmin} state={stateOf('garmin')} summary="Garmin is connected to intervals.icu" onOpen={() => setStep('garmin')}>
        <Button title="Open intervals.icu settings" variant="secondary" onPress={() => openExternal(INTERVALS_SETTINGS)} />
        <Numbered items={GARMIN_STEPS} />
        <Button title="Garmin is connected" onPress={() => advance('garmin')} />
      </StepCard>

      <StepCard
        n={n('key')}
        title={TITLES.key}
        state={stateOf('key')}
        summary={athleteId ? `Connected as ${verified?.name ?? 'you'} (${athleteId})` : 'Connected to intervals.icu'}
        onOpen={() => setStep('key')}>
        <Prose text="At the very bottom of the same settings page, under **Developer Settings**, press **Generate** if there is no key yet, then copy it." />
        <Button title="Open intervals.icu settings" variant="secondary" small onPress={() => openExternal(INTERVALS_SETTINGS)} />
        <View style={{ gap: space.xs }}>
          <TextField
            label="API key"
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="paste your key"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!checking && !connecting}
            returnKeyType="done"
            onSubmitEditing={check}
          />
          {canPaste ? <Button title="Paste" variant="ghost" small onPress={() => { void paste(); }} style={{ alignSelf: 'flex-start' }} /> : null}
        </View>
        <View style={{ gap: space.xs }}>
          <T variant="label" tone="mut">How far back</T>
          <Segmented<History>
            options={[{ value: 'year', label: 'Last year' }, { value: 'two', label: '2 years' }, { value: 'all', label: 'Everything' }]}
            value={history}
            onChange={setHistory}
          />
          <T variant="small" tone="mut">How much of your history to bring in. More takes longer the first time.</T>
        </View>
        {advanced || noAthlete ? (
          <TextField
            label="Athlete ID (optional)"
            value={typedId}
            onChangeText={setTypedId}
            placeholder="i123456"
            autoCapitalize="none"
            autoCorrect={false}
            hint="Only needed if the check can't tell whose key it is. It is near the top of your intervals.icu settings page."
          />
        ) : (
          <Button title="Advanced" variant="ghost" small onPress={() => setAdvanced(true)} style={{ alignSelf: 'flex-start' }} />
        )}
        <Button title="Check and connect" onPress={check} loading={checking || connecting} disabled={!apiKey.trim()} />
        {checking || connecting ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <ActivityIndicator size="small" color={palette.mut} />
            <T variant="small" tone="mut">{checking ? 'Checking with intervals.icu…' : 'Saving your connection…'}</T>
          </View>
        ) : null}
        <ErrorBanner message={failure} />
      </StepCard>

      <StepCard n={n('sync')} title={TITLES.sync} state={stateOf('sync')}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          {syncBusy ? <ActivityIndicator size="small" color={palette.mut} /> : null}
          <T tone={sync.phase === 'failed' ? 'neg' : sync.phase === 'done' ? 'pos' : 'ink2'} style={{ flex: 1 }}>{syncLine}</T>
        </View>
        {sync.phase === 'failed' && sync.message ? <T variant="tiny" tone="mut">{sync.message}</T> : null}

        {tz ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' }}>
            <T variant="small" tone="ink2" style={{ flex: 1 }}>intervals.icu has you in {tz}</T>
            <Button title="Use it" variant="secondary" small loading={tzUpdate.isPending} onPress={() => tzUpdate.mutate({ timezone: tz })} />
          </View>
        ) : null}
        {wellnessOff ? (
          <Card tone="accent">
            <View style={{ gap: space.sm }}>
              <T variant="h3">{verified?.garminHealth === false ? 'intervals.icu does not see a Garmin yet' : 'Garmin wellness is off in intervals.icu'}</T>
              <Prose
                text={verified?.garminHealth === false
                  ? 'Resting HR, HRV and sleep will not arrive until Garmin is ticked under Connections there, with **Download wellness data** switched on.'
                  : 'Resting HR, HRV and sleep will not arrive until you tick **Download wellness data** under Garmin there.'}
              />
              <Button title="Open intervals.icu settings" variant="secondary" small onPress={() => openExternal(INTERVALS_SETTINGS)} />
            </View>
          </Card>
        ) : null}
        <T variant="small" tone="mut">
          From now on new days come in on their own, twice a day. Sync now on the home screen fetches them sooner.
        </T>
        <Button title={mode === 'welcome' ? 'Go to my home screen' : 'Done'} onPress={finish} />
      </StepCard>
    </View>
  );
}
